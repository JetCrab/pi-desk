import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createSecretStore, type SecretStore } from '@jetcrab/pi-desk-sdk/secrets'
import { withConfigTransaction } from '@jetcrab/pi-desk-sdk/config'
import {
  cancelL4EnvironmentDesktop,
  L4EnvironmentNativeProcessUnreleasedError
} from './l4-environment-desktop'
import { environmentTargetPathKey } from './l4-environment-paths'
import { L4EnvironmentValidationError } from './l4-environment-error'
import { z } from 'zod'

const JournalSchema = z
  .object({
    state: z.enum(['preparing', 'prepared', 'host-restored', 'committed', 'rolled-back']),
    keyReference: z.string(),
    locks: z.array(z.string()),
    completion: z.object({ phase: z.string(), warnings: z.array(z.string()) }).optional(),
    externalPending: z.boolean().optional(),
    desktopProcessUnreleased: z.boolean().optional(),
    desktopOperation: z
      .object({ agentDir: z.string(), operationId: z.string().uuid() })
      .strict()
      .optional(),
    files: z.array(z.object({ target: z.string(), backup: z.string().nullable() }).strict())
  })
  .strict()
type Journal = z.infer<typeof JournalSchema>
export interface L4EnvironmentRecoveryResult {
  outcome: 'none' | 'not-started' | 'committed' | 'rolled-back'
  warnings: string[]
}

async function syncDirectory(path: string, allowMissing = false): Promise<void> {
  // Node 在 Windows 不提供目录句柄 fsync；文件内容仍 FlushFileBuffers，发布采用原子 rename。
  if (process.platform === 'win32') return
  const handle = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === 'ENOENT') return null
    throw error
  })
  if (!handle) return
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function writeL4EnvironmentJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    try {
      await rm(temporary, { force: true })
    } catch {
      console.warn('[Pi Desk][Environment] JSON临时文件清理失败', { phase: 'json-cleanup' })
    }
  }
}

export async function assertL4EnvironmentTarget(path: string): Promise<void> {
  let cursor = resolve(path)
  while (true) {
    const info = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (info?.isSymbolicLink()) throw new Error('恢复目标包含符号链接')
    if (cursor === resolve(path) && info && (!info.isFile() || info.nlink > 1))
      throw new Error('恢复目标不是独立普通文件，不能保证未选文件保持不变')
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
}

async function backupFile(source: string, destination: string, key: Buffer): Promise<boolean> {
  await assertL4EnvironmentTarget(source)
  const exists = await lstat(source).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (!exists) return false
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  await writeFile(destination, Buffer.concat([nonce, Buffer.alloc(16)]), {
    flag: 'wx',
    mode: 0o600
  })
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { flags: 'a' }))
  const handle = await open(destination, 'r+')
  try {
    await handle.write(cipher.getAuthTag(), 0, 16, 12)
    await handle.sync()
  } finally {
    await handle.close()
  }
  return true
}

async function restoreFile(source: string, target: string, key: Buffer): Promise<void> {
  const handle = await open(source, 'r')
  const header = Buffer.alloc(28)
  try {
    if ((await handle.read(header, 0, 28, 0)).bytesRead !== 28) throw new Error('回滚备份已截断')
  } finally {
    await handle.close()
  }
  const verify = createDecipheriv('aes-256-gcm', key, header.subarray(0, 12))
  verify.setAuthTag(header.subarray(12))
  await pipeline(createReadStream(source, { start: 28 }), verify, async (chunks): Promise<void> => {
    for await (const chunk of chunks) {
      void chunk
    }
  })
  const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(0, 12))
  decipher.setAuthTag(header.subarray(12))
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  await pipeline(
    createReadStream(source, { start: 28 }),
    decipher,
    createWriteStream(target, { flags: 'w', mode: 0o600 })
  )
  const output = await open(target, 'r+')
  try {
    await output.sync()
  } finally {
    await output.close()
  }
  await syncDirectory(dirname(target))
}

async function readJournal(directory: string): Promise<Journal | null> {
  const raw = await readFile(join(directory, 'journal.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }
  )
  return raw === null ? null : JournalSchema.parse(JSON.parse(raw))
}

async function withTargetLocks<T>(paths: readonly string[], action: () => Promise<T>): Promise<T> {
  const byKey = new Map(
    paths.map((path) => {
      const target = resolve(path)
      return [
        environmentTargetPathKey(target, process.platform === 'win32' ? 'win32' : 'posix'),
        target
      ] as const
    })
  )
  const projectPriority = (target: string): number => {
    const path = process.platform === 'win32' ? target.toLowerCase() : target
    return basename(path) === 'pi-desk.yaml' && basename(dirname(path)) === '.pi' ? 0 : 1
  }
  const targets = [...byKey]
    // SDK 项目写入持有项目锁后再获取全局主密钥锁，事务必须保持相同顺序。
    .sort(
      ([a, pathA], [b, pathB]) =>
        projectPriority(pathA) - projectPriority(pathB) || (a < b ? -1 : a > b ? 1 : 0)
    )
    .map(([, target]) => target)
  async function next(index: number): Promise<T> {
    if (index === targets.length) return action()
    return withConfigTransaction(targets[index]!, () => next(index + 1))
  }
  return next(0)
}

async function recordOutcome(directory: string, journal: Journal): Promise<void> {
  const path = join(directory, 'operation.json')
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  if (raw === null) return
  const operation = JSON.parse(raw) as { status: string; warnings: string[] }
  if (journal.state === 'committed' && operation.status === 'completed') return
  if (journal.state === 'committed') {
    // 文件事实先发布；包安装等后续步骤由 Runner 更新最终 phase，不猜测是否执行过。
    await writeL4EnvironmentJson(path, {
      ...operation,
      status: 'completed',
      phase: journal.completion?.phase ?? 'import-files-committed',
      error: null,
      warnings: [
        ...new Set([
          ...(journal.completion?.warnings ?? operation.warnings),
          '文件已提交；后续包安装以维护最终结果为准，中断时不自动重放。'
        ])
      ]
    })
  } else {
    await writeL4EnvironmentJson(path, {
      ...operation,
      status: 'failed',
      phase: journal.state === 'rolled-back' ? 'import-rolled-back' : 'interrupted-before-commit',
      error:
        journal.state === 'rolled-back'
          ? '事务中断或失败，已恢复宿主原件并完成所需桌面暂存撤销；未自动重放'
          : '维护准备阶段中断，尚未提交目标文件；未自动重放'
    })
  }
}

async function recoverTransaction(
  directory: string,
  store: SecretStore,
  locked: boolean
): Promise<L4EnvironmentRecoveryResult> {
  let journal = await readJournal(directory)
  if (!journal) return { outcome: 'none', warnings: [] }
  if (!locked && journal.locks.length)
    return withTargetLocks(journal.locks, () => recoverTransaction(directory, store, true))
  if (journal.state === 'prepared') {
    const encoded = await store.get(journal.keyReference)
    if (!encoded) throw new Error('环境恢复中断且回滚密钥不可用，拒绝启动')
    const key = Buffer.from(encoded, 'base64')
    try {
      if (key.length !== 32) throw new Error('回滚密钥无效，拒绝启动')
      for (const file of [...journal.files].reverse()) {
        await assertL4EnvironmentTarget(file.target)
        if (file.backup !== null) await restoreFile(join(directory, file.backup), file.target, key)
        else {
          await rm(file.target, { force: true })
          await syncDirectory(dirname(file.target), true)
        }
      }
      journal = { ...journal, state: 'host-restored' }
      await writeL4EnvironmentJson(join(directory, 'journal.json'), journal)
    } finally {
      key.fill(0)
    }
  }
  if (journal.state === 'host-restored') {
    if (journal.externalPending) {
      if (journal.desktopProcessUnreleased)
        throw new L4EnvironmentValidationError(
          '宿主原件已恢复，但原桌面 stage 进程树未确认释放；尚未尝试 cancel，保留现场并拒绝启动'
        )
      let cancelled: boolean
      try {
        if (!journal.desktopOperation) throw new Error('缺少桌面操作归属')
        cancelled = await cancelL4EnvironmentDesktop(
          journal.desktopOperation.agentDir,
          journal.desktopOperation.operationId
        )
      } catch {
        throw new L4EnvironmentValidationError(
          '宿主原件已恢复，但桌面暂存撤销结果未确认；保留现场并拒绝启动，不能宣称桌面已回滚'
        )
      }
      if (!cancelled)
        throw new L4EnvironmentValidationError(
          '宿主原件已恢复，桌面撤销返回 cancelled=false：可能从未暂存或已经应用；保留现场并拒绝启动，不能宣称桌面已回滚'
        )
    }
    journal = { ...journal, state: 'rolled-back' }
    await writeL4EnvironmentJson(join(directory, 'journal.json'), journal)
  }
  if (journal.state === 'prepared' || journal.state === 'host-restored')
    throw new Error('事务尚未恢复，拒绝标记终态')
  const outcome = journal.state === 'preparing' ? 'not-started' : journal.state
  // 终态写入失败时必须留 journal；绝不能先删除事实再推测结果。
  await recordOutcome(directory, journal)
  const warnings: string[] = []
  try {
    await store.delete(journal.keyReference)
    await rm(join(directory, 'rollback'), { recursive: true, force: true })
    await syncDirectory(directory)
    await rm(join(directory, 'journal.json'))
    await syncDirectory(directory)
  } catch {
    warnings.push(
      '事务结果已确认，但材料清理或目录同步未完全确认；终态不回滚，残留journal下次仅继续清理。'
    )
    console.warn('[Pi Desk][Environment] 事务清理未完成', { phase: 'transaction-cleanup', outcome })
  }
  return { outcome, warnings }
}

export async function recoverL4EnvironmentTransaction(
  directory: string,
  store: SecretStore
): Promise<L4EnvironmentRecoveryResult> {
  return recoverTransaction(directory, store, false)
}

export async function applyL4EnvironmentTransaction(input: {
  directory: string
  agentDir: string
  targets: readonly string[]
  lockTargets?: readonly string[]
  completion?: { phase: string; warnings: string[] }
  validate?: () => Promise<void>
  apply: () => Promise<void>
  desktop?: { operationId: string; stage: () => Promise<void> }
  store?: SecretStore
}): Promise<string[]> {
  return withTargetLocks(input.lockTargets ?? [], async (): Promise<string[]> => {
    const store =
      input.store ?? createSecretStore({ agentDir: getL4EnvironmentOperationRoot(input.agentDir) })
    const targets = input.targets.map((target) => resolve(target))
    if (
      new Set(
        targets.map((path) =>
          environmentTargetPathKey(path, process.platform === 'win32' ? 'win32' : 'posix')
        )
      ).size !== targets.length
    )
      throw new Error('恢复选择包含重复目标')
    await input.validate?.()
    const key = randomBytes(32)
    const keyReference = `secret://${randomUUID()}`
    const files: Journal['files'] = []
    await mkdir(join(input.directory, 'rollback'), { recursive: true, mode: 0o700 })
    const preparing: Journal = {
      state: 'preparing',
      keyReference,
      files: [],
      locks: [...(input.lockTargets ?? [])],
      completion: input.completion
    }
    await writeL4EnvironmentJson(join(input.directory, 'journal.json'), preparing)
    try {
      await store.put(key.toString('base64'), keyReference)
      for (const [index, target] of targets.entries()) {
        const backup = `rollback/${index}.enc`
        files.push({
          target,
          backup: (await backupFile(target, join(input.directory, backup), key)) ? backup : null
        })
      }
      await syncDirectory(join(input.directory, 'rollback'))
      await syncDirectory(input.directory)
      const journal: Journal = { ...preparing, state: 'prepared', files }
      await writeL4EnvironmentJson(join(input.directory, 'journal.json'), journal)
      for (const target of targets) await assertL4EnvironmentTarget(target)
      await input.apply()
      for (const target of targets) {
        const handle = await open(target, 'r+')
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
        await syncDirectory(dirname(target))
      }
      if (input.desktop) {
        await writeL4EnvironmentJson(join(input.directory, 'journal.json'), {
          ...journal,
          externalPending: true,
          desktopOperation: { agentDir: input.agentDir, operationId: input.desktop.operationId }
        })
        await input.desktop.stage()
      }
      await writeL4EnvironmentJson(join(input.directory, 'journal.json'), {
        ...journal,
        state: 'committed'
      })
      return (await recoverTransaction(input.directory, store, true)).warnings
    } catch (error) {
      const journal = await readJournal(input.directory)
      if (journal?.state === 'committed') {
        // 包括原子发布之后的同步/清理失败：文件已提交，不允许反向恢复旧文件。
        try {
          return [
            ...(await recoverTransaction(input.directory, store, true)).warnings,
            '文件已提交；提交后的记录或清理曾失败，请核对维护结果。'
          ]
        } catch {
          return [
            '文件已提交，但终态记录或清理未完成；保留committed journal供启动恢复，不自动重放。'
          ]
        }
      }
      if (journal && error instanceof L4EnvironmentNativeProcessUnreleasedError)
        await writeL4EnvironmentJson(join(input.directory, 'journal.json'), {
          ...journal,
          desktopProcessUnreleased: true
        })
      try {
        await recoverTransaction(input.directory, store, true)
      } catch (recoveryError) {
        if (recoveryError instanceof L4EnvironmentValidationError) throw recoveryError
        throw new Error('环境提交失败且恢复未完成，保留现场并拒绝启动')
      }
      throw error
    } finally {
      key.fill(0)
    }
  })
}

export async function isL4EnvironmentCommitRecorded(directory: string): Promise<boolean> {
  const journal = await readJournal(directory)
  if (journal) return journal.state === 'committed'
  const raw = await readFile(join(directory, 'operation.json'), 'utf8').catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    }
  )
  return (
    raw !== null && (JSON.parse(raw) as { status?: string; kind?: string }).status === 'completed'
  )
}

export function getL4EnvironmentOperationRoot(agentDir: string): string {
  return join(agentDir, 'pi-desk', 'environment-operations')
}

/** 必须先恢复本宿主的提交事实，再创建任何 Next/Agent Runtime；不协调其他手动 Pi/服务。 */
export async function recoverL4EnvironmentBeforeRuntime(
  agentDir: string,
  store = createSecretStore({ agentDir: getL4EnvironmentOperationRoot(agentDir) }),
  activeOperationId?: string
): Promise<void> {
  const root = getL4EnvironmentOperationRoot(agentDir)
  const directories = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    }
  )
  for (const directory of directories) {
    if (!directory.isDirectory()) continue
    const path = join(root, directory.name)
    const recovered = await recoverL4EnvironmentTransaction(path, store)
    if (directory.name === activeOperationId && recovered.outcome === 'none') continue
    const operationPath = join(path, 'operation.json')
    const raw = await readFile(operationPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    if (raw === null) continue
    const operation = JSON.parse(raw) as { status: string; expiresAt: number; warnings: string[] }
    if (recovered.warnings.length)
      await writeL4EnvironmentJson(operationPath, {
        ...operation,
        warnings: [...new Set([...operation.warnings, ...recovered.warnings])]
      })
    if (operation.status === 'running' || operation.status === 'pending') {
      await writeL4EnvironmentJson(operationPath, {
        ...operation,
        status: 'failed',
        phase: 'interrupted-unknown',
        error: '维护进程中断，缺少可确认的提交事实；结果未知，未自动重放，请检查现有环境和制品'
      })
    } else if (operation.expiresAt <= Date.now() && !(await readJournal(path)))
      await rm(path, { recursive: true, force: true })
  }
}
