import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const websiteDeployScript = `set -euo pipefail
root=$1
run_id=$2
url=$3
tag=$4
stage="$root/staging/website-$run_id"
backup="$root/previous-site"
changed=false
finish() {
  status=$?
  trap - EXIT
  if (( status != 0 )) && [[ "$changed" == true ]]; then
    echo '官网验证失败，恢复上次静态页面。' >&2
    rsync -a --delete "$backup/" "$root/data/" || echo '官网恢复失败，需要检查服务器。' >&2
  fi
  rm -rf -- "$stage"
  exit "$status"
}
trap finish EXIT
[[ -d "$root/data" ]]
python3 - "$stage/site.tar.gz" "$stage/site" <<'PY'
import sys, tarfile
from pathlib import Path, PurePosixPath
archive, destination = sys.argv[1:]
with tarfile.open(archive, 'r:gz') as stream:
    names = set()
    for member in stream.getmembers():
        name = PurePosixPath(member.name)
        if name.is_absolute() or '..' in name.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('官网归档路径或类型无效')
        names.add(str(name))
    if not {'index.html', 'changelog/index.html', 'docs/index.html'} <= names:
        raise SystemExit('官网归档缺少必要页面')
    Path(destination).mkdir()
    stream.extractall(destination, filter='data')
PY
grep -Fq "$tag" "$stage/site/changelog/index.html"
echo '官网归档和发布批次校验通过，开始保存上一版。'
mkdir -p "$backup"
rsync -a --delete "$root/data/" "$backup/"
changed=true
rsync -a --delete "$stage/site/" "$root/data/"
echo '静态页面已同步，开始验证公网。'
for path in / /docs/ /changelog/; do
  curl --fail --silent --show-error --compressed --max-time 30 "$url$path" -o "$stage/probe"
  if [[ "$path" == /changelog/ ]]; then grep -Fq "$tag" "$stage/probe"; fi
done
echo '官网发布完成，公网更新日志已包含本次批次。'
`

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function deploymentConfig(env) {
  for (const key of [
    'WEBSITE_SSH_HOST',
    'WEBSITE_SSH_USER',
    'WEBSITE_SSH_KNOWN_HOSTS',
    'WEBSITE_ROOT',
    'WEBSITE_URL'
  ]) {
    assert.ok(env[key]?.trim(), `缺少官网部署配置：${key}`)
  }
  assert.match(env.WEBSITE_SSH_HOST, /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/)
  assert.match(env.WEBSITE_SSH_USER, /^[a-zA-Z_][a-zA-Z0-9_-]*$/)
  const root = env.WEBSITE_ROOT.replace(/\/+$/, '')
  assert.match(root, /^\/[a-zA-Z0-9_./-]+$/)
  assert.ok(root.startsWith('/home/apps/') && !root.split('/').includes('..'))
  const url = new URL(env.WEBSITE_URL)
  assert.equal(url.protocol, 'https:')
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/')
  const port = Number(env.WEBSITE_SSH_PORT || 22)
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  assert.ok(env.WEBSITE_SSH_PRIVATE_KEY || env.WEBSITE_SSH_PASSWORD, '缺少官网 SSH 授权')
  return {
    root,
    url: url.origin,
    port,
    destination: `${env.WEBSITE_SSH_USER}@${env.WEBSITE_SSH_HOST}`
  }
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, 'true', '官网正式部署仅从 GitHub Actions 执行')
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main')
  const [archive, tag] = process.argv.slice(2)
  assert.match(tag, /^release-[a-f0-9]{12}$/)
  const config = deploymentConfig(process.env)
  const run = `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`
  assert.match(run, /^\d+-\d+$/)
  const directory = join(process.env.RUNNER_TEMP, `website-auth-${run}`)
  const stage = `${config.root}/staging/website-${run}`
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const options = [
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${join(directory, 'known_hosts')}`,
    '-o',
    'ConnectTimeout=15'
  ]
  const env = { ...process.env }
  try {
    await readFile(resolve(archive))
    await writeFile(
      join(directory, 'known_hosts'),
      process.env.WEBSITE_SSH_KNOWN_HOSTS.trimEnd() + '\n',
      { mode: 0o600 }
    )
    if (env.WEBSITE_SSH_PRIVATE_KEY) {
      const key = join(directory, 'identity')
      await writeFile(key, env.WEBSITE_SSH_PRIVATE_KEY.trimEnd() + '\n', { mode: 0o600 })
      options.push('-i', key, '-o', 'BatchMode=yes')
    } else {
      const askpass = join(directory, 'askpass.sh')
      await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$WEBSITE_SSH_PASSWORD"\n', {
        mode: 0o700
      })
      Object.assign(env, {
        SSH_ASKPASS: askpass,
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: 'website-ci'
      })
      options.push('-o', 'PreferredAuthentications=password', '-o', 'NumberOfPasswordPrompts=1')
    }
    const ssh = (...args) =>
      execFileSync('ssh', [...options, '-p', String(config.port), config.destination, ...args], {
        env,
        stdio: 'inherit',
        timeout: 30_000
      })
    ssh(`mkdir -p -- ${quote(stage)}`)
    execFileSync(
      'scp',
      [
        ...options,
        '-P',
        String(config.port),
        resolve(archive),
        `${config.destination}:${stage}/site.tar.gz`
      ],
      { env, stdio: 'inherit', timeout: 300_000 }
    )
    execFileSync(
      'ssh',
      [
        ...options,
        '-p',
        String(config.port),
        config.destination,
        `bash -s -- ${[config.root, run, config.url, tag].map(quote).join(' ')}`
      ],
      { env, input: websiteDeployScript, stdio: ['pipe', 'inherit', 'inherit'], timeout: 300_000 }
    )
  } finally {
    try {
      execFileSync(
        'ssh',
        [...options, '-p', String(config.port), config.destination, `rm -rf -- ${quote(stage)}`],
        { env, stdio: 'inherit', timeout: 20_000 }
      )
    } catch {
      console.error('本次官网上传暂存清理未确认')
    }
    await rm(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('官网部署失败，请检查上述阶段结果；旧站按回滚结果确认。')
    process.exitCode = 1
  })
}
