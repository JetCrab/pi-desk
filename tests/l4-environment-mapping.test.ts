import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertEnvironmentEntryPath,
  assertEnvironmentTargetPaths,
  environmentPathKey,
  environmentTargetPathKey,
  mapEnvironmentPath,
  normalizeEnvironmentPath
} from '../src/server/l4_foundation/environment/l4-environment-paths.ts'
import {
  convertEnvironmentSessionLine,
  type EnvironmentSessionConversion
} from '../src/server/l4_foundation/environment/l4-environment-sessions.ts'

test('源平台解析盘符、UNC与最长目录前缀，不依赖当前运行平台', () => {
  const mappings = [
    { source: 'C:\\Users\\Tester', target: '/home/tester' },
    { source: 'c:\\users\\tester\\project', target: '/srv/project' },
    { source: '\\\\Server\\Share', target: '/mnt/share' }
  ]
  assert.equal(
    mapEnvironmentPath('C:/USERS/Tester/project/src/a.ts', mappings, 'win32', 'posix'),
    '/srv/project/src/a.ts'
  )
  assert.equal(
    mapEnvironmentPath('C:\\Users\\Tester\\project-other', mappings, 'win32', 'posix'),
    '/home/tester/project-other'
  )
  assert.equal(mapEnvironmentPath('C:\\Users\\Tester2\\file', mappings, 'win32', 'posix'), null)
  assert.equal(
    mapEnvironmentPath('\\\\SERVER\\share\\Folder\\file', mappings, 'win32', 'posix'),
    '/mnt/share/Folder/file'
  )
  assert.equal(environmentPathKey('C:\\Users\\TESTER\\', 'win32'), 'c:\\users\\tester')
  assert.equal(mapEnvironmentPath('..\\assets\\a.png', [], 'win32', 'posix'), '../assets/a.png')
  assert.equal(mapEnvironmentPath('../assets/a.png', [], 'posix', 'win32'), '..\\assets\\a.png')
  assert.throws(() => normalizeEnvironmentPath('C:relative', 'win32'))
  assert.throws(() => normalizeEnvironmentPath('\\rooted', 'win32'))
  assert.throws(() => normalizeEnvironmentPath('\\\\?\\C:\\device', 'win32'))
})

test('POSIX到Windows映射区分大小写并拒绝目标非法名称', () => {
  const mappings = [{ source: '/home/tester', target: 'D:\\Users\\Tester' }]
  assert.equal(
    mapEnvironmentPath('/home/tester/project/a', mappings, 'posix', 'win32'),
    'D:\\Users\\Tester\\project\\a'
  )
  assert.equal(mapEnvironmentPath('/Home/tester/project', mappings, 'posix', 'win32'), null)
  assert.equal(mapEnvironmentPath('/home/tester2/project', mappings, 'posix', 'win32'), null)
  for (const name of ['CON.txt', 'NUL', 'file:stream', 'trailing.', 'space ', 'a\\b']) {
    assert.throws(() => mapEnvironmentPath(`/home/tester/${name}`, mappings, 'posix', 'win32'))
  }
})

test('归档路径拒绝别名和穿越，目标检查覆盖隐式目录大小写及文件目录冲突', () => {
  for (const path of [
    '/abs',
    '../outside',
    'a/../../outside',
    'a/../b',
    'a//b',
    'a/./b',
    'C:/file',
    'C:file',
    '\\\\server\\share',
    'a\\..\\b',
    'a\0b',
    'a/'
  ]) {
    assert.throws(() => assertEnvironmentEntryPath(path), path)
  }
  assert.doesNotThrow(() => assertEnvironmentTargetPaths(['A/x', 'a/y'], 'posix'))
  for (const paths of [
    ['A/x', 'a/y'],
    ['x', 'x'],
    ['x', 'x/y'],
    ['x/y', 'x'],
    ['folder/NUL.txt']
  ]) {
    assert.throws(() => assertEnvironmentTargetPaths(paths, 'win32'))
  }
  assert.doesNotThrow(() => assertEnvironmentTargetPaths(['folder/a', 'folder/b'], 'win32'))
})

const conversion: EnvironmentSessionConversion = {
  sourcePlatform: 'win32',
  targetPlatform: 'posix',
  sourceSessionFile: 'C:\\agent\\sessions\\parent.jsonl',
  targetSessionFile: '/agent/sessions/parent.jsonl',
  projectMappings: [{ source: 'C:\\work', target: '/srv/work' }],
  sessionFileMappings: [
    { source: 'C:\\agent\\sessions\\parent.jsonl', target: '/agent/sessions/parent.jsonl' },
    { source: 'C:\\agent\\sessions\\child.jsonl', target: '/agent/sessions/child.jsonl' }
  ]
}

function convert(
  entry: unknown,
  options = conversion
): { entry: unknown; missingReferences: unknown[] } {
  const result = convertEnvironmentSessionLine(JSON.stringify(entry), options)
  return { entry: JSON.parse(result.line), missingReferences: result.missingReferences }
}

test('JSONL父子会话使用独立文件映射，保留所有ID和历史正文与工具参数', () => {
  const header = {
    type: 'session',
    id: 'child-id',
    cwd: 'C:\\work\\project',
    parentSession: 'C:\\AGENT\\sessions\\parent.jsonl',
    version: 3
  }
  assert.deepEqual(convert(header), {
    entry: { ...header, cwd: '/srv/work/project', parentSession: '/agent/sessions/parent.jsonl' },
    missingReferences: []
  })
  const history =
    '  { "type":"message", "id":"entry-id", "parentId":"parent-entry", "message":{"role":"assistant","content":[{"type":"text","text":"C:\\\\work\\\\project"},{"type":"toolCall","id":"tool-id","name":"bash","arguments":{"command":"echo C:\\\\agent"}}]}}  '
  assert.equal(convertEnvironmentSessionLine(history, conversion).line, history)
  const tool = {
    type: 'message',
    id: 'entry',
    parentId: 'previous',
    message: {
      role: 'toolResult',
      toolName: 'agent',
      toolCallId: 'call',
      content: [{ type: 'text', text: 'C:\\agent\\sessions\\child.jsonl' }],
      details: {
        sessionFile: 'C:\\agent\\sessions\\child.jsonl',
        taskId: 'child-id',
        title: 'C:\\work'
      }
    }
  }
  for (const toolName of ['agent', 'agent_resume']) {
    const original = { ...tool, message: { ...tool.message, toolName } }
    assert.deepEqual(convert(original).entry, {
      ...original,
      message: {
        ...original.message,
        details: { ...original.message.details, sessionFile: '/agent/sessions/child.jsonl' }
      }
    })
  }
  const childHeader = {
    type: 'session',
    id: 'child',
    cwd: 'C:\\work',
    parentSession: 'parent.jsonl'
  }
  assert.equal(
    (convert(childHeader).entry as Record<string, unknown>).parentSession,
    'parent.jsonl'
  )
})

test('JSONL仅转换当前公开子代理结构并报告未打包引用', () => {
  const child = 'C:\\agent\\sessions\\child.jsonl'
  for (const kind of ['launch', 'state']) {
    const entry = {
      type: 'custom',
      id: 'id',
      customType: `pi-desk-subagent:${kind}:v1`,
      data: { sessionFile: child, taskId: 'unchanged' }
    }
    assert.deepEqual(convert(entry).entry, {
      ...entry,
      data: { ...entry.data, sessionFile: '/agent/sessions/child.jsonl' }
    })
  }
  const entry = {
    type: 'custom_message',
    customType: 'pi-desk-subagent:completion:v1',
    content: child,
    details: { sessionFile: child, taskId: 'same' }
  }
  assert.deepEqual(convert(entry).entry, {
    ...entry,
    details: { ...entry.details, sessionFile: '/agent/sessions/child.jsonl' }
  })
  const historical = ` { "type": "custom", "customType": "pi-super-subagent:launch:v1", "data": { "sessionFile": "C:/agent/sessions/child.jsonl" } } `
  assert.deepEqual(convertEnvironmentSessionLine(historical, conversion), {
    line: historical,
    missingReferences: []
  })
  const research = {
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'research_delegate',
      details: {
        version: 1,
        workers: [
          { taskId: 'worker', sessionFile: child },
          { taskId: null, sessionFile: null }
        ]
      }
    }
  }
  assert.deepEqual(convert(research).entry, {
    ...research,
    message: {
      ...research.message,
      details: {
        ...research.message.details,
        workers: [
          { taskId: 'worker', sessionFile: '/agent/sessions/child.jsonl' },
          { taskId: null, sessionFile: null }
        ]
      }
    }
  })
  const unknown = {
    type: 'message',
    message: {
      role: 'toolResult',
      toolName: 'deliver',
      details: { sessionFile: child, outputPath: 'C:\\deliverables\\file' }
    }
  }
  assert.deepEqual(convert(unknown).entry, unknown)
  const missing = {
    type: 'session',
    cwd: 'D:\\external',
    parentSession: 'C:\\agent\\sessions\\external.jsonl',
    id: 'same'
  }
  assert.deepEqual(convert(missing), {
    entry: missing,
    missingReferences: [
      { kind: 'project', path: missing.cwd },
      { kind: 'session', path: missing.parentSession }
    ]
  })
})

test('Linux到darwin目标拒绝大小写和Unicode规范等价覆盖，Linux比较仍区分', () => {
  const source = ['/source/Foo.json', '/source/foo.json']
  const mapped = source.map((path) =>
    mapEnvironmentPath(path, [{ source: '/source', target: '/target' }], 'posix', 'posix')!
  )
  assert.doesNotThrow(() =>
    assertEnvironmentTargetPaths(
      mapped.map((path) => path.slice('/target/'.length)),
      'posix',
      'posix'
    )
  )
  assert.throws(
    () =>
      assertEnvironmentTargetPaths(
        mapped.map((path) => path.slice('/target/'.length)),
        'posix',
        'darwin'
      ),
    /大小写|规范等价/
  )
  assert.throws(
    () =>
      assertEnvironmentTargetPaths(
        ['config/Caf\u00e9.json', 'config/Cafe\u0301.json'],
        'posix',
        'darwin'
      ),
    /规范等价/
  )
  assert.throws(
    () => assertEnvironmentTargetPaths(['Folder/a.json', 'folder/b.json'], 'posix', 'darwin'),
    /大小写/
  )
  assert.equal(
    environmentTargetPathKey('/target/Foo.json', 'posix', 'darwin'),
    environmentTargetPathKey('/target/foo.json', 'posix', 'darwin')
  )
  assert.deepEqual(source, ['/source/Foo.json', '/source/foo.json'])
})

test('JSONL反向转换POSIX到Windows保留相对引用基准', () => {
  const options: EnvironmentSessionConversion = {
    sourcePlatform: 'posix',
    targetPlatform: 'win32',
    sourceSessionFile: '/agent/sessions/sub/child.jsonl',
    targetSessionFile: 'D:\\agent\\sessions\\sub\\child.jsonl',
    projectMappings: [{ source: '/srv/work', target: 'E:\\work' }],
    sessionFileMappings: [
      { source: '/agent/sessions/parent.jsonl', target: 'D:\\agent\\sessions\\parent.jsonl' }
    ]
  }
  const header = {
    type: 'session',
    id: 'same',
    cwd: '/srv/work/p',
    parentSession: '../parent.jsonl'
  }
  assert.deepEqual(convert(header, options).entry, {
    ...header,
    cwd: 'E:\\work\\p',
    parentSession: '..\\parent.jsonl'
  })
})
