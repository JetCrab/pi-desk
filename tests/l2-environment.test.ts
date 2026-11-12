import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildL2EnvironmentImport,
  L2_ENVIRONMENT_OPERATION_STORAGE_KEY,
  L2EnvironmentRuntime
} from '../src/client/l2_biz/environment/l2-environment-runtime'
import {
  createL2EnvironmentBiz,
  L2EnvironmentRequestError,
  type L2EnvironmentBiz
} from '../src/client/l2_biz/environment/l2-environment-biz'
import type {
  L2EnvironmentItem,
  L2EnvironmentImportRequest,
  L2EnvironmentOperation,
  L2EnvironmentPreviewResponse
} from '../src/common/l2_biz/environment/l2-environment-contract'

const id = '11111111-1111-4111-8111-111111111111'
const item = (
  key: string,
  category: L2EnvironmentItem['category'],
  sourceCwd: string | null
): L2EnvironmentItem => ({
  id: key,
  category,
  sourceCwd,
  title: key,
  files: 1,
  bytes: 4,
  sessionId: category === 'session' ? key : null,
  mappingSources: [],
  conflicts: [],
  warnings: []
})
const preview: L2EnvironmentPreviewResponse = {
  id,
  sourcePlatform: 'win32',
  warnings: [],
  items: [
    item('config', 'config', 'C:\\old-config'),
    item('plugin', 'plugin-data', 'C:\\old-plugin'),
    item('root-a', 'session', 'C:\\project-a'),
    item('root-b', 'session', 'C:\\project-a'),
    item('root-c', 'session', 'C:\\project-b')
  ]
}
const operation = (
  status: L2EnvironmentOperation['status'] = 'running'
): L2EnvironmentOperation => ({
  id,
  kind: 'export',
  status,
  phase: 'snapshot',
  error: null,
  warnings: [],
  expiresAt: Date.now() + 60_000
})
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fixture(
  overrides: Partial<L2EnvironmentBiz> = {},
  storage: ConstructorParameters<typeof L2EnvironmentRuntime>[1] = null
): {
  runtime: L2EnvironmentRuntime
  cancelled: string[]
} {
  const cancelled: string[] = []
  const biz: L2EnvironmentBiz = {
    get: async () => ({ canRestart: true, desktopAvailable: false }),
    export: async () => ({ id }),
    upload: async () => ({ id }),
    preview: async () => preview,
    import: async () => ({ id }),
    getOperation: async () => operation('ready'),
    download: async () => new Blob(['encrypted']),
    cancel: async (value) => {
      cancelled.push(value)
      return {}
    },
    browse: async () => ({ cwd: '/target', parentCwd: '/', directories: [] }),
    ...overrides
  }
  return { runtime: new L2EnvironmentRuntime(biz, storage), cancelled }
}
function handleStorage(): {
  values: Map<string, string>
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
} {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value)
    },
    removeItem: (key) => {
      values.delete(key)
    }
  }
}

async function prepare(runtime: L2EnvironmentRuntime): Promise<void> {
  await runtime.load()
  runtime.setFile(new File(['encrypted'], 'backup.pidesk'))
  runtime.editPassword('test-password')
  await runtime.preview()
}

test('选择类别与部分根会话互不污染；纯配置、纯会话及组合映射只包含所选来源', () => {
  const targets = {
    'C:\\old-config': '/config',
    'C:\\project-a': '/a',
    'C:\\project-b': '/b',
    'C:\\old-plugin': '/plugin'
  }
  assert.deepEqual(buildL2EnvironmentImport(preview, ['config'], targets, false), {
    id,
    selectedIds: ['config'],
    mappings: [{ from: 'C:\\old-config', to: '/config' }],
    overwrite: false
  })
  assert.deepEqual(buildL2EnvironmentImport(preview, ['root-a', 'root-b'], targets, false), {
    id,
    selectedIds: ['root-a', 'root-b'],
    mappings: [{ from: 'C:\\project-a', to: '/a' }],
    overwrite: false
  })
  assert.deepEqual(
    buildL2EnvironmentImport(preview, ['config', 'plugin', 'root-c', 'unknown'], targets, true),
    {
      id,
      selectedIds: ['config', 'plugin', 'root-c'],
      mappings: [
        { from: 'C:\\old-config', to: '/config' },
        { from: 'C:\\old-plugin', to: '/plugin' },
        { from: 'C:\\project-b', to: '/b' }
      ],
      overwrite: true
    }
  )
})

test('默认仅选择配置，关闭一个类别不移除已选根会话，未映射和冲突默认阻止应用', async () => {
  let imports = 0
  const conflictingPreview = {
    ...preview,
    items: preview.items.map((value) =>
      value.id === 'config' ? { ...value, conflicts: ['existing.json'] } : value
    )
  }
  const { runtime } = fixture({
    preview: async () => conflictingPreview,
    import: async () => {
      imports += 1
      return { id }
    }
  })
  try {
    await prepare(runtime)
    assert.deepEqual(runtime.getSnapshot().selectedIds, ['config'])
    runtime.select(['root-a'], true)
    runtime.select(['config'], false)
    assert.deepEqual(runtime.getSnapshot().selectedIds, ['root-a'])
    await runtime.apply()
    assert.equal(imports, 0)
    runtime.select(['root-a'], false)
    runtime.select(['config'], true)
    runtime.setTarget('C:\\old-config', '/target-config')
    await runtime.apply()
    assert.equal(imports, 0)
    await runtime.preview()
    runtime.setOverwrite(true)
    await runtime.apply()
    assert.equal(imports, 1)
    assert.equal(runtime.getSnapshot().preview, null)
  } finally {
    runtime.dispose()
  }
})

test('导出失败保留密码和选项；读取能力或等待异步结束不会自动重放start', async () => {
  let calls = 0
  const { runtime } = fixture({
    export: async () => {
      calls += 1
      throw new Error('service disconnected')
    }
  })
  try {
    await runtime.load()
    runtime.editExport({
      password: 'test-password',
      confirmation: 'test-password',
      includeSessions: true
    })
    await runtime.export()
    await settle()
    await runtime.load()
    assert.equal(calls, 1)
    assert.equal(runtime.getSnapshot().exportDraft.password, 'test-password')
    assert.equal(runtime.getSnapshot().exportDraft.includeSessions, true)
    assert.equal(runtime.getSnapshot().notice, 'unknown-outcome')
  } finally {
    runtime.dispose()
  }
})

test('应用HTTP失败保留选择、映射和密码；不自动重放import', async () => {
  let calls = 0
  const { runtime } = fixture({
    import: async () => {
      calls += 1
      throw new Error('connection lost')
    }
  })
  try {
    await prepare(runtime)
    runtime.setTarget('C:\\old-config', '/config')
    await runtime.preview()
    await runtime.apply()
    await settle()
    assert.equal(calls, 1)
    assert.equal(runtime.getSnapshot().error, 'connection lost')
    assert.equal(runtime.getSnapshot().password, 'test-password')
    assert.deepEqual(runtime.getSnapshot().selectedIds, ['config'])
    assert.deepEqual(runtime.getSnapshot().targets, { 'C:\\old-config': '/config' })
    assert.equal(runtime.getSnapshot().preview?.id, id)
  } finally {
    runtime.dispose()
  }
})

test('不支持受管重启时仍可预览，但不会发出export/import', async () => {
  let starts = 0
  const { runtime } = fixture({
    get: async () => ({ canRestart: false, desktopAvailable: false }),
    export: async () => {
      starts += 1
      return { id }
    },
    import: async () => {
      starts += 1
      return { id }
    }
  })
  try {
    await prepare(runtime)
    runtime.setTarget('C:\\old-config', '/config')
    await runtime.preview()
    runtime.editExport({ password: 'test-password', confirmation: 'test-password' })
    await runtime.export()
    await runtime.apply()
    assert.equal(starts, 0)
    assert.ok(runtime.getSnapshot().preview)
  } finally {
    runtime.dispose()
  }
})

test('源文件变化清理旧预览、勾选、映射和覆盖许可，卸载清理临时预览', async () => {
  const { runtime, cancelled } = fixture()
  await prepare(runtime)
  runtime.select(['root-a'], true)
  runtime.setTarget('C:\\project-a', '/a')
  runtime.setTarget('C:\\old-config', '/config')
  await runtime.preview()
  runtime.setOverwrite(true)
  assert.equal(runtime.getSnapshot().overwrite, true)
  runtime.setFile(new File(['new'], 'new.pidesk'))
  await settle()
  assert.deepEqual(cancelled, [id])
  assert.equal(runtime.getSnapshot().preview, null)
  assert.deepEqual(runtime.getSnapshot().selectedIds, [])
  assert.deepEqual(runtime.getSnapshot().targets, {})
  assert.equal(runtime.getSnapshot().overwrite, false)
  await runtime.preview()
  runtime.dispose()
  await settle()
  assert.deepEqual(cancelled, [id, id])
  assert.equal(runtime.getSnapshot().password, '')
})

test('卸载中止上传与目录查询；迟到上传结果只清理、不恢复旧预览', async () => {
  let uploadSignal: AbortSignal | null = null
  let browseSignal: AbortSignal | null = null
  let resolveUpload: ((value: { id: string }) => void) | undefined
  const { runtime, cancelled } = fixture({
    upload: (_file, signal) => {
      uploadSignal = signal
      return new Promise((resolve) => {
        resolveUpload = resolve
      })
    },
    browse: (_cwd, signal) => {
      browseSignal = signal
      return new Promise(() => undefined)
    }
  })
  await runtime.load()
  runtime.setFile(new File(['encrypted'], 'backup.pidesk'))
  runtime.editPassword('test-password')
  const pending = runtime.preview()
  void runtime.browse('C:\\project-a', null)
  runtime.dispose()
  assert.equal((uploadSignal as AbortSignal | null)?.aborted, true)
  assert.equal((browseSignal as AbortSignal | null)?.aborted, true)
  resolveUpload?.({ id })
  await pending
  assert.equal(runtime.getSnapshot().preview, null)
  assert.deepEqual(cancelled, [id])
})

test('任务查询串行且有界，重复点击查询不产生并发；卸载不cancel已开始任务', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let queries = 0
  const { runtime, cancelled } = fixture({
    getOperation: async () => {
      queries += 1
      return operation()
    }
  })
  try {
    await runtime.load()
    runtime.editExport({ password: 'test-password', confirmation: 'test-password' })
    await runtime.export()
    runtime.resumePolling()
    assert.equal(queries, 1)
    context.mock.timers.tick(2000)
    await settle()
    assert.equal(queries, 2)
    for (let count = 2; count < 300; count += 1) {
      context.mock.timers.tick(2000)
      await settle()
    }
    assert.equal(queries, 300)
    assert.equal(runtime.getSnapshot().notice, 'poll-stopped')
    context.mock.timers.tick(10_000)
    await settle()
    assert.equal(queries, 300)
    runtime.resumePolling()
    await settle()
    assert.equal(queries, 301)
    runtime.dispose()
    context.mock.timers.tick(10_000)
    await settle()
    assert.equal(queries, 301)
    assert.deepEqual(cancelled, [])
  } finally {
    runtime.dispose()
  }
})

test('查询失败只停止查询，显式继续只重查状态，不重发操作；仅ready可下载', async () => {
  let starts = 0
  let queries = 0
  let downloads = 0
  const { runtime } = fixture({
    export: async () => {
      starts += 1
      return { id }
    },
    getOperation: async () => {
      queries += 1
      if (queries === 1) throw new Error('restart')
      return operation('ready')
    },
    download: async () => {
      downloads += 1
      return new Blob(['encrypted'])
    }
  })
  try {
    await runtime.load()
    runtime.editExport({ password: 'test-password', confirmation: 'test-password' })
    await runtime.export()
    assert.equal(runtime.getSnapshot().notice, 'poll-stopped')
    assert.equal(await runtime.download(), null)
    runtime.resumePolling()
    await settle()
    assert.equal(starts, 1)
    assert.equal(queries, 2)
    assert.ok(await runtime.download())
    assert.equal(downloads, 1)
  } finally {
    runtime.dispose()
  }
})

test('binary上传发送原始File，下载发送JSON，均带页面身份并使用同源认证', async (context) => {
  const file = new File(['encrypted-bytes'], 'backup.pidesk')
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('X-Pi-Desk-Client-Id'), 'page-client')
    assert.equal(init.credentials, 'same-origin')
    if (path.endsWith('/upload')) {
      assert.equal(init.body, file)
      assert.equal(new Headers(init.headers).get('Content-Type'), 'application/octet-stream')
      return Response.json({ code: 0, msg: '', data: { id } })
    }
    assert.equal(path, '/api/environment/download')
    assert.deepEqual(JSON.parse(String(init.body)), { id })
    return new Response('encrypted-bytes', {
      headers: { 'Content-Type': 'application/octet-stream' }
    })
  })
  const biz = createL2EnvironmentBiz('page-client')
  assert.deepEqual(await biz.upload(file, new AbortController().signal), { id })
  assert.equal(
    await (await biz.download(id, new AbortController().signal)).text(),
    'encrypted-bytes'
  )
})

test('binary认证和业务失败不被当作可下载包或成功上传', async (context) => {
  const mock = context.mock.method(globalThis, 'fetch', async () =>
    Response.json({ code: 401, msg: '请先登录', data: null }, { status: 401 })
  )
  const biz = createL2EnvironmentBiz('page-client')
  await assert.rejects(biz.download(id, new AbortController().signal), /请先登录/)
  mock.mock.mockImplementation(async () => Response.json({ code: 3, msg: '文件无效', data: null }))
  await assert.rejects(
    biz.upload(new File(['bad'], 'bad'), new AbortController().signal),
    /文件无效/
  )
})

for (const kind of ['export', 'import'] as const) {
  test(`${kind}关闭再打开和刷新只恢复查询，sessionStorage只保存id且不含密码或预览`, async () => {
    const storage = handleStorage()
    let exports = 0
    let imports = 0
    let queries = 0
    const overrides: Partial<L2EnvironmentBiz> = {
      export: async () => {
        exports += 1
        return { id }
      },
      import: async () => {
        imports += 1
        return { id }
      },
      getOperation: async (queriedId) => {
        queries += 1
        assert.equal(queriedId, id)
        return { ...operation(), kind }
      }
    }
    const first = fixture(overrides, storage).runtime
    try {
      if (kind === 'import') {
        await prepare(first)
        first.setTarget('C:\\old-config', '/target-private-config')
        await first.preview()
        await first.apply()
      } else {
        await first.load()
        first.editExport({
          password: 'export-private-password',
          confirmation: 'export-private-password',
          includePluginData: true
        })
        await first.export()
      }
      assert.deepEqual([...storage.values], [[L2_ENVIRONMENT_OPERATION_STORAGE_KEY, id]])
    } finally {
      first.dispose()
    }
    assert.deepEqual([...storage.values], [[L2_ENVIRONMENT_OPERATION_STORAGE_KEY, id]])

    // 新实例分别模拟关闭后重开，以及刷新或重新登录后的区域挂载。
    for (let reopened = 0; reopened < 2; reopened += 1) {
      const runtime = fixture(overrides, storage).runtime
      try {
        runtime.start()
        await settle()
        assert.equal(runtime.getSnapshot().operation?.id, id)
        assert.equal(runtime.getSnapshot().operation?.kind, kind)
        assert.equal(runtime.getSnapshot().password, '')
        assert.equal(runtime.getSnapshot().exportDraft.password, '')
        assert.equal(runtime.getSnapshot().preview, null)
        assert.equal(runtime.getSnapshot().file, null)
        assert.deepEqual(runtime.getSnapshot().targets, {})
        assert.deepEqual(runtime.getSnapshot().selectedIds, [])
      } finally {
        runtime.dispose()
      }
    }
    assert.equal(queries, 3)
    assert.equal(exports, kind === 'export' ? 1 : 0)
    assert.equal(imports, kind === 'import' ? 1 : 0)
  })
}

for (const expired of ['404', 'expiresAt'] as const) {
  test(`查询句柄${expired}过期后清除，重新打开不再次查询也不提交任务`, async () => {
    const storage = handleStorage()
    storage.setItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY, id)
    let queries = 0
    let starts = 0
    const overrides: Partial<L2EnvironmentBiz> = {
      getOperation: async () => {
        queries += 1
        if (expired === '404') throw new L2EnvironmentRequestError(404, 'not found')
        return { ...operation('ready'), expiresAt: Date.now() - 1 }
      },
      export: async () => {
        starts += 1
        return { id }
      },
      import: async () => {
        starts += 1
        return { id }
      }
    }
    const runtime = fixture(overrides, storage).runtime
    try {
      runtime.start()
      await settle()
      assert.equal(runtime.getSnapshot().operationId, null)
      assert.equal(runtime.getSnapshot().notice, 'operation-expired')
      assert.equal(storage.values.size, 0)
    } finally {
      runtime.dispose()
    }
    const reopened = fixture(overrides, storage).runtime
    try {
      reopened.start()
      await settle()
      assert.equal(queries, 1)
      assert.equal(starts, 0)
    } finally {
      reopened.dispose()
    }
  })
}

test('认证失败保留查询句柄，重新登录后的挂载只查询已有操作', async () => {
  const storage = handleStorage()
  storage.setItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY, id)
  const unauthorized = fixture(
    {
      getOperation: async () => {
        throw new L2EnvironmentRequestError(401, '请先登录')
      }
    },
    storage
  ).runtime
  try {
    unauthorized.start()
    await settle()
    assert.equal(storage.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY), id)
    assert.equal(unauthorized.getSnapshot().notice, 'poll-stopped')
  } finally {
    unauthorized.dispose()
  }
  let starts = 0
  const authorized = fixture(
    {
      export: async () => {
        starts += 1
        return { id }
      },
      import: async () => {
        starts += 1
        return { id }
      }
    },
    storage
  ).runtime
  try {
    authorized.start()
    await settle()
    assert.equal(authorized.getSnapshot().operation?.status, 'ready')
    assert.equal(starts, 0)
    assert.equal(storage.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY), id)
  } finally {
    authorized.dispose()
  }
})

test('服务确认完成才清理import句柄，仍保留当前面板的真实完成状态', async () => {
  const storage = handleStorage()
  storage.setItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY, id)
  const { runtime } = fixture(
    { getOperation: async () => ({ ...operation('completed'), kind: 'import' }) },
    storage
  )
  try {
    runtime.start()
    await settle()
    assert.equal(storage.values.size, 0)
    assert.equal(runtime.getSnapshot().operation?.status, 'completed')
  } finally {
    runtime.dispose()
  }
})

test('下载失败保留句柄，下载请求成功结束后才清理；取消另一预览不影响已有句柄', async () => {
  const storage = handleStorage()
  let fail = true
  const { runtime } = fixture(
    {
      download: async () => {
        if (fail) throw new Error('download disconnected')
        return new Blob(['encrypted'])
      }
    },
    storage
  )
  try {
    await runtime.load()
    runtime.editExport({ password: 'private-password', confirmation: 'private-password' })
    await runtime.export()
    assert.equal(storage.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY), id)
    assert.equal(await runtime.download(), null)
    assert.equal(storage.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY), id)
    fail = false
    assert.ok(await runtime.download())
    assert.equal(storage.values.size, 0)

    const otherId = '22222222-2222-4222-8222-222222222222'
    storage.setItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY, otherId)
    await prepare(runtime)
    await runtime.cancelPreview()
    assert.equal(storage.getItem(L2_ENVIRONMENT_OPERATION_STORAGE_KEY), otherId)
  } finally {
    runtime.dispose()
  }
})

test('get-operation保留真实404状态，并携带页面身份和查询body', async (context) => {
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/environment/get-operation')
    assert.equal(init.method, 'POST')
    assert.equal(new Headers(init.headers).get('X-Pi-Desk-Client-Id'), 'page-client')
    assert.deepEqual(JSON.parse(String(init.body)), { id })
    return Response.json({ code: 404, msg: '任务已过期', data: null }, { status: 404 })
  })
  await assert.rejects(
    createL2EnvironmentBiz('page-client').getOperation(id, new AbortController().signal),
    (error: unknown) => error instanceof L2EnvironmentRequestError && error.status === 404
  )
})

test('纯配置合并全部声明来源与sourceCwd去重，预览按实际合同发送可选mappings', async (context) => {
  const configPreview: L2EnvironmentPreviewResponse = {
    ...preview,
    items: [
      {
        ...item('settings', 'config', null),
        mappingSources: ['/old/skills', '/old/prompts', '/old/skills']
      },
      { ...item('project-config', 'config', '/old/prompts'), mappingSources: ['/old/extensions'] },
      { ...item('unselected', 'plugin-data', '/old/plugin'), mappingSources: ['/old/private-data'] }
    ]
  }
  const input = buildL2EnvironmentImport(
    configPreview,
    ['settings', 'project-config'],
    {
      '/old/skills': '/target/skills',
      '/old/prompts': '/target/prompts',
      '/old/extensions': '/target/extensions',
      '/old/plugin': '/unused'
    },
    false
  )
  assert.deepEqual(input.mappings, [
    { from: '/old/skills', to: '/target/skills' },
    { from: '/old/prompts', to: '/target/prompts' },
    { from: '/old/extensions', to: '/target/extensions' }
  ])
  assert.deepEqual(input.selectedIds, ['settings', 'project-config'])
  context.mock.method(globalThis, 'fetch', async (path: string, init: RequestInit) => {
    assert.equal(path, '/api/environment/preview')
    assert.equal(new Headers(init.headers).get('X-Pi-Desk-Client-Id'), 'page-client')
    assert.deepEqual(JSON.parse(String(init.body)), {
      id,
      password: 'test-password',
      mappings: input.mappings
    })
    return Response.json({ code: 0, msg: '', data: configPreview })
  })
  const result = await createL2EnvironmentBiz('page-client').preview(
    { id, password: 'test-password', mappings: input.mappings },
    new AbortController().signal
  )
  assert.deepEqual(result.items[0]?.mappingSources, ['/old/skills', '/old/prompts', '/old/skills'])
})

test('映射改变立即使冲突与覆盖确认失效，显式更新复用暂存后才允许应用', async () => {
  let uploads = 0
  let previews = 0
  const imported: L2EnvironmentImportRequest[] = []
  const { runtime } = fixture({
    upload: async () => {
      uploads += 1
      return { id }
    },
    preview: async (input) => {
      previews += 1
      assert.equal(input.id, id)
      const target = input.mappings?.find((mapping) => mapping.from === 'C:\\old-config')?.to
      return {
        ...preview,
        items: preview.items.map((value) =>
          value.id === 'config'
            ? { ...value, conflicts: target ? [`${target}/existing.json`] : [] }
            : value
        )
      }
    },
    import: async (input) => {
      imported.push(input)
      return { id }
    }
  })
  try {
    await prepare(runtime)
    runtime.setTarget('C:\\old-config', '/first')
    await runtime.preview()
    assert.equal(runtime.getSnapshot().previewFresh, true)
    assert.deepEqual(runtime.getSnapshot().preview?.items[0]?.conflicts, ['/first/existing.json'])
    runtime.setOverwrite(true)
    assert.equal(runtime.getSnapshot().overwrite, true)

    runtime.setTarget('C:\\old-config', '/second')
    assert.equal(runtime.getSnapshot().previewFresh, false)
    assert.equal(runtime.getSnapshot().overwrite, false)
    runtime.setOverwrite(true)
    await runtime.apply()
    assert.equal(runtime.getSnapshot().overwrite, false)
    assert.equal(imported.length, 0)
    assert.equal(previews, 2)

    await runtime.preview()
    assert.equal(runtime.getSnapshot().previewFresh, true)
    assert.deepEqual(runtime.getSnapshot().preview?.items[0]?.conflicts, ['/second/existing.json'])
    assert.equal(runtime.getSnapshot().overwrite, false)
    await runtime.apply()
    assert.equal(imported.length, 0)
    runtime.setOverwrite(true)
    await runtime.apply()
    assert.deepEqual(imported, [
      {
        id,
        selectedIds: ['config'],
        mappings: [{ from: 'C:\\old-config', to: '/second' }],
        overwrite: true
      }
    ])
    assert.equal(uploads, 1)
    assert.equal(previews, 3)
  } finally {
    runtime.dispose()
  }
})

test('服务端root组更新预览即使重排也保留部分根会话选择及所有用户映射', async () => {
  let previews = 0
  const grouped: L2EnvironmentPreviewResponse = {
    ...preview,
    items: preview.items.map((value) =>
      value.id === 'root-a' ? { ...value, files: 3, mappingSources: ['C:\\child-project'] } : value
    )
  }
  const { runtime } = fixture({
    preview: async () => {
      previews += 1
      return previews === 1 ? grouped : { ...grouped, items: [...grouped.items].reverse() }
    }
  })
  try {
    await prepare(runtime)
    runtime.select(['root-a', 'root-b'], true)
    runtime.select(['root-c'], true)
    runtime.select(['root-b', 'config'], false)
    runtime.setTarget('C:\\old-config', '/kept-config-draft')
    runtime.setTarget('C:\\project-a', '/a')
    runtime.setTarget('C:\\project-b', '/b')
    runtime.setTarget('C:\\child-project', '/child')
    const targets = { ...runtime.getSnapshot().targets }
    await runtime.preview()
    assert.deepEqual(runtime.getSnapshot().selectedIds, ['root-a', 'root-c'])
    assert.deepEqual(runtime.getSnapshot().targets, targets)
    assert.equal(runtime.getSnapshot().previewFresh, true)
    const result = buildL2EnvironmentImport(
      runtime.getSnapshot().preview!,
      runtime.getSnapshot().selectedIds,
      runtime.getSnapshot().targets,
      false
    )
    assert.deepEqual([...result.selectedIds].sort(), ['root-a', 'root-c'])
    assert.deepEqual(result.mappings, [
      { from: 'C:\\project-b', to: '/b' },
      { from: 'C:\\project-a', to: '/a' },
      { from: 'C:\\child-project', to: '/child' }
    ])
  } finally {
    runtime.dispose()
  }
})

test('初始及更新预览失败保留文件密码选择映射，重试复用暂存且不自动import', async () => {
  let fail = true
  let uploads = 0
  let previews = 0
  let imports = 0
  const { runtime } = fixture({
    upload: async () => {
      uploads += 1
      return { id }
    },
    preview: async () => {
      previews += 1
      if (fail) throw new Error('preview disconnected')
      return preview
    },
    import: async () => {
      imports += 1
      return { id }
    }
  })
  try {
    await prepare(runtime)
    const file = runtime.getSnapshot().file
    assert.ok(file)
    assert.equal(runtime.getSnapshot().password, 'test-password')
    assert.equal(runtime.getSnapshot().error, 'preview disconnected')
    assert.equal(runtime.getSnapshot().preview, null)
    fail = false
    await runtime.preview()
    const oldPreview = runtime.getSnapshot().preview
    runtime.select(['root-a'], true)
    runtime.setTarget('C:\\old-config', '/config')
    runtime.setTarget('C:\\project-a', '/a')
    fail = true
    await runtime.preview()
    await runtime.apply()
    await settle()
    assert.equal(runtime.getSnapshot().file, file)
    assert.equal(runtime.getSnapshot().password, 'test-password')
    assert.equal(runtime.getSnapshot().preview, oldPreview)
    assert.deepEqual(runtime.getSnapshot().selectedIds, ['config', 'root-a'])
    assert.deepEqual(runtime.getSnapshot().targets, {
      'C:\\old-config': '/config',
      'C:\\project-a': '/a'
    })
    assert.equal(runtime.getSnapshot().previewFresh, false)
    assert.equal(runtime.getSnapshot().error, 'preview disconnected')
    assert.equal(imports, 0)
    assert.equal(previews, 3)
    assert.equal(uploads, 1)
    fail = false
    await runtime.preview()
    assert.equal(runtime.getSnapshot().previewFresh, true)
    assert.equal(imports, 0)
    assert.equal(uploads, 1)
  } finally {
    runtime.dispose()
  }
})
