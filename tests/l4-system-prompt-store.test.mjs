import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import Module, { syncBuiltinESMExports } from 'node:module'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'

const originalLoad = Module._load
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {}
  if (request === '@earendil-works/pi-coding-agent') {
    return { getAgentDir: () => process.env.PI_CODING_AGENT_DIR }
  }
  return originalLoad.call(this, request, parent, isMain)
}
const { L4CapabilityModesStore } =
  await import('../src/server/l4_foundation/capability-modes/l4-capability-modes-store.ts')
Module._load = originalLoad

async function fixture() {
  const root = resolve('temp/pi/l4-system-prompt-store', `prompt-storage-${randomUUID()}`)
  const agentDir = join(root, 'agent')
  await mkdir(agentDir, { recursive: true })
  return {
    root,
    agentDir,
    store: new L4CapabilityModesStore(agentDir),
    yaml: join(agentDir, 'config', 'pi-desk.yaml'),
    prompts: join(agentDir, 'config', 'system-prompts')
  }
}

function failRename(reject) {
  const previous = fs.renameSync
  fs.renameSync = function rename(source, target) {
    if (reject(String(target)))
      throw Object.assign(new Error('注入原子发布失败'), { code: 'EACCES' })
    return previous(source, target)
  }
  syncBuiltinESMExports()
  return () => {
    fs.renameSync = previous
    syncBuiltinESMExports()
  }
}

test('S2-T01：旧模式默认global，三来源与空custom正文独立存储且不回退旧文件', async () => {
  const item = await fixture()
  await writeFile(join(item.agentDir, 'GLOBAL_APPEND_SYSTEM.md'), '不应读取的旧正文')
  assert.equal(await item.store.resolvePrompt(null), '')
  await item.store.replace({ old: { name: '历史模式', tools: { deny: ['bash'] } } })
  await item.store.replaceGlobalPrompt('全局追加\r\n  保留空格\n')
  assert.equal(await item.store.resolvePrompt('old'), '全局追加\r\n  保留空格\n')
  const modes = {
    old: item.store.read().old,
    none: { name: '不追加', promptSource: 'none' },
    custom: { name: '独立空正文', promptSource: 'custom' },
    global: { name: '沿用全局', promptSource: 'global' }
  }
  await item.store.replace(modes, { custom: '' })
  assert.equal(await item.store.resolvePrompt('none'), '')
  assert.equal(await item.store.resolvePrompt('custom'), '')
  assert.equal(await item.store.readPrompt('old'), '')
  assert.equal(await item.store.resolvePrompt('global'), await item.store.readPrompt())
  assert.deepEqual(parseYaml(await readFile(item.yaml, 'utf8'))['pi-desk']['capability-modes'], {
    modes
  })
  assert.deepEqual(new L4CapabilityModesStore(item.agentDir).read(), modes)
  assert.equal(
    await readFile(join(item.agentDir, 'GLOBAL_APPEND_SYSTEM.md'), 'utf8'),
    '不应读取的旧正文'
  )
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T01：首次custom未提交正文初始化空文件，既有custom缺失不可借保存元数据静默修复', async () => {
  const item = await fixture()
  await item.store.replace({ direct: { name: '新建独立正文', promptSource: 'custom' } })
  assert.equal(await item.store.readPrompt('direct'), '')
  await item.store.replace({
    ...item.store.read(),
    switched: { name: '从全局切换', promptSource: 'global' }
  })
  await item.store.replace({
    ...item.store.read(),
    switched: { name: '从全局切换', promptSource: 'custom' }
  })
  assert.equal(await item.store.resolvePrompt('switched'), '')
  await rm(join(item.prompts, 'modes'), { recursive: true })
  await assert.rejects(item.store.replace(item.store.read()), /自定义提示词文件缺失/u)
  await item.store.replace(item.store.read(), { direct: '', switched: '' })
  assert.equal(await item.store.readPrompt('direct'), '')
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T02：原始Key稳定散列为安全文件名，大小写不碰撞，custom缺失或非普通文件明确失败', async () => {
  const item = await fixture()
  const key = '../A\\目录:模式'
  const lower = '../a\\目录:模式'
  const body = '中文正文\r\n\n' + '保留  Markdown\n'.repeat(1000)
  await item.store.replace(
    {
      [key]: { name: '大写', promptSource: 'custom' },
      [lower]: { name: '小写', promptSource: 'custom' }
    },
    { [key]: body, [lower]: '另一份' }
  )
  const directory = join(item.prompts, 'modes')
  const files = await readdir(directory)
  assert.equal(files.length, 2)
  assert.ok(files.every((filename) => /^[a-f0-9]{64}\.md$/u.test(filename)))
  assert.equal(await item.store.readPrompt(key), body)
  assert.equal(await item.store.resolvePrompt(lower), '另一份')
  await assert.rejects(item.store.readPrompt('../../unknown'), /能力模式不存在/u)
  assert.throws(() => item.store.replace({ '': { name: '非法Key' } }))
  const target = files.find(
    (filename) => fs.readFileSync(join(directory, filename), 'utf8') === body
  )
  await rm(join(directory, target))
  await assert.rejects(item.store.readPrompt(key), /自定义提示词文件缺失/u)
  await assert.rejects(item.store.resolvePrompt(key), /自定义提示词文件缺失/u)
  await mkdir(join(directory, target))
  await assert.rejects(item.store.readPrompt(key), /非普通配置文件/u)
  await rm(join(directory, target), { recursive: true })
  await item.store.replace(item.store.read(), { [key]: '' })
  assert.equal(await item.store.resolvePrompt(key), '')
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T03：正文或YAML发布失败回滚本次涉及文件，成功通知只在完整保存后发生', async () => {
  const item = await fixture()
  const modes = {
    first: { name: '第一项', promptSource: 'custom' },
    second: { name: '第二项', promptSource: 'custom' }
  }
  await item.store.replace(modes, { first: '原第一项', second: '原第二项' })
  await item.store.replaceGlobalPrompt('独立全局')
  let notifications = 0
  const unsubscribe = item.store.subscribe(() => {
    notifications += 1
  })
  const yaml = await readFile(item.yaml, 'utf8')
  const directory = join(item.prompts, 'modes')
  const files = await readdir(directory)
  const secondFile = files.find(
    (file) => fs.readFileSync(join(directory, file), 'utf8') === '原第二项'
  )
  let failed = false
  let restore = failRename((target) => {
    if (target.endsWith(secondFile) && !failed) {
      failed = true
      return true
    }
    return false
  })
  try {
    await assert.rejects(
      item.store.replace(modes, { first: '第一项草稿', second: '第二项草稿' }),
      /原子写入/u
    )
  } finally {
    restore()
  }
  assert.equal(await item.store.readPrompt('first'), '原第一项')
  assert.equal(await item.store.readPrompt('second'), '原第二项')
  assert.equal(await readFile(item.yaml, 'utf8'), yaml)
  assert.equal(notifications, 0)

  failed = false
  restore = failRename((target) => {
    if (target === item.yaml && !failed) {
      failed = true
      return true
    }
    return false
  })
  try {
    await assert.rejects(
      item.store.replace(
        { ...modes, added: { name: '新模式', promptSource: 'custom' } },
        { first: '新第一项', added: '新文件' }
      ),
      /原子写入/u
    )
  } finally {
    restore()
  }
  assert.equal(await item.store.readPrompt('first'), '原第一项')
  assert.equal((await readdir(directory)).length, 2)
  assert.deepEqual(item.store.read(), modes)
  assert.equal(notifications, 0)
  await item.store.replace(modes, { first: '显式重试' })
  assert.equal(await item.store.readPrompt('second'), '原第二项')
  assert.equal(await item.store.readPrompt(), '独立全局')
  assert.equal(notifications, 1)
  unsubscribe()
  await item.store.replaceGlobalPrompt('新全局')
  assert.equal(notifications, 1)
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T03：回滚也失败时明确报告不完整状态，不发布成功，后续显式重存可修复', async () => {
  const item = await fixture()
  const modes = { current: { name: '当前模式', promptSource: 'custom' } }
  await item.store.replace(modes, { current: '原正文' })
  let notifications = 0
  item.store.subscribe(() => {
    notifications += 1
  })
  let bodyWrites = 0
  const restore = failRename((target) => {
    if (target === item.yaml) return true
    if (target.endsWith('.md')) {
      bodyWrites += 1
      return bodyWrites > 1
    }
    return false
  })
  try {
    await assert.rejects(
      item.store.replace(modes, { current: '已发布的新正文' }),
      /局部回滚未完成/u
    )
  } finally {
    restore()
  }
  assert.equal(notifications, 0)
  assert.equal(await item.store.readPrompt('current'), '已发布的新正文')
  await item.store.replace(modes, { current: '显式修复' })
  assert.equal(await item.store.readPrompt('current'), '显式修复')
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T03：删除后YAML失败恢复正文和默认引用，全局正文发布失败保留旧值', async () => {
  const item = await fixture()
  const modes = { current: { name: '当前模式', promptSource: 'custom' } }
  await item.store.replace(modes, { current: '删除前正文' })
  await item.store.replaceDefault({ cwd: null, defaultMode: 'current' })
  await item.store.replaceGlobalPrompt('原全局正文')
  let notifications = 0
  item.store.subscribe(() => {
    notifications += 1
  })
  let restore = failRename((target) => target === item.yaml)
  try {
    await assert.rejects(item.store.replace({}), /原子写入/u)
  } finally {
    restore()
  }
  assert.deepEqual(item.store.read(), modes)
  assert.equal(await item.store.readPrompt('current'), '删除前正文')
  assert.deepEqual(await item.store.readDefault(null), { defaultMode: 'current' })
  restore = failRename((target) => target.endsWith('global-append.md'))
  try {
    await assert.rejects(item.store.replaceGlobalPrompt('失败的全局草稿'), /原子写入/u)
  } finally {
    restore()
  }
  assert.equal(await item.store.readPrompt(), '原全局正文')
  assert.equal(notifications, 0)
  await rm(item.root, { recursive: true, force: true })
})

test('S2-T04：改名不换文件，切来源保留正文，复制独立，删除只清目标和全局默认', async () => {
  const item = await fixture()
  await item.store.replace(
    { current: { name: '原名称', promptSource: 'custom' } },
    { current: '原正文' }
  )
  const directory = join(item.prompts, 'modes')
  const files = await readdir(directory)
  await item.store.replaceDefault({ cwd: null, defaultMode: 'current' })
  await item.store.replace({ current: { name: '新名称', promptSource: 'none' } })
  assert.deepEqual(await readdir(directory), files)
  assert.equal(await item.store.readPrompt('current'), '原正文')
  await item.store.replace({ current: { name: '新名称', promptSource: 'global' } })
  assert.equal(await item.store.readPrompt('current'), '原正文')
  await item.store.replace(
    {
      current: { name: '新名称', promptSource: 'custom' },
      copy: { name: '副本', promptSource: 'custom' }
    },
    { copy: await item.store.readPrompt('current') }
  )
  await item.store.replace(item.store.read(), { current: '独立修改' })
  assert.equal(await item.store.readPrompt('copy'), '原正文')
  await item.store.replace({ copy: item.store.read().copy })
  assert.equal((await readdir(directory)).length, 1)
  assert.equal(await item.store.readPrompt('copy'), '原正文')
  assert.deepEqual(await item.store.readDefault(null), { defaultMode: null })
  await assert.rejects(
    item.store.replace(item.store.read(), { unknown: '不得写入' }),
    /能力模式不存在/u
  )
  await rm(item.root, { recursive: true, force: true })
})

test('同Owner并发保存串行，读取只看到完整提交后的正文，单纯默认修改不广播', async () => {
  const item = await fixture()
  let notifications = 0
  item.store.subscribe(() => {
    notifications += 1
  })
  const save = item.store.replace(
    { custom: { name: '独立正文', promptSource: 'custom' } },
    { custom: '完整正文' }
  )
  const global = item.store.replaceGlobalPrompt('全局正文')
  const read = item.store.resolvePrompt('custom')
  await Promise.all([save, global])
  assert.equal(await read, '完整正文')
  assert.equal(notifications, 2)
  await item.store.replaceDefault({ cwd: null, defaultMode: 'custom' })
  assert.equal(notifications, 2)
  assert.equal(await item.store.resolvePrompt(null), '全局正文')
  await rm(item.root, { recursive: true, force: true })
})
