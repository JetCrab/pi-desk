import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const { terminateManagedTree } = require('../src/server/l4_foundation/process/l4-process-tree.js')
const execFileAsync = promisify(execFile)
const testRoot = resolve('temp/tests/pi-desk-process-tree', String(process.pid))
const spawnedRoots = new Set()
const spawnedChildren = new Set()

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function withTimeout(promise, label, timeoutMs = 5_000) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}等待超时`)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitForFile(path, label) {
  await withTimeout(
    (async () => {
      while (true) {
        try {
          await readFile(path, 'utf8')
          return
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await delay(20)
        }
      }
    })(),
    label
  )
}

async function spawnProcessTree(mode, root) {
  const rootPidFile = join(root, 'root.pid')
  const childPidFile = join(root, 'child.pid')
  const childHeartbeatFile = join(root, 'child.heartbeat')
  const childScript = `
    const fs = require('node:fs')
    setInterval(() => fs.appendFileSync(${JSON.stringify(childHeartbeatFile)}, 'x'), 50)
  `
  const rootScript = `
    const fs = require('node:fs')
    const { spawn } = require('node:child_process')
    const mode = ${JSON.stringify(mode)}
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(childScript)}], {
      stdio: 'ignore', windowsHide: true, detached: mode === 'orphan'
    })
    fs.writeFileSync(${JSON.stringify(rootPidFile)}, String(process.pid))
    child.once('spawn', () => {
      fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid))
      if (mode === 'orphan') {
        child.unref()
        setImmediate(() => process.exit(0))
      } else {
        setInterval(() => {}, 1000)
      }
    })
  `
  const rootChild = spawn(process.execPath, ['-e', rootScript], {
    stdio: 'ignore',
    windowsHide: true
  })
  spawnedRoots.add(rootChild)
  await waitForFile(rootPidFile, `${mode} root PID`)
  await waitForFile(childPidFile, `${mode} child PID`)
  const childPid = Number((await readFile(childPidFile, 'utf8')).trim())
  spawnedChildren.add(childPid)
  return {
    rootChild,
    rootPid: Number((await readFile(rootPidFile, 'utf8')).trim()),
    childPid,
    childHeartbeatFile
  }
}

async function processExists(pid) {
  try {
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }`
      ],
      { windowsHide: true, timeout: 5_000 }
    )
    return true
  } catch (error) {
    if (error.code === 1) return false
    throw error
  }
}

test(
  'Windows清理仍存活managed root时终止整棵进程树',
  {
    skip: process.platform !== 'win32',
    timeout: 15_000
  },
  async (context) => {
    const root = join(testRoot, 'live-root')
    await mkdir(root, { recursive: true })
    context.after(async () => {
      for (const child of spawnedRoots) {
        if (child.exitCode === null && child.signalCode === null) {
          await terminateManagedTree(child).catch(() => undefined)
        }
      }
      await rm(root, { recursive: true, force: true })
    })

    const tree = await spawnProcessTree('live', root)
    const exit = once(tree.rootChild, 'exit')
    await withTimeout(terminateManagedTree(tree.rootChild), 'live root process tree termination')
    await withTimeout(exit, 'live root exit')
    assert.equal(await processExists(tree.rootPid), false)
    assert.equal(await processExists(tree.childPid), false)
  }
)

test(
  'Windows root先退出时按旧ParentProcessId清理仍存活的孙进程',
  {
    skip: process.platform !== 'win32',
    timeout: 15_000
  },
  async (context) => {
    const root = join(testRoot, 'orphan-root')
    await mkdir(root, { recursive: true })
    context.after(async () => {
      for (const child of spawnedRoots) {
        if (child.exitCode === null && child.signalCode === null) {
          await terminateManagedTree(child).catch(() => undefined)
        }
      }
      await rm(root, { recursive: true, force: true })
    })

    const tree = await spawnProcessTree('orphan', root)
    if (tree.rootChild.exitCode === null && tree.rootChild.signalCode === null) {
      await withTimeout(once(tree.rootChild, 'exit'), 'orphan root exit')
    }
    assert.equal(await processExists(tree.rootPid), false)
    assert.equal(await processExists(tree.childPid), true)
    await withTimeout(terminateManagedTree(tree.rootChild), 'orphan process cleanup')
    await withTimeout(
      (async () => {
        while (await processExists(tree.childPid)) await delay(25)
      })(),
      'orphan child exit'
    )
    assert.equal(await processExists(tree.childPid), false)
  }
)

test(
  'Windows已退出且没有子进程的命令可以正常完成清理',
  { skip: process.platform !== 'win32', timeout: 15_000 },
  async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true
    })
    spawnedRoots.add(child)
    await withTimeout(once(child, 'exit'), 'leaf command exit')
    await withTimeout(terminateManagedTree(child), 'leaf command cleanup')
    assert.equal(await processExists(child.pid), false)
  }
)

test(
  'Windows孤儿进程清理不依赖CIM或WMI查询',
  { skip: process.platform !== 'win32', timeout: 15_000 },
  async (context) => {
    const source = await readFile(
      new URL('../src/server/l4_foundation/process/l4-process-tree.js', import.meta.url),
      'utf8'
    )
    const runtime = { exports: {} }
    runInNewContext(source, {
      module: runtime,
      process,
      Buffer,
      require(name) {
        if (name !== 'node:child_process') return require(name)
        return {
          execFile(file, args, options, callback) {
            if (file === 'powershell.exe') {
              const index = args.indexOf('-EncodedCommand') + 1
              const script = Buffer.from(args[index], 'base64').toString('utf16le')
              args = [...args]
              args[index] = Buffer.from(
                `function Get-CimInstance { throw '测试禁止依赖 CIM/WMI 查询' }; ${script}`,
                'utf16le'
              ).toString('base64')
            }
            return execFile(file, args, options, callback)
          }
        }
      }
    })
    const root = join(testRoot, 'without-cim')
    await mkdir(root, { recursive: true })
    context.after(() => rm(root, { recursive: true, force: true }))
    const tree = await spawnProcessTree('orphan', root)
    if (tree.rootChild.exitCode === null && tree.rootChild.signalCode === null) {
      await withTimeout(once(tree.rootChild, 'exit'), 'non-CIM root exit')
    }
    assert.equal(await processExists(tree.childPid), true)
    await withTimeout(
      runtime.exports.terminateManagedTree(tree.rootChild),
      'non-CIM orphan cleanup'
    )
    assert.equal(await processExists(tree.childPid), false)
  }
)

test(
  'Windows孤儿清理拒绝仍存活的根PID并保留其子进程',
  { skip: process.platform !== 'win32', timeout: 15_000 },
  async (context) => {
    const root = join(testRoot, 'root-identity')
    await mkdir(root, { recursive: true })
    context.after(() => rm(root, { recursive: true, force: true }))
    const tree = await spawnProcessTree('live', root)
    try {
      await assert.rejects(
        terminateManagedTree({ pid: tree.rootPid, exitCode: 0, signalCode: null }),
        /Managed PID is still present; refusing orphan cleanup/
      )
      assert.equal(await processExists(tree.rootPid), true)
      assert.equal(await processExists(tree.childPid), true)
    } finally {
      await terminateManagedTree(tree.rootChild)
    }
  }
)

test.after(async () => {
  for (const pid of spawnedChildren) {
    if (await processExists(pid)) {
      await execFileAsync('taskkill.exe', ['/PID', String(pid), '/F'], {
        windowsHide: true,
        timeout: 5_000
      }).catch(() => undefined)
    }
  }
  for (const child of spawnedRoots) {
    if (child.exitCode === null && child.signalCode === null) {
      await terminateManagedTree(child).catch(() => undefined)
    }
  }
  await rm(testRoot, { recursive: true, force: true })
})
