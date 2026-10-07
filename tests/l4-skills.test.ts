import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  L2SkillFileGetRequestSchema,
  L2SkillFileReplaceRequestSchema
} from '../src/common/l2_biz/settings/l2-skills-contract'
import { selectL4LocalizedText } from '../src/common/l4_foundation/locale/l4-localized-text'
import {
  getL4SkillFile,
  listL4SkillFiles,
  listL4Skills,
  replaceL4SkillFile,
  L4SkillError
} from '../src/server/l4_foundation/skills/l4-skills'

async function fixture(
  context: test.TestContext
): Promise<{ root: string; agent: string; cwd: string; skill: string }> {
  const root = resolve('temp/pi/skills-unit', `${process.pid}-${randomUUID()}`)
  const agent = join(root, 'agent')
  const cwd = join(root, 'project')
  const skill = join(agent, 'skills', 'sample', 'SKILL.md')
  for (const dir of [
    agent,
    cwd,
    join(cwd, '.git'),
    join(root, 'home'),
    join(agent, 'sessions'),
    join(agent, 'skills', 'sample', 'references')
  ])
    await mkdir(dir, { recursive: true })
  const previous = {
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
    PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE
  }
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: agent,
    PI_CODING_AGENT_SESSION_DIR: join(agent, 'sessions'),
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home')
  })
  context.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(skill, '---\nname: sample\ndescription: test fixture\n---\n# Sample\n')
  await writeFile(join(agent, 'settings.json'), '{}')
  await writeFile(
    join(agent, 'skills', 'sample', 'references', 'check.md'),
    '\uFEFF# 原文\r\n第二行\r\n'
  )
  return { root, agent, cwd, skill }
}

function status(expected: number): (error: unknown) => boolean {
  return (error) => error instanceof L4SkillError && error.status === expected
}

test('项目对全局包的过滤仍归属于全局，不重复展示安装目录', async (context) => {
  const { root, agent, cwd } = await fixture(context)
  const packageRoot = join(root, 'shared-package')
  await mkdir(join(packageRoot, 'skills', 'shared'), { recursive: true })
  await mkdir(join(cwd, '.pi'), { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: 'shared-package', pi: { skills: ['skills'] } })
  )
  await writeFile(
    join(packageRoot, 'skills', 'shared', 'SKILL.md'),
    '---\nname: shared\ndescription: fixture\n---\n'
  )
  await writeFile(join(agent, 'settings.json'), JSON.stringify({ packages: [packageRoot] }))
  await writeFile(
    join(cwd, '.pi', 'settings.json'),
    JSON.stringify({
      packages: [{ source: packageRoot, autoload: false, skills: ['-skills/shared/SKILL.md'] }]
    })
  )
  assert.ok((await listL4Skills(null)).skills.some((item) => item.name === 'shared'))
  assert.deepEqual((await listL4Skills(cwd)).skills, [])
})

test('Skills 协议不接收会话身份、目录越界或缺失定位', () => {
  assert.equal(
    L2SkillFileGetRequestSchema.safeParse({
      cwd: null,
      skillPath: 'C:/skill/SKILL.md',
      path: '../secret'
    }).success,
    false
  )
  assert.equal(
    L2SkillFileGetRequestSchema.safeParse({
      cwd: null,
      skillPath: 'C:/skill/SKILL.md',
      path: '/secret'
    }).success,
    false
  )
  assert.equal(
    L2SkillFileReplaceRequestSchema.safeParse({
      cwd: null,
      skillPath: 'C:/skill/SKILL.md',
      path: 'SKILL.md',
      content: '',
      workId: 'extra'
    }).success,
    false
  )
  assert.equal(
    L2SkillFileReplaceRequestSchema.safeParse({
      cwd: null,
      skillPath: 'C:/skill/SKILL.md',
      path: 'SKILL.md',
      content: ''
    }).success,
    true
  )
})

test('全局和项目分开，保留同名、无效元信息与被配置排除的入口', async (context) => {
  const { agent, cwd } = await fixture(context)
  const local = join(cwd, '.pi', 'skills', 'sample')
  const invalid = join(agent, 'skills', 'invalid')
  const duplicate = join(agent, 'skills', 'duplicate')
  for (const dir of [local, invalid, duplicate]) await mkdir(dir, { recursive: true })
  await writeFile(
    join(local, 'SKILL.md'),
    '---\nname: project-only\ndescription: project fixture\n---\n'
  )
  await writeFile(join(invalid, 'SKILL.md'), '---\nname: invalid\n---\nmissing description')
  await writeFile(
    join(duplicate, 'SKILL.md'),
    '---\nname: sample\ndescription: duplicate fixture\n---\n'
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ skills: ['-skills/duplicate/SKILL.md'] })
  )
  const global = await listL4Skills(null)
  assert.equal(global.skills.filter((skill) => skill.name === 'sample').length, 2)
  assert.ok(global.skills.some((skill) => skill.skillPath.endsWith('/invalid/SKILL.md')))
  const piDiagnostic = global.diagnostics.find((item) => item.path.endsWith('/invalid/SKILL.md'))
  assert.ok(piDiagnostic)
  assert.ok(typeof piDiagnostic.message === 'string')
  assert.match(piDiagnostic.message, /description/i)
  const excludedDiagnostic = global.diagnostics.find((item) =>
    item.path.endsWith('/duplicate/SKILL.md')
  )
  assert.ok(excludedDiagnostic)
  assert.equal(
    selectL4LocalizedText(excludedDiagnostic.message, 'zh-CN'),
    '此资源已被 Pi 配置排除；仍可查看文件。'
  )
  assert.equal(
    selectL4LocalizedText(excludedDiagnostic.message, 'en'),
    'This resource is excluded by Pi configuration; its files are still available to view.'
  )
  assert.equal(
    global.skills.some((skill) => skill.name === 'project-only'),
    false
  )
  assert.deepEqual(
    (await listL4Skills(cwd)).skills.map((skill) => skill.name),
    ['project-only']
  )
})

test('使用 Pi manifest 与配置来源，缺失包不安装，扩展不执行', async (context) => {
  const { root, agent, cwd } = await fixture(context)
  const localPackage = join(root, 'local-package')
  await mkdir(join(localPackage, 'skills', 'packaged'), { recursive: true })
  await writeFile(
    join(localPackage, 'package.json'),
    JSON.stringify({
      name: 'local-package',
      pi: { skills: ['skills'], extensions: ['explode.ts'] }
    })
  )
  await writeFile(
    join(localPackage, 'explode.ts'),
    'throw new Error("Skills discovery must not execute extensions")'
  )
  await writeFile(
    join(localPackage, 'skills', 'packaged', 'SKILL.md'),
    '---\nname: packaged\ndescription: fixture\n---\n'
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ packages: [localPackage, 'git:https://invalid.example/missing-repo'] })
  )
  const global = await listL4Skills(null)
  const packaged = global.skills.find((item) => item.name === 'packaged')!
  assert.equal(packaged.packageSource, localPackage)
  const missingDiagnostic = global.diagnostics.find(
    (item) => item.path === 'git:https://invalid.example/missing-repo'
  )
  assert.ok(missingDiagnostic)
  assert.equal(
    selectL4LocalizedText(missingDiagnostic.message, 'zh-CN'),
    '包未安装或版本不匹配，已跳过；查看 Skills 不会自动安装包。'
  )
  assert.equal(
    selectL4LocalizedText(missingDiagnostic.message, 'en'),
    'Package not installed or version mismatch. Skills are not installed automatically.'
  )
  const file = await getL4SkillFile(null, packaged.skillPath, 'SKILL.md')
  assert.equal(file.kind === 'text' && file.readOnlyReason, null)
  assert.deepEqual((await listL4Skills(cwd)).skills, [])
  assert.equal((await readdir(agent)).includes('git'), false)
})

test('多文件目录按层读取，独立 md 不能浏览邻居，拒绝 symlink 越界', async (context) => {
  const { root, agent, skill } = await fixture(context)
  await writeFile(join(agent, 'skills', 'single.md'), '---\ndescription: single fixture\n---\n')
  const single = (await listL4Skills(null)).skills.find((item) =>
    item.skillPath.endsWith('/single.md')
  )!
  assert.deepEqual((await listL4SkillFiles(null, single.skillPath, '')).entries, [
    { name: 'single.md', type: 'file' }
  ])
  await assert.rejects(getL4SkillFile(null, single.skillPath, 'sample/SKILL.md'), status(400))
  assert.equal((await listL4SkillFiles(null, skill, '')).entries[0]?.name, 'SKILL.md')
  assert.deepEqual((await listL4SkillFiles(null, skill, 'references')).entries, [
    { name: 'check.md', type: 'file' }
  ])
  await mkdir(join(root, 'outside'), { recursive: true })
  await writeFile(join(root, 'outside', 'private.txt'), 'outside')
  await symlink(join(root, 'outside'), join(agent, 'skills', 'sample', 'external'), 'junction')
  await assert.rejects(getL4SkillFile(null, skill, 'external/private.txt'), status(400))
  await assert.rejects(replaceL4SkillFile(null, skill, 'external/private.txt', 'bad'), status(400))
  assert.equal(await readFile(join(root, 'outside', 'private.txt'), 'utf8'), 'outside')
})

test('保存保留 BOM、CRLF，串行写入后最后一次生效，无残留临时文件', async (context) => {
  const { agent, skill } = await fixture(context)
  const reference = join(agent, 'skills', 'sample', 'references', 'check.md')
  const originalMode = (await stat(reference)).mode & 0o777
  await replaceL4SkillFile(null, skill, 'references/check.md', '# 新内容\n中文\n')
  assert.equal((await stat(reference)).mode & 0o777, originalMode)
  assert.equal(
    await readFile(join(agent, 'skills', 'sample', 'references', 'check.md'), 'utf8'),
    '\uFEFF# 新内容\r\n中文\r\n'
  )
  await Promise.all([
    replaceL4SkillFile(null, skill, 'references/check.md', 'first\n'),
    replaceL4SkillFile(null, skill, 'references/check.md', 'second\n')
  ])
  assert.equal(
    await readFile(join(agent, 'skills', 'sample', 'references', 'check.md'), 'utf8'),
    '\uFEFFsecond\r\n'
  )
  assert.equal(
    (await readdir(join(agent, 'skills', 'sample', 'references'))).some((name) =>
      name.startsWith('.pi-desk-save-')
    ),
    false
  )
  await replaceL4SkillFile(null, skill, 'SKILL.md', 'unfinished metadata')
  assert.ok(
    (await listL4Skills(null)).skills.some((item) => item.skillPath.endsWith('/sample/SKILL.md'))
  )
  await assert.rejects(replaceL4SkillFile(null, skill, 'missing.md', 'do not create'), status(404))
})

test('managed npm 包与其本地链接只读，二进制和超大文本不能保存', async (context) => {
  const { agent, skill } = await fixture(context)
  const packageRoot = join(agent, 'npm', 'node_modules', '@fixture', 'skills')
  const packageSkill = join(packageRoot, 'skills', 'managed')
  await mkdir(packageSkill, { recursive: true })
  await writeFile(
    join(packageRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/skills', version: '1.0.0', pi: { skills: ['skills'] } })
  )
  await writeFile(join(packageSkill, 'SKILL.md'), '---\nname: managed\ndescription: fixture\n---\n')
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ packages: ['npm:@fixture/skills'] })
  )
  const managed = (await listL4Skills(null)).skills.find((item) => item.name === 'managed')!
  const file = await getL4SkillFile(null, managed.skillPath, 'SKILL.md')
  assert.ok(file.kind === 'text' && file.readOnlyReason)
  await assert.rejects(replaceL4SkillFile(null, managed.skillPath, 'SKILL.md', 'bad'), status(403))
  await symlink(packageSkill, join(agent, 'skills', 'alias'), 'junction')
  await assert.rejects(
    replaceL4SkillFile(null, join(agent, 'skills', 'alias', 'SKILL.md'), 'SKILL.md', 'bad'),
    (error) => error instanceof L4SkillError && [403, 404].includes(error.status)
  )
  await writeFile(join(agent, 'skills', 'sample', 'binary.dat'), Buffer.from([0, 255, 0]))
  assert.equal((await getL4SkillFile(null, skill, 'binary.dat')).kind, 'unsupported')
  await assert.rejects(replaceL4SkillFile(null, skill, 'binary.dat', 'bad'), status(400))
  await assert.rejects(
    replaceL4SkillFile(null, skill, 'SKILL.md', 'a'.repeat(5 * 1024 * 1024 + 1)),
    status(413)
  )
})
