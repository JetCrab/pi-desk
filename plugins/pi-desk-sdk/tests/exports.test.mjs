import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const [root, entry, session, browser, react, reactBase, reactMarkdown] = await Promise.all([
  import('../dist/index.js'),
  import('../dist/entry.js'),
  import('../dist/session.js'),
  import('../dist/browser.js'),
  import('../dist/react.js'),
  import('../dist/react-base.js'),
  import('../dist/react-markdown.js')
])

test('共享设置与错误入口不依赖Session且保留旧错误身份', async () => {
  const settings = await import('../dist/settings.js')
  const errors = await import('../dist/errors.js')
  assert.equal(root.PluginMethodError, errors.PluginMethodError)
  assert.equal(session.PluginMethodError, errors.PluginMethodError)
  assert.equal(root.HostSettingsSchema, settings.HostSettingsSchema)
  const snapshot = settings.HostSettingsSchema.parse({
    region: { locale: 'en', timeZone: 'America/New_York' }
  })
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.region))
  assert.equal(
    settings.HostSettingsSchema.safeParse({ region: { locale: 'en', timeZone: 'Invalid/Zone' } })
      .success,
    false
  )
  const compiled = await readFile(join(packageRoot, 'dist', 'errors.js'), 'utf8')
  assert.doesNotMatch(compiled, /node:|pi-coding-agent|react/)
})

test('根入口继续兼容 Session 与 Global API', () => {
  assert.equal(root.bindSessionPlugin, session.bindSessionPlugin)
  assert.equal(root.startTask, session.startTask)
  assert.equal(typeof root.definePiDeskPlugin, 'function')
  assert.equal(typeof root.PluginMethodError, 'function')
  assert.equal(typeof session.SESSION_PLUGIN_PUSH_EVENT, 'string')
})

test('definePiDeskPlugin 固定名称并保留 setup disposer', async () => {
  let disposed = false
  const definition = entry.definePiDeskPlugin({
    name: 'fixture-plugin',
    setup() {
      return () => {
        disposed = true
      }
    }
  })

  assert.equal(definition.name, 'fixture-plugin')
  assert.equal(Object.isFrozen(definition), true)
  const dispose = await definition.setup({})
  assert.equal(typeof dispose, 'function')
  await dispose()
  assert.equal(disposed, true)
  assert.throws(() =>
    entry.definePiDeskPlugin({
      name: 'Fixture Plugin',
      setup() {}
    })
  )
})

test('definePiDeskPlugin 保留可选 beforeReload 生命周期对象', async () => {
  const lifecycle = {
    beforeReload() {},
    dispose() {}
  }
  const definition = entry.definePiDeskPlugin({
    name: 'reload-fixture',
    setup() {
      return lifecycle
    }
  })

  assert.equal(await definition.setup({}), lifecycle)
})

test('defineBrowserEntry 保留同步 Entry Factory 和 disposer', async () => {
  let disposed = false
  const factory = browser.defineBrowserEntry(() => () => {
    disposed = true
  })
  const dispose = factory({})
  assert.equal(typeof dispose, 'function')
  await dispose()
  assert.equal(disposed, true)
  assert.throws(() => browser.defineBrowserEntry(null))
})

test('React 子入口暴露 Hooks、ErrorBoundary 与通用插件组件', () => {
  assert.equal(typeof react.usePluginConnection, 'function')
  assert.equal(typeof react.usePluginWorkSessions, 'function')
  assert.equal(typeof react.usePluginPush, 'function')
  assert.equal(typeof react.useMessageHandle, 'function')
  assert.equal(typeof react.useMessageDetail, 'function')
  assert.equal(typeof react.PluginErrorBoundary, 'function')
  assert.equal(typeof react.PluginHostProvider, 'function')
  assert.equal(typeof react.PluginLogViewer, 'function')
  assert.equal(typeof react.PluginSurface, 'function')
  assert.equal(typeof react.PluginScroll, 'function')
  assert.equal(typeof react.PluginPanelHeader, 'function')
  assert.equal(typeof react.PluginSection, 'function')
  assert.equal(typeof react.PluginActionRow, 'function')
  assert.equal(typeof react.PluginTabList, 'function')
  assert.equal(typeof react.PluginTab, 'function')
  assert.equal(typeof react.PluginKeyValueList, 'function')
  assert.equal(typeof react.PluginKeyValueItem, 'function')
  assert.equal(typeof react.PluginLoadingState, 'function')
  assert.equal(typeof react.PluginSpinner, 'function')
  assert.equal(typeof react.PluginSelect, 'function')
  assert.equal(reactBase.PluginSelect, react.PluginSelect)
  assert.equal('PluginSelectField' in react, false)
  assert.equal('PluginSelectField' in reactBase, false)
  assert.equal(typeof react.PluginSplitView, 'function')
  assert.equal(typeof react.PluginListItem, 'function')
  assert.equal(typeof react.PluginMarkdown, 'function')
  assert.equal(typeof react.PluginButton, 'function')
  assert.equal(typeof react.PluginContextMenu, 'function')
  assert.equal(typeof react.PluginContextMenuTrigger, 'function')
  assert.equal(typeof react.PluginContextMenuContent, 'function')
  assert.equal(typeof react.PluginContextMenuItem, 'function')
  assert.equal(typeof react.PluginField, 'function')
  assert.equal(typeof react.PluginCheckbox, 'function')
  assert.equal(typeof react.PluginSecretInput, 'function')
  assert.equal(typeof react.PluginDialog, 'function')
  assert.equal(typeof react.PluginConfirmDialog, 'function')
})

test('React UI 子入口隔离基础组件与 Markdown 依赖', () => {
  assert.equal(typeof reactBase.PluginSurface, 'function')
  assert.equal(typeof reactBase.PluginErrorBoundary, 'function')
  assert.equal(typeof reactBase.PluginContextMenu, 'function')
  assert.equal(reactBase.PluginMarkdown, undefined)
  assert.equal(typeof reactMarkdown.PluginMarkdown, 'function')
})

test('PluginScroll 提供可访问的自定义滚动 viewport', () => {
  const markup = renderToStaticMarkup(
    createElement(
      react.PluginScroll,
      { orientation: 'both', 'aria-label': '滚动内容' },
      createElement('div', null, '内容')
    )
  )
  assert.match(markup, /data-pi-desk-scroll/)
  assert.match(markup, /data-orientation="vertical"/)
  assert.match(markup, /data-orientation="horizontal"/)
  assert.match(markup, /plugin-scroll-viewport/)
  assert.match(markup, /\.pi-desk-ui-scroll\{display:flex;/)
  assert.match(markup, /\.pi-desk-ui-scroll-viewport\{width:100%;height:auto;/)
  assert.match(markup, /flex:1 1 auto/)
})

test('多个插件区域复用同一公共样式资源', () => {
  const markup = renderToStaticMarkup(
    createElement(
      'main',
      null,
      ...['区域一', '区域二'].map((label) =>
        createElement(
          react.PluginSurface,
          { key: label },
          createElement(react.PluginScroll, { 'aria-label': label }, label)
        )
      )
    )
  )

  assert.match(markup, /aria-label="区域一"/)
  assert.match(markup, /aria-label="区域二"/)
  assert.equal(markup.match(/\.pi-desk-ui-card\{/g)?.length, 1)
  assert.equal(markup.match(/\.pi-desk-ui-scroll\{/g)?.length, 1)
})

test('组合组件提供紧凑侧栏结构且不依赖业务 CSS', () => {
  const markup = renderToStaticMarkup(
    createElement(
      react.PluginSurface,
      null,
      createElement(react.PluginPanelHeader, {
        title: '隔离工作区',
        description: 'C:/project',
        density: 'compact',
        actions: createElement(react.PluginButton, { size: 'sm' }, '刷新'),
        meta: createElement(react.PluginBadge, { tone: 'success' }, '可用 1')
      }),
      createElement(
        react.PluginSection,
        { title: '工作区池', density: 'compact' },
        createElement(
          react.PluginCard,
          { density: 'compact' },
          createElement(
            react.PluginKeyValueList,
            { density: 'compact', layout: 'stacked' },
            createElement(react.PluginKeyValueItem, { label: 'Entry', value: 'C:/workspace' })
          )
        )
      )
    )
  )
  assert.match(markup, /\.pi-desk-ui-card\{/)
  assert.match(markup, /pi-desk-ui-panel-header-compact/)
  assert.match(markup, /pi-desk-ui-button-sm/)
  assert.match(markup, /pi-desk-ui-section-compact/)
  assert.match(markup, /pi-desk-ui-card-compact/)
  assert.match(markup, /pi-desk-ui-key-values-compact/)
  assert.match(markup, /pi-desk-ui-key-values-stacked/)
})

test('PluginCheckbox 与 Tab 提供统一宿主交互样式', () => {
  const markup = renderToStaticMarkup(
    createElement(
      react.PluginSurface,
      null,
      createElement(react.PluginCheckbox, {
        checked: true,
        readOnly: true,
        'aria-label': '选择项目'
      }),
      createElement(
        react.PluginTabList,
        { label: '页面' },
        createElement(react.PluginTab, { active: true }, '执行'),
        createElement(react.PluginTab, { active: false }, '配置')
      )
    )
  )
  assert.match(markup, /type="checkbox"/)
  assert.match(markup, /pi-desk-ui-checkbox/)
  assert.match(markup, /pi-desk-ui-tabs/)
  assert.match(markup, /pi-desk-ui-tab/)
  assert.match(markup, /aria-selected="true"/)
})

test('PluginSelect 使用 Base UI 触发器并保留字段说明', () => {
  const markup = renderToStaticMarkup(
    createElement(react.PluginSelect, {
      id: 'scope-select',
      label: '执行范围',
      description: '选择本次检查范围',
      size: 'sm',
      defaultValue: 'related',
      options: [
        { value: 'related', label: '相关检查' },
        { value: 'full', label: '完整检查' }
      ]
    })
  )
  assert.doesNotMatch(markup, /<select\b/)
  assert.match(markup, /<button[^>]*role="combobox"/)
  assert.match(markup, /<label[^>]*for="scope-select"/)
  assert.match(markup, /<button[^>]*id="scope-select"/)
  assert.match(markup, /pi-desk-ui-select-trigger-sm/)
  assert.match(markup, /执行范围/)
  assert.match(markup, /选择本次检查范围/)
  assert.match(markup, /相关检查/)
})

test('PluginDialog 和 PluginConfirmDialog 保持公开组件入口', () => {
  // Base UI Portal 不参与服务端静态输出；视觉、焦点和遮罩由浏览器验收覆盖。
  assert.equal(typeof react.PluginDialog, 'function')
  assert.equal(typeof react.PluginConfirmDialog, 'function')
})

test('PluginLoadingState 提供加载、错误和重试结构', () => {
  const loading = renderToStaticMarkup(
    createElement(react.PluginLoadingState, { loading: true }, '内容')
  )
  assert.match(loading, /pi-desk-ui-spinner/)
  assert.match(loading, /正在加载/)

  const failed = renderToStaticMarkup(
    createElement(
      react.PluginLoadingState,
      { loading: false, error: '读取失败', onRetry() {} },
      '内容'
    )
  )
  assert.match(failed, /读取失败/)
  assert.match(failed, /重新加载/)
})

test('PluginSecretInput 可切换显示但不声明登录密码语义', () => {
  const markup = renderToStaticMarkup(
    createElement(react.PluginSecretInput, { defaultValue: 'secret' })
  )
  assert.match(markup, /type="text"/)
  assert.match(markup, /autoComplete="off"/)
  assert.match(markup, /autoCapitalize="none"/)
  assert.match(markup, /spellCheck="false"/)
  assert.match(markup, /pi-desk-ui-secret-control/)
  assert.match(markup, /aria-label="显示原文"/)
})

test('Browser 和 React 构建不包含 Node 或 AgentSession Runtime', async () => {
  const source = await Promise.all(
    ['browser.js', 'react.js', 'react-base.js', 'react-markdown.js', 'shared.js'].map((file) =>
      readFile(join(packageRoot, 'dist', file), 'utf8')
    )
  ).then((files) => files.join('\n'))

  for (const forbidden of [
    'node:crypto',
    '@earendil-works/pi-coding-agent',
    'AgentSession',
    'ExtensionAPI'
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

test('Browser 文件预览公开类型保留三模式和可选图片列表', async () => {
  const declarations = await readFile(join(packageRoot, 'dist', 'browser.d.ts'), 'utf8')
  assert.ok(
    declarations.includes(
      "export type BrowserFilePreviewMode = 'session' | 'expanded' | 'standalone';"
    )
  )
  assert.ok(
    declarations.includes(
      'preview(source: PluginSource, path: string, options?: BrowserFilePreviewOptions): void;'
    )
  )
  assert.ok(
    declarations.includes('preview(path: string, options?: BrowserFilePreviewOptions): void;')
  )
  assert.match(declarations, /imagePaths\?: readonly string\[\];/)
  assert.match(declarations, /readonly locale\?: BrowserLocaleHost;/)
  assert.match(declarations, /export interface BrowserLocaleHost/)
})

test('package exports 声明全部稳定子入口', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.match(manifest.version, /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/u)
  assert.equal(manifest.peerDependencies['@base-ui/react'], '^1.7.0')
  assert.equal(manifest.peerDependencies.react, '>=19')
  assert.equal(manifest.peerDependencies['react-dom'], '>=19')
  assert.deepEqual(Object.keys(manifest.exports), [
    '.',
    './settings',
    './errors',
    './capabilities',
    './entry',
    './session',
    './browser',
    './react',
    './react/base',
    './react/markdown',
    './host-runtime/*'
  ])
  for (const key of [
    '.',
    './capabilities',
    './entry',
    './session',
    './browser',
    './react',
    './react/base',
    './react/markdown'
  ]) {
    const value = manifest.exports[key]
    assert.equal(typeof value.types, 'string')
    assert.equal(typeof value.import, 'string')
  }
  assert.equal(manifest.exports['./host-runtime/*'], './dist/host-runtime/*')
})

test('SDK 生产依赖不强制安装宿主公共 UI', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(manifest.dependencies), ['zod'])
  for (const name of [
    '@base-ui/react',
    '@streamdown/cjk',
    'lucide-react',
    'react',
    'react-dom',
    'streamdown'
  ]) {
    assert.equal(manifest.dependencies[name], undefined, name)
    assert.equal(manifest.optionalDependencies?.[name], undefined, name)
    assert.equal(manifest.peerDependenciesMeta[name]?.optional, true, name)
    assert.equal(typeof manifest.peerDependencies[name], 'string', name)
    assert.equal(typeof manifest.devDependencies[name], 'string', name)
  }
})
