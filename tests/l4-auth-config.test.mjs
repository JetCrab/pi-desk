import assert from 'node:assert/strict'
import Module from 'node:module'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { scrypt } from 'node:crypto'
import { after, test } from 'node:test'
import { promisify } from 'node:util'
import { parse as parseYaml } from 'yaml'
const authDocument = (auth) => JSON.stringify({ 'pi-desk': { auth } })

const testRoot = join(process.cwd(), 'temp', 'tests', 'auth-config', String(process.pid))
const agentDir = join(testRoot, 'agent')
const authDirectory = join(agentDir, 'pi-desk')
const authConfigPath = join(agentDir, 'config', 'pi-desk.yaml')
const legacyAuthConfigPath = join(authDirectory, 'auth.json')
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
  const concurrent = [
    auth.verifyL4AuthPassword(password, passwordHash),
    auth.verifyL4AuthPassword(password, passwordHash)
  ]
  await assert.rejects(auth.verifyL4AuthPassword(password, passwordHash), auth.L4AuthBusyError)
  assert.deepEqual(await Promise.all(concurrent), [true, true])
  assert.equal(await auth.verifyL4AuthPassword(password, passwordHash), true)
  const [, salt, digest] = passwordHash.split(':')
  const independentDigest = await deriveScrypt(password, Buffer.from(salt, 'hex'), 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024
  })
  assert.equal(independentDigest.toString('hex'), digest)

  const legacyContent = JSON.stringify({ username: 'legacy', passwordHash })
  await writeFile(legacyAuthConfigPath, legacyContent)
  assert.equal(auth.readL4AuthCredentials(), null)
  await assert.rejects(readFile(authConfigPath), { code: 'ENOENT' })
  assert.equal(await readFile(legacyAuthConfigPath, 'utf8'), legacyContent)

  await writeFile(sessionKeyPath, 'stale key', 'utf8')
  await assert.rejects(auth.writeL4AuthConfig({ passwordHash }), auth.L4AuthConfigError)
  assert.equal(await readFile(sessionKeyPath, 'utf8'), 'stale key')
  await assert.rejects(readFile(authConfigPath), { code: 'ENOENT' })
  await rm(sessionKeyPath)
  await auth.writeL4AuthConfig({ passwordHash })
  assert.equal(auth.getL4AuthConfigPath(), authConfigPath)
  assert.equal(await readFile(legacyAuthConfigPath, 'utf8'), legacyContent)
  assert.equal(auth.readL4AuthCredentials()?.passwordHash, passwordHash)
  const stored = parseYaml(await readFile(authConfigPath, 'utf8'))['pi-desk'].auth
  assert.deepEqual(Object.keys(stored), ['passwordHash'])
  assert.equal(stored.passwordHash, passwordHash)
  await writeFile(authConfigPath, authDocument({ username: 'legacy', passwordHash }), 'utf8')
  assert.throws(() => auth.readL4AuthCredentials(), auth.L4AuthConfigError)
  assert.throws(() => auth.restoreL4AuthSessionKey(agentDir))
  await writeFile(authConfigPath, authDocument({ passwordHash }), 'utf8')
  assert.ok(await l2Auth.authenticateL2WebLogin({ password }))
  await auth.writeL4AuthConfig({ passwordHash })

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
  await assert.rejects(auth.writeL4AuthConfig({ passwordHash }), auth.L4AuthConfigError)
  await assert.rejects(readFile(sessionKeyPath), { code: 'ENOENT' })
  auth.restoreL4AuthSessionKey(agentDir)
  const restoredKey = await readFile(sessionKeyPath, 'utf8')
  auth.restoreL4AuthSessionKey(agentDir)
  assert.equal(await readFile(sessionKeyPath, 'utf8'), restoredKey)
  const importedCredentials = auth.readL4AuthCredentials()
  assert.ok(importedCredentials)
  assert.notEqual(importedCredentials.sessionSecret, credentials.sessionSecret)
  assert.match((await readFile(sessionKeyPath, 'utf8')).trim(), /^[a-f0-9]{64}$/)
  await writeFile(sessionKeyPath, 'damaged key', 'utf8')
  assert.throws(() => auth.readL4AuthCredentials(), auth.L4AuthConfigError)
  assert.throws(() => auth.restoreL4AuthSessionKey(agentDir), auth.L4AuthConfigError)
  assert.equal(await readFile(sessionKeyPath, 'utf8'), 'damaged key')
  await writeFile(authConfigPath, '{broken', 'utf8')
  assert.throws(() => auth.readL4AuthCredentials(), auth.L4AuthConfigError)
  await rm(authConfigPath)
  await rm(sessionKeyPath)
  assert.equal(auth.readL4AuthCredentials(), null)

  await writeFile(sessionKeyPath, 'damaged key', 'utf8')
  const nextPassword = 'Updated Horse 42!'
  const nextPasswordHash = await auth.hashL4AuthPassword(nextPassword)
  await assert.rejects(
    auth.writeL4AuthConfig({ passwordHash: nextPasswordHash }),
    auth.L4AuthConfigError
  )
  assert.equal(await readFile(sessionKeyPath, 'utf8'), 'damaged key')
  await rm(sessionKeyPath)
  await auth.writeL4AuthConfig({ passwordHash: nextPasswordHash })
  const nextCredentials = auth.readL4AuthCredentials()
  assert.ok(nextCredentials)
  assert.notEqual(nextCredentials.sessionSecret, credentials.sessionSecret)
  const nextSessionKey = (await readFile(sessionKeyPath, 'utf8')).trim()
  assert.match(nextSessionKey, /^[a-f0-9]{64}$/)
  assert.notEqual(nextSessionKey, sessionKey)
  assert.equal(await auth.verifyL4AuthPassword(nextPassword, nextCredentials.passwordHash), true)

  const offlineAgentDir = join(testRoot, 'offline-import-agent')
  const offlineConfigPath = join(offlineAgentDir, 'config', 'pi-desk.yaml')
  const offlineKeyPath = join(offlineAgentDir, 'pi-desk', 'auth-session-key')
  await mkdir(join(offlineAgentDir, 'config'), { recursive: true })
  await writeFile(offlineConfigPath, '{broken')
  assert.throws(() => auth.restoreL4AuthSessionKey(offlineAgentDir))
  await assert.rejects(readFile(offlineKeyPath), { code: 'ENOENT' })
  await writeFile(offlineConfigPath, authDocument({ passwordHash: nextPasswordHash }))
  auth.restoreL4AuthSessionKey(offlineAgentDir)
  assert.match((await readFile(offlineKeyPath, 'utf8')).trim(), /^[a-f0-9]{64}$/)
  assert.equal(
    await readFile(offlineConfigPath, 'utf8'),
    authDocument({ passwordHash: nextPasswordHash })
  )
  assert.equal((await readFile(sessionKeyPath, 'utf8')).trim(), nextSessionKey)

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

  await auth.writeL4AuthConfig(null)
  assert.equal(auth.readL4AuthCredentials(), null)
  assert.equal((await readFile(sessionKeyPath, 'utf8')).trim(), nextSessionKey)
  assert.equal(await readFile(legacyAuthConfigPath, 'utf8'), legacyContent)
})
