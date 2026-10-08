import assert from 'node:assert/strict'

export function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-dev\.(0|[1-9]\d*))?$/.exec(version)
  assert.ok(
    typeof version === 'string' && match?.[0] === version,
    `版本必须为 x.y.z 或 x.y.z-dev.N：${version}`
  )
  const numbers = match.slice(1).map((value) => (value === undefined ? null : Number(value)))
  assert.ok(
    numbers.every((value) => value === null || Number.isSafeInteger(value)),
    '版本号超出安全整数范围'
  )
  return numbers
}

export function npmTagFor(ref, version) {
  assert.ok(['refs/heads/main', 'refs/heads/dev'].includes(ref), 'npm只允许main或dev分支')
  const development = versionParts(version)[3] !== null
  assert.equal(development, ref === 'refs/heads/dev', `${ref} 与版本 ${version} 的通道不匹配`)
  return development ? 'dev' : 'latest'
}

export function versionIncreased(before, after, path) {
  const next = versionParts(after).map((value) => value ?? Infinity)
  if (before === after) return false
  if (before === null) return true
  const previous = versionParts(before).map((value) => value ?? Infinity)
  const changed = next.findIndex((value, index) => value !== previous[index])
  assert.ok(next[changed] > previous[changed], `${path} 版本必须递增：${before} → ${after}`)
  return true
}
