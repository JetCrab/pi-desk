import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function readClientPackage(platform, directory) {
  assert.ok(['windows', 'android'].includes(platform), '未知客户端平台')
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  assert.match(release.version, /^\d+\.\d+\.\d+$/)
  assert.match(release.sha256, /^[a-f0-9]{64}$/)
  const filename =
    platform === 'windows'
      ? `pi-desk-windows-${release.version}-x86-setup.exe`
      : `pi-desk-android-${release.version}.apk`
  const path = join(directory, filename)
  assert.equal(
    createHash('sha256')
      .update(await readFile(path))
      .digest('hex'),
    release.sha256,
    '安装包与校验摘要不一致'
  )
  return { ...release, filename, path }
}

function quote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

export const remotePublishScript = `set -euo pipefail
root=$1
platform=$2
filename=$3
hash=$4
base_url=$5
host=$6
run_id=$7
target="pi-desk-$platform"
stage="$root/staging/$target/$run_id"
directory="$root/data/$target"
ext=exe
[[ "$platform" == android ]] && ext=apk
latest="$directory/latest.$ext"
previous="$stage/previous-latest"
incoming="$directory/.latest-$run_id.$ext"
changed=false
finish() {
  result=$?
  trap - EXIT
  if (( result != 0 )) && [[ "$changed" == true ]]; then
    if [[ -f "$previous" ]]; then cp -- "$previous" "$incoming" && mv -f -- "$incoming" "$latest"; else rm -f -- "$latest"; fi
  fi
  rm -f -- "$incoming" "$directory/.incoming-$filename"
  rm -rf -- "$stage"
  exit "$result"
}
trap finish EXIT
[[ "$(sha256sum "$stage/$filename" | cut -d ' ' -f 1)" == "$hash" ]]
mkdir -p "$directory"
if [[ -f "$directory/$filename" ]]; then
  [[ "$(sha256sum "$directory/$filename" | cut -d ' ' -f 1)" == "$hash" ]] || { echo '同版本已有不同内容，拒绝覆盖' >&2; exit 1; }
else
  cp -- "$stage/$filename" "$directory/.incoming-$filename"
  mv -- "$directory/.incoming-$filename" "$directory/$filename"
fi
fetch_and_check() {
  local url=$1 deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if curl --http1.1 --fail --silent --show-error --max-time 10 --resolve "$host:443:127.0.0.1" "$url" -o "$stage/probe"; then
      if [[ "$(sha256sum "$stage/probe" | cut -d ' ' -f 1)" == "$hash" ]]; then return 0; fi
    fi
    sleep 1
  done
  echo '下载校验失败' >&2
  return 1
}
fetch_and_check "$base_url/$target/$filename"
if [[ -f "$latest" ]]; then cp -p -- "$latest" "$previous"; fi
changed=true
cp -- "$directory/$filename" "$incoming"
mv -f -- "$incoming" "$latest"
fetch_and_check "$base_url/$target/latest.$ext"
code=$(curl --http1.1 --fail --silent --show-error --max-time 15 --resolve "$host:443:127.0.0.1" --range 0-31 -o "$stage/range" --write-out '%{http_code}' "$base_url/$target/latest.$ext")
[[ "$code" == 206 && "$(wc -c < "$stage/range")" == 32 ]]
python3 - "$directory" "$filename" "$platform" <<'PY'
import re, sys
from pathlib import Path
root, current, platform = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
pattern = r'pi-desk-windows-\\d+\\.\\d+\\.\\d+-x(?:86|64)-setup\\.exe' if platform == 'windows' else r'pi-desk-android-\\d+\\.\\d+\\.\\d+\\.apk'
versions = sorted((p for p in root.iterdir() if p.is_file() and re.fullmatch(pattern, p.name)), key=lambda p: p.stat().st_mtime, reverse=True)
previous = next((p.name for p in versions if p.name != current), None)
for path in versions:
    if path.name not in {current, previous}:
        path.unlink()
PY
echo "已校验并更新 $target 下载入口"
`

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '服务器分发仅从已确认的GitHub任务执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  const [platform, directory] = process.argv.slice(2)
  const pkg = await readClientPackage(platform, resolve(directory))
  for (const key of [
    'CLIENT_SSH_HOST',
    'CLIENT_SSH_USER',
    'CLIENT_SSH_PRIVATE_KEY',
    'CLIENT_SSH_KNOWN_HOSTS',
    'CLIENT_UPLOAD_ROOT',
    'CLIENT_DOWNLOAD_BASE_URL'
  ]) {
    assert.ok(process.env[key]?.trim(), `请配置 GitHub Secret ${key}`)
  }
  const host = process.env.CLIENT_SSH_HOST
  const user = process.env.CLIENT_SSH_USER
  const port = Number(process.env.CLIENT_SSH_PORT || 22)
  assert.match(host, /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/)
  assert.match(user, /^[a-zA-Z_][a-zA-Z0-9_-]*$/)
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  const root = process.env.CLIENT_UPLOAD_ROOT.replace(/\/+$/, '')
  assert.match(root, /^\/[a-zA-Z0-9_./-]+$/)
  assert.ok(root !== '/' && !root.split('/').includes('..'))
  const base = new URL(process.env.CLIENT_DOWNLOAD_BASE_URL)
  assert.equal(base.protocol, 'https:')
  assert.ok(
    !base.username &&
      !base.password &&
      !base.search &&
      !base.hash &&
      (!base.port || base.port === '443')
  )
  const runId = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  assert.match(runId, /^\d+-\d+$/)
  const stage = `${root}/staging/pi-desk-${platform}/${runId}`
  const temporary = join(process.env.RUNNER_TEMP, `pi-desk-upload-${platform}-${runId}`)
  await mkdir(temporary, { recursive: true })
  const keyPath = join(temporary, 'identity')
  const knownHosts = join(temporary, 'known_hosts')
  try {
    await writeFile(keyPath, process.env.CLIENT_SSH_PRIVATE_KEY.trimEnd() + '\n', { mode: 0o600 })
    await writeFile(knownHosts, process.env.CLIENT_SSH_KNOWN_HOSTS.trimEnd() + '\n', {
      mode: 0o600
    })
    const options = [
      '-i',
      keyPath,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'ConnectTimeout=15'
    ]
    const destination = `${user}@${host}`
    execFileSync(
      'ssh',
      [...options, '-p', String(port), destination, `mkdir -p -- ${quote(stage)}`],
      { stdio: 'inherit', timeout: 30_000 }
    )
    execFileSync(
      'scp',
      [...options, '-P', String(port), pkg.path, `${destination}:${stage}/${pkg.filename}`],
      { stdio: 'inherit', timeout: 600_000 }
    )
    const args = [
      root,
      platform,
      pkg.filename,
      pkg.sha256,
      base.href.replace(/\/+$/, ''),
      base.hostname,
      runId
    ]
    execFileSync(
      'ssh',
      [...options, '-p', String(port), destination, `bash -s -- ${args.map(quote).join(' ')}`],
      { input: remotePublishScript, stdio: ['pipe', 'inherit', 'inherit'], timeout: 180_000 }
    )
  } finally {
    try {
      execFileSync(
        'ssh',
        [
          '-i',
          keyPath,
          '-o',
          'BatchMode=yes',
          '-o',
          'StrictHostKeyChecking=yes',
          '-o',
          `UserKnownHostsFile=${knownHosts}`,
          '-o',
          'ConnectTimeout=10',
          '-p',
          String(port),
          `${user}@${host}`,
          `rm -rf -- ${quote(stage)}`
        ],
        { stdio: 'inherit', timeout: 20_000 }
      )
    } catch {
      console.error('服务器暂存清理未确认，请检查本次运行对应的 staging 目录')
      process.exitCode = 1
    }
    await rm(temporary, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
