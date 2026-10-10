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

复用宿主 React 与 UI，不复制或打包第二套公共运行时。`/browser` 不在白名单中：普通函数无需包装；`copyBrowserText` 等 SDK Browser 运行函数需要构建时打入插件模块，不能原样留下裸 import。其他业务依赖也需构建为相对模块。无构建示例用 JS `createElement`；TSX、TypeScript 浏览器文件需要先编译为 JS。

Application 使用 `chrome: 'host'` 让宿主负责 Dialog、标题、关闭、焦点、Escape、Loading/Error 和视口约束；内容自然决定尺寸，不替换工作台。React mount 使用 `createRoot`、`PluginHostProvider`、`PluginErrorBoundary` 和公共控件；disposer 调用 `root.unmount()`，释放自建 Listener、Timer、Observer、Object URL。宿主先 abort `signal`，迟到结果必须忽略。

界面继承宿主明暗主题与字号，布局使用 `rem`、合理内边距和自身滚动；窄屏与触控可用，不以裁切或只靠 hover 隐藏必要操作。按钮、表单、加载/错误/重试优先复用 `/react/base`；需要 Markdown 时才加载 `/react/markdown`。

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
- 服务端全局通知：Node `plugin.notifications.publish({ level: 'success', title: '处理完成', event: { name: 'open-result', data: {} } })`；用返回 ID 调用 `update/delete`。Browser Entry 通过 `plugin.notifications.onEvent('open-result', handler)` 处理点击，成功后宿主删除通知。Node 未重启时重连可恢复；Node 重启或插件释放后清空，不持久化。

消息适配需要时读 `/entry` 的 `declareMessage` 与 `/browser` 的 Message View 类型：Node 投影原始 Pi 消息，Browser 按最终 `viewKey + priority` 选择 View。首屏必需数据放 Summary，大内容按 Detail 获取；View 失败只影响相应消息，不自行解析 Pi 原始类型或切换到另一个低优先级 View。

## 更新生效

`plugins install/reload` 应用 Node/Browser 能力；目标插件活动视图重挂，旧 Browser Owner 失效。现有 Native 会话不自动重载，新 UI 可能连接旧会话方法，需兼容既有消息和方法数据；需要现有会话加载当前原生代码时使用 `session reload`。热加载无法处理的资源按宿主已有重启流程处理，不把重新挂载界面当作后端任务已停止。
