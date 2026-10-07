import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scrypt } from 'node:crypto'
import { after, test } from 'node:test'
import { promisify } from 'node:util'

const testRoot = join(process.cwd(), 'temp', 'tests', 'auth-config', String(process.pid))
const agentDir = join(testRoot, 'agent')
const authDirectory = join(agentDir, 'pi-desk')
const authConfigPath = join(authDirectory, 'auth.json')
const sessionKeyPath = join(authDirectory, 'auth-session-key')
const deriveScrypt = promisify(scrypt)
let holdNextScrypt = false
let notifyScryptComplete = () => undefined
let releaseScrypt = Promise.resolve()

function controlledScrypt(password, salt, keyLength, options, callback) {
  if (!holdNextScrypt) return scrypt(password, salt, keyLength, options, callback)
  holdNextScrypt = false
  return scrypt(password, salt, keyLength, options, (error, derivedKey) => {
    if (error) {
      callback(error)
      return
    }
    notifyScryptComplete()
    void releaseScrypt.then(() => callback(null, derivedKey))
  })
}

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

test('认证文件格式、scrypt 参数、独立 key 与哈希期间变更拒签', async () => {
  await mkdir(join(agentDir, 'sessions'), { recursive: true })
  await mkdir(authDirectory, { recursive: true })
  process.env.PI_CODING_AGENT_DIR = agentDir
  process.env.PI_CODING_AGENT_SESSION_DIR = join(agentDir, 'sessions')
  process.env.TSX_TSCONFIG_PATH = join(process.cwd(), 'tsconfig.json')

  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === '@earendil-works/pi-coding-agent') {
      return { getAgentDir: () => agentDir }
    }
    if (request === 'node:crypto') {
      return { ...originalLoad.call(this, request, parent, isMain), scrypt: controlledScrypt }
    }
    return originalLoad.call(this, request, parent, isMain)
  }

  let auth
  let webAuth
  let l2Auth
  try {
    const authModule = await import('../src/server/l4_foundation/auth/l4-auth-config.ts')
    const webAuthModule = await import('../src/server/l4_foundation/auth/l4-web-auth.ts')
    const l2AuthModule = await import('../src/server/l2_biz/auth/l2-auth.ts')
    auth = authModule.default ?? authModule
    webAuth = webAuthModule.default ?? webAuthModule
    l2Auth = l2AuthModule.default ?? l2AuthModule
  } finally {
    Module._load = originalLoad
  }

  assert.equal(auth.getL4AuthConfigPath(), authConfigPath)
  assert.equal(auth.readL4AuthCredentials(), null)

  const password = 'Correct Horse 42!'
  const passwordHash = await auth.hashL4AuthPassword(password)
  assert.match(passwordHash, /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/)
  assert.equal(await auth.verifyL4AuthPassword(password, passwordHash), true)
  assert.equal(await auth.verifyL4AuthPassword('incorrect password', passwordHash), false)
  const [, salt, digest] = passwordHash.split(':')
  const independentDigest = await deriveScrypt(password, Buffer.from(salt, 'hex'), 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
  assert.equal(independentDigest.toString('hex'), digest)

  await writeFile(sessionKeyPath, 'stale key', 'utf8')
  auth.writeL4AuthConfig({ passwordHash })
  const stored = JSON.parse(await readFile(authConfigPath, 'utf8'))
  assert.deepEqual(Object.keys(stored), ['passwordHash'])
  assert.equal(stored.passwordHash, passwordHash)
  await writeFile(authConfigPath, JSON.stringify({ username: 'legacy', passwordHash }), 'utf8')
  const legacy = auth.readL4AuthCredentials()
  assert.ok(legacy)
  assert.equal('username' in legacy, false)
  assert.equal(await auth.verifyL4AuthPassword(password, legacy.passwordHash), true)
  assert.ok(await l2Auth.authenticateL2WebLogin({ password }))
  auth.writeL4AuthConfig({ passwordHash })

  const credentials = auth.readL4AuthCredentials()
  assert.ok(credentials)
  assert.match(credentials.sessionSecret, /^[a-f0-9]{64}$/)
  assert.equal(auth.readL4AuthCredentials()?.sessionSecret, credentials.sessionSecret)
  const sessionKey = (await readFile(sessionKeyPath, 'utf8')).trim()
  assert.match(sessionKey, /^[a-f0-9]{64}$/)
  assert.notEqual(credentials.sessionSecret, passwordHash)
  if (process.platform !== 'win32') {
    assert.equal((await stat(authConfigPath)).mode & 0o777, 0o600)
    assert.equal((await stat(sessionKeyPath)).mode & 0o777, 0o600)
  }
  assert.equal(
    (await readdir(authDirectory)).some((name) => name.endsWith('.tmp')),
    false
  )

  const now = 1_700_000_000_000
  const passwordSignedToken = webAuth.createL4WebAuthSessionToken(passwordHash, 60, now)
  assert.equal(
    webAuth.isValidL4WebAuthSessionToken(passwordSignedToken, credentials.sessionSecret, now),
    false
  )

  await rm(sessionKeyPath)
  assert.throws(() => auth.readL4AuthCredentials(), auth.L4AuthConfigError)
  await writeFile(sessionKeyPath, 'damaged key', 'utf8')
  assert.throws(() => auth.readL4AuthCredentials(), auth.L4AuthConfigError)
  await writeFile(authConfigPath, '{broken', 'utf8')
  assert.throws(() => auth.readL4AuthCredentials(), auth.L4AuthConfigError)
  await rm(authConfigPath)
  await rm(sessionKeyPath)
  assert.equal(auth.readL4AuthCredentials(), null)

  await writeFile(sessionKeyPath, 'damaged key', 'utf8')
  const nextPassword = 'Updated Horse 42!'
  const nextPasswordHash = await auth.hashL4AuthPassword(nextPassword)
  auth.writeL4AuthConfig({ passwordHash: nextPasswordHash })
  const nextCredentials = auth.readL4AuthCredentials()
  assert.ok(nextCredentials)
  assert.notEqual(nextCredentials.sessionSecret, credentials.sessionSecret)
  const nextSessionKey = (await readFile(sessionKeyPath, 'utf8')).trim()
  assert.match(nextSessionKey, /^[a-f0-9]{64}$/)
  assert.notEqual(nextSessionKey, sessionKey)
  assert.equal(await auth.verifyL4AuthPassword(nextPassword, nextCredentials.passwordHash), true)

  let signalScryptComplete
  let releaseScryptGate
  const scryptComplete = new Promise((resolve) => {
    signalScryptComplete = resolve
  })
  const scryptGate = new Promise((resolve) => {
    releaseScryptGate = resolve
  })
  notifyScryptComplete = signalScryptComplete
  releaseScrypt = scryptGate
  holdNextScrypt = true
  const authentication = l2Auth.authenticateL2WebLogin({ password: nextPassword })
  let scryptTimeout
  try {
    await Promise.race([
      scryptComplete,
      new Promise((_, reject) => {
        scryptTimeout = setTimeout(() => reject(new Error('密码哈希未开始')), 10_000)
      })
    ])
    await rm(authConfigPath)
  } finally {
    clearTimeout(scryptTimeout)
    releaseScryptGate()
  }
  assert.equal(await authentication, null)
  assert.equal(auth.readL4AuthCredentials(), null)

  auth.writeL4AuthConfig(null)
  assert.equal(auth.readL4AuthCredentials(), null)
  assert.equal((await readFile(sessionKeyPath, 'utf8')).trim(), nextSessionKey)
})
