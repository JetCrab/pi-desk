# Pi Desk 插件

管理操作见[管理命令](./commands.md)。Tool、Command、Pi Event 与 TUI 使用原生 Pi API；Pi Desk SDK 只补充宿主服务、会话通信和 Web 界面。

## 选择运行位置

| 运行位置        | 入口与能力                                                                     | 生命周期                                |
| --------------- | ------------------------------------------------------------------------------ | --------------------------------------- |
| 原生 Pi         | Pi 包的扩展入口；Tool、Command、Event                                          | 当前 Pi 会话                            |
| Pi Desk Global  | `package.json` 的 `piDesk.entry`；全局 Method、State、Push、通知、消息声明     | 服务进程中的插件实例                    |
| Pi Desk Session | 原生扩展中 `bindSessionPlugin(pi, pluginName)`；会话 Method、State、Push、Task | 当前 AgentSession，分支数据随树导航重建 |
| Browser Owner   | 轻量 Browser Entry；贡献注册、Push 与通知事件                                  | 当前浏览器页面中的插件实例              |
| Browser View    | Contribution 的 `load()` → `{ mount }`                                         | 每次挂载，关闭或 Source 变化后释放      |

同一个插件各入口使用同一稳定 `pluginName`；名字、方法、事件和 contributionName 使用 1～64 字符小写 kebab-case。Global 不依赖当前聊天窗口，Browser Owner 不代表后端任务 Owner。

Session 精确绑定 `{ workId, sessionId, branchId }`。Source 来自 Target 或 `host.workSessions`，不自行拼装；旧 Source 返回 `409`，分支变化后重新查询。Application 的 `target.initialContext` 只是打开时的 Source/CWD，不是内部选择的权威状态。

## 按需读类型

系统提示提供当前 SDK 类型目录，其上一级是 SDK 根目录；从根目录 `package.json` 的 `exports` 找对应声明，不依赖仓库源码路径。常用类型文件相对 SDK 根目录如下：

| 子入口                                  | 类型文件                                                                 | 使用时机                                                           |
| --------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `/entry`                                | `dist/entry.d.ts`                                                        | `PiDeskPluginDefinition`、Node Host、Global Method、通知、消息声明 |
| `/session`                              | `dist/session.d.ts`                                                      | `bindSessionPlugin`、Session Method、State、Push、Task             |
| `/browser`                              | `dist/browser.d.ts`                                                      | Browser Factory、Contribution 定义、mount Target、Host 通信        |
| `/react/base`                           | `dist/react-base.d.ts`，继续读其导出的 `react-ui.d.ts`、`react-log.d.ts` | 公共组件、Host Provider、ErrorBoundary、Hooks                      |
| `/react/markdown`                       | `dist/react-markdown.d.ts`                                               | Markdown 消息界面                                                  |
| `/errors`、`/settings`、`/capabilities` | 对应 `dist/*.d.ts`                                                       | 方法错误、共享地区设置、能力规则                                   |

SDK 不重复定义原生 Pi Tool。只导入 Node 类型可用 `import type`，宿主 Jiti 会剥除类型；实际运行时导入 SDK 或其他 Node 包时，在该插件声明运行依赖，不借用另一插件的依赖。类型检查所需 SDK 可放开发依赖。

## 最小本地应用

四个文件组成一个可直接加载的本地演示，不独立发布：

- [package.json](./examples/local-application/package.json)：`private: true`、ES Module、`piDesk.entry`，不需要安装依赖或编译。
- [pi-desk.ts](./examples/local-application/pi-desk.ts)：普通对象定义一个 Global Method 并注册 Browser Entry。
- [browser/entry.js](./examples/local-application/browser/entry.js)：同步注册应用元数据与动态 loader。
- [browser/application.js](./examples/local-application/browser/application.js)：公共 React/UI、人工只读查询、加载与重试、mount/dispose。

从本文所在目录取得示例文件，复制到 `pidesk info` 返回的 `<AgentDir>/extensions/local-application/`，保留层级。调用 `{ "args": ["plugins", "install", "local-application", "--scope", "global"] }`，等待最终通知后从应用入口打开“本地应用示例”，点击“读取服务信息”。修改后使用 `plugins reload local-application --scope global` 对应的 args。

示例只查询一个真实 Global Method，不自动调用模型、写文件、访问外部网络或轮询。它没有原生 Pi 扩展，不添加空的 Native 入口。

## Node 与会话能力

Node Entry 默认导出普通 `PiDeskPluginDefinition` 对象即可，`definePiDeskPlugin()` 是可选包装。入口由宿主加载；异步初始化放 `async setup()`，不使用模块顶层 `await`。

`registerBrowserEntry()` 最多一次，路径位于包内，文件名为 `entry.js`。无需自有资源时 `setup()` 不必返回清理；创建 Timer、Watcher、连接或子进程时返回 disposer，释放旧实例资源。Host 自动撤销注册；旧异步清理不得写入新实例。

会话能力在真实原生扩展中绑定，不用 Node Global 冒充 Session：

```ts
import { bindSessionPlugin } from '@jetcrab/pi-desk-sdk/session'

const plugin = bindSessionPlugin(pi, 'example-plugin') // pi 是原生 ExtensionAPI
plugin.registerMethod('cwd-get', async (_input, context) => ({
  cwd: context.extensionContext.cwd
}))
plugin.setState({ status: 'ready' })
plugin.push('changed', {})
```

此处 `/session` 是运行时导入，插件需声明 SDK 运行依赖。Session State 仅当前会话内存，`setState()` 整体替换自身槽位，`null` 删除；不写 Pi JSONL。树导航从当前 `getBranch()` 重建分支数据，不重复注册会话方法。Task 用于报告真实后台任务，停止能力由任务 Owner 提供。

Node `plugin.setState()` 则整体替换自身全局状态；Browser 通过 `host.globalState.getSnapshot()/subscribe()` 只读。两者不是同一槽位，均不得读写其他插件状态。宿主地区设置由 `host.settings.getSnapshot()/subscribe()` 只读，不另存权威副本。

### 会话预览目录

Session 插件可为左侧项目文件增加目录，不改变 Pi 会话 CWD：

```ts
plugin.addPreviewDirectory(directory, { default: true })
```

`directory` 为服务端绝对目录；省略第二个参数只登记，`default: true` 同时设为默认预览目录，后登记的默认生效。原 CWD 始终可选；目录规范化后去重，最多登记 32 个。重复快照不会覆盖用户的手动选择。登记只在当前会话运行态内，插件在 `session_start`、`session_tree` 从自身数据恢复后重新登记；不要在普通查询时重复请求默认选择。

调用不等待回执；非法路径或超限由宿主拒绝并记日志，实际目录内容按需读取。旧宿主或独立 Pi 不处理该登记；兼容旧 SDK 时使用 `plugin.addPreviewDirectory?.(...)`。`files.preview/reveal` 支持会话 CWD 下规范相对路径或服务端绝对文件路径（包括项目外文件）；`preview` 的 `imagePaths` 使用相同路径规则。宿主仍校验当前 Source，目录浏览边界不变。依赖项目外文件的插件需要同步更新宿主，旧宿主只接受项目内相对路径。`readImage` 仍只接受会话 CWD 下规范相对路径。`.md`、`.markdown` 在宿主文件查看器中默认以 Markdown 排版预览，可点击“源码”切换；会话文件视图与 `mode: 'standalone'` 独立查看器均支持，插件无需增加参数或自行渲染。

## Browser Entry 与懒界面

Entry 默认导出普通同步函数即可；在函数返回前完成全部 `registerContribution(kind, name, definition)`。kind 支持 `application`、`composer-panel`、`settings-page`、`session-sidebar-tab`、`message-view`。Entry 只放元数据、loader、轻量页面状态和事件订阅；返回 disposer 清理自有订阅与资源。

Entry 不静态引入 React、ReactDOM、UI、CSS 或大型实现，也不等网络或动态 import 后再注册。UI 放在 `load()` 的动态模块，导出 `{ mount({ container, target, host, signal }) }`；Lazy Module 顶层不启动副作用。

浏览器资源只托管 Entry 目录内的 `.js` 模块图；相对 import 留在该目录内。宿主不托管独立 CSS、图片或字体。局部样式通过 Lazy JS 注入并限定自身容器，不修改全局 DOM 或依赖宿主内部目录。

Lazy UI 可直接使用的 Host Runtime 白名单：

```text
react
react/jsx-runtime
react/jsx-dev-runtime
react-dom
react-dom/client
@jetcrab/pi-desk-sdk/react/base
@jetcrab/pi-desk-sdk/react/markdown
```

`PluginMarkdown` 会高亮带语言标记的代码块（例如 `sql`），语言和主题资源按需加载；插件不需要另装高亮库。它只负责展示，不格式化代码；SQL 等业务格式化依赖由对应插件维护。

复用宿主 React 与 UI，不复制或打包第二套公共运行时。`/browser` 不在白名单中：普通函数无需包装；`copyBrowserText` 等 SDK Browser 运行函数需要构建时打入插件模块，不能原样留下裸 import。其他业务依赖也需构建为相对模块。无构建示例用 JS `createElement`；TSX、TypeScript 浏览器文件需要先编译为 JS。

Application 使用 `chrome: 'host'` 让宿主负责 Dialog、标题、关闭、焦点、Escape、Loading/Error 和视口约束；内容自然决定尺寸，不替换工作台。React mount 使用 `createRoot`、`PluginHostProvider`、`PluginErrorBoundary` 和公共控件；disposer 调用 `root.unmount()`，释放自建 Listener、Timer、Observer、Object URL。宿主先 abort `signal`，迟到结果必须忽略。

界面继承宿主明暗主题与字号，布局使用 `rem`、合理内边距和自身滚动；窄屏与触控可用，不以裁切或只靠 hover 隐藏必要操作。按钮、表单、加载/错误/重试优先复用 `/react/base`；需要 Markdown 时才加载 `/react/markdown`。

### 侧栏顶部操作

`session-sidebar-tab` 的 Lazy `mount({ target, host })` 内可为当前 Tab 设置顶部右侧按钮：

```ts
target.setHeaderActions?.([
  {
    label: '预览项目',
    icon: { type: 'builtin', name: 'folder' },
    onSelect: () => host.projects.preview(target.cwd)
  }
])
```

每次调用整体替换，`[]` 清空。按钮使用 `label` 作为可访问名称和提示，`icon` 复用 Contribution 图标；可选 `disabled` 禁用，`busy` 显示忙碌并禁用。状态变化时重新设置完整列表，不修改已提交对象。宿主保持列表顺序，超过三个操作时保留前两个，其余收进菜单。

`onSelect` 可返回 `Promise<void>`；同一按钮回调尚未完成时不重复执行，异常由宿主记录并在当前挂载仍有效时提示。插件负责业务加载状态和结果展示；请求已经产生的副作用不因 Tab 关闭而回滚。

按钮只属于当前挂载，切换 Tab、关闭侧栏／移动抽屉、Source 或 CWD 变化、挂载失败及插件重载时自动清空；旧按钮、迟到更新和旧 disposer 均不能操作新挂载。旧宿主可能没有此方法，使用可选调用，不自行访问宿主 DOM。`PluginPanelHeader.actions` 仍只作用于插件内容区标题，不是此顶栏入口。

## 通信、通知与后台

Browser Method 示例：

```ts
const status = await host.piDesk.invokeGlobal('status-get', {})
const cwd = await host.piDesk.invokeSession(source, 'cwd-get', {})
await host.pi.prompt(source, { mode: 'auto', text: '请总结当前任务' })
```

这些调用限定当前插件或完整 Source。Method 输入/输出为 JSON Object，各不超过 2MB；Push 与状态槽位各不超过 64KB。`host.pi.prompt()` 返回接纳用的 `tempId`，不是模型完成或 durable 消息；不按正文、时间或位置猜测是否发送成功，结果未知不自动重播。Browser 不能直接调用 Pi Tool；通过 `host.pi` 使用原生 Prompt、Command、Bash、Interrupt 能力，不直接 fetch 宿主接口或自建 WebSocket。

Method 调用没有 Browser 视图级取消参数；Global handler 的 `context.signal` 是 Node Owner 失效信号。关闭 UI 只释放展示，不停止后台任务。需要停止时调用真实 Owner 的明确停止方法；断线、超时和关闭不回滚副作用。

Push 可丢失、不持久化、不 ACK、不重放，也不创建聊天消息。Entry ready、连接恢复 ready、视图 mount 时按需要查询 Method 建立权威基线；不要用页面轮询替代已有的宿主状态同步。

- 当前页面轻提示：`plugin.notify({ level: 'success', title: '保存成功' })` 或 `host.notify()`，只在当前页面短暂展示，离线可错过。
- 服务端全局通知：Node `plugin.notifications.publish({ key: 'result:run-1', level: 'success', title: '处理完成', event: { name: 'open-result', data: { runId: 'run-1' } } })`；用返回 ID 调用 `update/delete`。Browser Entry 通过 `plugin.notifications.onEvent('open-result', handler)` 处理点击，成功后宿主删除通知。Node 未重启时重连可恢复；Node 重启或插件释放后清空，不持久化。

`publish()` 的 `key` 可选，去除首尾空白后为 1～256 字符，由业务标识事件，例如 `post:${postId}` 或 `build:${runId}`。同一插件、同一 `key` 的现存通知只保留一条：内容相同不广播；内容变化整体更新文字、级别和点击 Event，返回原 ID，保留创建时间与位置。再次发布时省略 `description/event` 会清除旧值；`update()` 仍只修改文字和级别。不传 `key` 每次新增，不按文字自动合并。通知删除或淘汰后同 `key` 可重新创建，不保存已关闭记录；`key` 只存在于服务端通知内存，不随通知传给浏览器。带 `key` 的发布需使用支持通知去重的宿主；旧宿主会拒绝未知字段，不自动降级为新增通知。

## 消息展示

Node Entry 的 Declaration 把已有 Pi 消息转换为 `{ viewKey, summary, detail }`；Browser 的 Message View 按 `viewKey` 展示。`viewKey` 使用小写 kebab-case 的 `namespace/view-name` 形式，标识展示数据协议，不是消息 ID。Declaration 不创建消息，也不管理消息身份。

以原生插件产生的 `customType = 'example-status'` 消息为例，在 Node Entry 的 `setup(plugin)` 中注册：

```ts
plugin.declareMessage('status', {
  priority: 100,
  match({ message }) {
    return message.kind === 'custom' && message.customType === 'example-status'
  },
  project({ defaultProjection }) {
    return {
      viewKey: 'example/status',
      summary: defaultProjection.summary,
      detail: null
    }
  }
})
```

此例复用默认自定义消息的 `summary.text`。在 Browser Entry 同步注册对应视图：

```js
plugin.registerContribution('message-view', 'status', {
  viewKey: 'example/status',
  priority: 100,
  load: () => import('./status-view.js').then((module) => module.default)
})
```

同目录的 `status-view.js`：

```js
export default {
  mount({ container, target }) {
    const element = document.createElement('p')
    container.append(element)

    function render() {
      const { text } = target.message.getSnapshot().summary
      if (typeof text !== 'string') {
        target.reportError(new Error('消息摘要缺少 text'))
        return
      }
      element.textContent = text
    }

    const unsubscribe = target.message.subscribe(render)
    render()
    return () => {
      unsubscribe()
      element.remove()
    }
  }
}
```

- `match/project` 必须同步、快速、无副作用；每次返回完整投影，不自行计算或传输增量。自定义数据的结构由对应 `viewKey` 的 Declaration/View 约定，不扩充通用消息类型。
- 首屏和实时必需内容放 `summary`；大内容或用户展开后才用的数据放 `detail`。需要详情时，仅在消息已有 `entryId` 且 `fixed.hasDetail` 为真后调用 `target.message.loadDetail()`；异步结果须检查挂载的 `signal`，不能写回失效视图。
- 视图从 `getSnapshot()` 读取完整当前状态，并通过 `subscribe()` 跟随更新；同 `viewKey` 的消息更新不重新挂载，Temporary 转 Durable 保持同一 Handle，`viewKey` 改变时会重挂。释放时解除订阅并清理自有资源。
- Declaration 和 View 分别按 `priority` 选择，数值越大越优先；同最高优先级冲突会报错。声明、加载或展示失败不自动尝试低优先级实现；异步展示错误通过 `target.reportError(error)` 交给宿主处理。
- 刷新后仍需展示的数据必须存在于最终 Pi Entry，仅通过 Tool `onUpdate()` 提供的数据不会自动持久化。更新插件时兼容已有消息结构，不靠自动重载旧会话解决兼容问题。

## 任务

Task Center 用于当前 Session 的真实任务，通过 `bindSessionPlugin()` 返回的 `plugin` 上报；Global 插件的任务由自身运行态管理，不创建 Session Task。

在真实操作开始时创建任务，完成后上报结果。以下 `runTask()` 是插件已有的业务函数：

```ts
const task = plugin.startTask({
  title: '处理文件',
  activity: '正在执行'
})

try {
  await runTask()
  task.complete('处理完成')
} catch (error) {
  task.fail(error instanceof Error ? error.message : String(error))
  throw error
}
```

- 进度使用 `task.update({ activity, info })`；`info` 是 `{ label, value }[]`，整体替换，`[]` 清空，不放日志正文。
- 有停止能力时，给 `startTask()` 的 `interrupt` 传入真实停止函数，签名为 `() => Promise<void>`。回调返回不代表任务已经结束；确认实际停止后调用 `task.stopped()`，会话关闭等中断使用 `task.interrupted()`。
- 一个任务只进入一次终态，终态后不能 `update()` 或再次结束；`remove()` 只移除上报记录，不停止真实操作。
- `detailSource` 可选：文本日志用 `{ kind: 'text-file', path: logPath }`；活动子会话用 `{ kind: 'pi-conversation', session: childSession }`；历史会话用 `{ kind: 'pi-conversation', sessionFile }`。文件路径均为服务端绝对路径，活动实例和文件来源二选一。
- 宿主只观察详情，不接管插件创建的资源。会话关闭时停止自有任务、上报终态并释放子会话等资源，不关闭父会话；需要随分支结束的任务在树导航前收敛。
- 任务列表是运行态，不是持久历史；宿主保留全部运行中任务和最近 100 条终态，不能依赖更早记录一直存在。

## 日志

命令、构建等任务的完整输出由插件写入日志文件，并负责容量与清理。界面复用宿主日志能力，不自行读取文件或实现监听、重连。

从 `@jetcrab/pi-desk-sdk/react/base` 导入 `PluginLogViewer`，在已有 `PluginHostProvider` 内使用：

```tsx
<PluginLogViewer path={logPath} />
```

`logPath` 是服务端可访问的绝对文本文件路径。文件未创建时继续等待；组件处理追加、重写、重连与读取重试，最多显示末尾 128KB、1000 行，不修改原文件。

非 React 界面使用 `host.logs.open(logPath)`，通过返回句柄的 `getSnapshot()`、`subscribe()` 和 `retry()` 读取与观察，释放时调用 `dispose()`。Session Task 可使用 `detailSource: { kind: 'text-file', path: logPath }` 展示同一日志。

业务数据只传递必要的日志摘要和路径，不把日志正文放入 Method 返回、Plugin Push、状态槽位或 Pi JSONL。

## 更新生效

`plugins install/reload` 应用 Node/Browser 能力；目标插件活动视图重挂，旧 Browser Owner 失效。现有 Native 会话不自动重载，新 UI 可能连接旧会话方法，需兼容既有消息和方法数据；需要现有会话加载当前原生代码时使用 `session reload`。热加载无法处理的资源按宿主已有重启流程处理，不把重新挂载界面当作后端任务已停止。
