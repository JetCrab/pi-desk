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
| `/config`、`/secrets`                   | 对应 `dist/config.d.ts`、`dist/secrets.d.ts`                             | Node 配置目录、串行读改写、加密凭据存取                            |
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

宿主启动时，单个 Node 插件的入口导入、`setup()` 和 Browser 资源检查共用 15 秒上限。超时不代表插件代码已经停止；宿主撤销旧实例，等首轮插件加载、旧加载及其清理结束后，延迟 10 秒自动重试一次。明确加载错误和再次超时不自动重试；手动重载、禁用、卸载或宿主关闭会取消待执行的恢复。加载失败可在插件管理行点击“重载”；包缺失或安装不完整时按原配置补装，正常包只重新加载。重载保留原启停状态和更新渠道。

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

### 配置与凭据（Node）

原生 Pi 扩展和 Pi Desk Node 业务都可直接使用 `/config`、`/secrets`，不需要常驻 Global Host。这两个子入口仅供 Node 使用，不从 SDK 根入口导出，也不在 Browser Entry 或 View 中导入。

```ts
import { getConfigPath } from '@jetcrab/pi-desk-sdk/config'
import { createSecretStore, isSecretReference } from '@jetcrab/pi-desk-sdk/secrets'

const configPath = getConfigPath('example-plugin.json')
const secrets = createSecretStore()
```

用户级自有配置位于 `<AgentDir>/config/`；默认 AgentDir 由 Pi 的 `getAgentDir()` 决定，支持 `PI_CODING_AGENT_DIR`。Pi 原生 `settings.json`、`models.json`、`auth.json`、`mcp.json` 保持原格式和位置，不接管其凭据加密。项目配置仍由插件定义。

新版只读取当前路径和格式，启动及读取配置时不会搬迁旧文件、回退读取旧路径、删除旧字段，或把明文凭据自动改成引用。升级前须另行将需要保留的旧配置准备为当前格式；不要依赖首次启动完成转换。

| `/config` 方法                                                         | 用途与边界                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `getConfigDirectory(agentDir?)` / `getConfigPath(filename, agentDir?)` | 返回目录或单个文件路径，不创建目录；`filename` 只能是文件名，不能含子目录。                                        |
| `withConfigTransaction<T>(targetPath, operation)`                      | 跨进程串行执行同一目标的异步读改写，返回回调结果 `Promise<T>`；不自动回滚。                                        |
| `writeConfigTextAtomic(path, content)`                                 | 同步持久化 UTF-8 文本，原子发布并回读验证；自身不重复加锁。                                                        |

配置 Schema、读取和显式保存由插件维护；路径函数不执行这些工作。配置读改写放在 `withConfigTransaction()` 回调内，使用 `writeConfigTextAtomic()` 写入；不能在回调内嵌套获取同一目标锁。事务和原子写入拒绝符号链接及非普通配置文件。敏感值在显式保存时通过 `SecretStore.put()` 创建引用，读取配置只解析已保存的引用，不转换或回写文件。

`withConfigTransaction()` 只提供同目标串行，不提供配置与保险库之间的跨文件原子提交；回调报错不会撤销已完成的写入。`writeConfigTextAtomic()` 持久化、发布和回读验证成功后，临时文件清理失败只告警；锁释放失败也只告警，不把成功结果改为失败。

| `/secrets` 方法                        | 用法与结果                                                                                                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `put(value, reference?)`               | `await secrets.put(value)` 生成 `secret://UUID`；传入引用时写入该引用对应的值。配置只保存返回的引用。            |
| `get(reference)` / `delete(reference)` | 读取明文或删除对应值；不存在时分别返回 `null` 或直接完成。                                                       |
| `export(references)`                   | 返回指定引用到明文的对象；任一引用缺失时报错。结果不是加密备份，调用方须置于受控加密流程中。                     |
| `import(values)`                       | 导入引用到明文的对象，始终生成新引用，返回旧引用到新引用的映射；调用方用映射更新导入的配置，不覆盖目标已有凭据。 |
| `isSecretReference(value)`             | 只判断引用格式，不证明凭据存在；只在插件明确的敏感字段中解释引用。                                               |

`get/put/delete/export/import` 均返回 Promise。读取敏感字段时，用 `isSecretReference()` 判断后调用 `get()`；不要把缺失引用当成明文继续使用。设置页可通过插件自己的 Method 获取真实值并支持显示，不从 Browser 直接读取保险库。保险库没有长期连接，不需要 `dispose()`。

已发布的旧引用可能被其他配置文件共享，不自动回收；显式 `delete()` 前，调用方须确认没有任何消费者。只有已确认未提交到任何配置的新引用才可在失败后回收；写入报错本身不能证明配置从未发布，提交成功后的清理告警也不能作为回收依据。

保险库最多保存 4096 条记录，完整密文上限为 8 MiB。写入或导入超限时明确报错，保留原密文，不自动清空或淘汰凭据。

保险库固定为 `<AgentDir>/config/credentials.enc`，使用 AES-256-GCM 整体认证加密并串行、原子写入。主密钥默认由 Windows 凭据管理器、macOS Keychain 或 Linux Secret Service 持久保存；Linux 显式使用 `secret-service`。系统钥匙串不可用时明确失败，不静默回退；已有密文而主密钥丢失时拒绝重建覆盖。

无桌面环境可用 `PI_DESK_SECRET_KEY_FILE` 指定部署方持有的外部密钥文件。内容必须是**原始 32 字节**，不是 Hex 或 Base64 文本；SDK 只读，不创建或改写该文件。`createSecretStore({ agentDir?, keyProvider? })` 的 `keyProvider` 仅用于隔离自测或明确自定义密钥后端，返回 32 字节密钥，不作为生产默认或钥匙串失败时的自动兜底。

协议和 Browser 子入口不加载上述 Node 能力。SDK 的 `proper-lockfile` 用于跨进程配置/凭据锁，`@napi-rs/keyring` 用于默认系统密钥存储，均属于这些 Node 能力的运行依赖；协议 Schema 使用 Zod。插件运行时导入这些子入口时声明 SDK 运行依赖，公共 React/UI 仍由宿主提供。

### 静态环境文件声明

插件可在 `package.json` 的 `piDesk.environment.files` 声明自有持久文件，供宿主导出接入读取；无需执行插件代码或启动 Global Host。声明本身不执行备份或恢复，不保证所用宿主已提供完整环境备份功能。

```json
{
  "piDesk": {
    "environment": {
      "files": [
        {
          "base": "config",
          "path": "example-plugin.json",
          "format": "json",
          "localPaths": ["/workspaces/*/directory"],
          "omitPaths": ["/lastPort"],
          "secretPaths": ["/apiKey"]
        }
      ]
    }
  }
}
```

- `base`：`config` 相对 `<AgentDir>/config/`，`data` 相对 `<AgentDir>/pi-desk/`，`project` 相对 `<项目>/.pi/`。`path` 是该基准内的规范相对路径，不写绝对路径或 `..`，不是 Glob。
- `format`：`json`、`yaml` 或 `binary`；结构化格式只能声明文件。`binary` 可声明文件或配套资源目录，目录递归收集普通文件，排除符号链接、依赖安装目录及缓存；不执行字段转换，三个字段声明数组只能省略或为空。
- 可选 `localPaths`、`omitPaths`、`secretPaths` 均为 JSON Pointer 字符串数组；用 `~0`、`~1` 转义 `~`、`/`，`*` 段匹配当前层的所有对象键或数组元素，不使用空指针选择根对象。
- `localPaths` 只标记用户本地路径字段，SSH 远端路径不声明；相对路径保留其原有基准。`omitPaths` 标记导出副本中应剔除的缓存、端口登记或旧机器执行路径，不删除源配置。
- `secretPaths` 只标记当前格式中保存凭据引用的敏感字段，供导出收集及导入引用重映射使用，不把明文自动转换为引用。声明的项目结构化配置须显式提供此字段；没有敏感字段时填 `[]`。静态声明只描述当前文件，不声明旧路径或历史格式。

### 会话预览目录

Session 插件可为左侧项目文件增加目录，不改变 Pi 会话 CWD：

```ts
plugin.addPreviewDirectory(directory, { default: true })
```

`directory` 为服务端绝对目录；省略第二个参数只登记，`default: true` 同时设为默认预览目录，后登记的默认生效。原 CWD 始终可选；目录规范化后去重，最多登记 32 个。重复快照不会覆盖用户的手动选择。登记只在当前会话运行态内，插件在 `session_start`、`session_tree` 从自身数据恢复后重新登记；不要在普通查询时重复请求默认选择。

调用不等待回执；非法路径或超限由宿主拒绝并记日志，实际目录内容按需读取。旧宿主或独立 Pi 不处理该登记；兼容旧 SDK 时使用 `plugin.addPreviewDirectory?.(...)`。`files.preview/reveal` 支持会话 CWD 下规范相对路径或服务端绝对文件路径（包括项目外文件）；`preview` 的 `imagePaths` 使用相同路径规则。宿主仍校验当前 Source，目录浏览边界不变。依赖项目外文件的插件需要同步更新宿主，旧宿主只接受项目内相对路径。`readImage` 仍只接受会话 CWD 下规范相对路径。`.md`、`.markdown` 在宿主文件查看器中默认以 Markdown 排版预览，可点击“源码”切换；会话文件视图与 `mode: 'standalone'` 独立查看器均支持，插件无需增加参数或自行渲染。

## Browser Entry 与懒界面

Entry 默认导出普通同步函数即可；在函数返回前完成全部注册。`registerContribution(kind, name, definition)` 支持 `application`、`composer-panel`、`settings-page`、`session-sidebar-tab`、`message-view`；输入区挂件与会话标题项分别使用 `registerWidget()`、`registerSessionHeaderItem()`，不能通过 `registerContribution` 注册。Entry 只放元数据、loader、轻量页面状态和事件订阅；返回 disposer 清理自有订阅与资源。

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

### 输入框上下方挂件

在 Browser Entry 注册，不调用原生 `ctx.ui.setWidget()`：

```js
plugin.registerWidget('session-info', {
  placement: 'aboveEditor',
  load: () => import('./session-info.js').then((module) => module.default)
})
```

同目录 `session-info.js` 是最小 Lazy View：

```js
export default {
  mount({ container, target }) {
    const element = document.createElement('p')
    element.textContent = `当前会话：${target.source.sessionId}`
    element.style.cssText = 'margin:0;overflow-wrap:anywhere'
    container.append(element)
    return () => element.remove()
  }
}
```

`placement` 只允许 `aboveEditor / belowEditor`，省略时是上方。Target 为 `{ kind: 'widget', source }`。挂件在对应聊天区可见时挂载，自然高度；没有内容时不预留空白。多个挂件按插件名和注册名稳定排列，不进入标题栏更多浮层。关闭或隐藏聊天区、Source 变化和插件重载会 Abort/dispose；重新挂载时按现有 Method/Push 建立数据基线。

### 锚定浮层

Lazy View 可从 `@jetcrab/pi-desk-sdk/react/base` 使用受控 `PluginPopover`。`trigger` 接收 React Element，其他内容作为 children；宿主组件负责 Portal、锚定、视口约束和焦点，打开不会抢走输入焦点。悬停、短暂提示和业务状态由插件控制，不自行定位到宿主 DOM。

```tsx
const [open, setOpen] = useState(false)

<PluginPopover
  open={open}
  onOpenChange={setOpen}
  side="top"
  trigger={<PluginButton>查看详情</PluginButton>}
>
  <div style={{ padding: '0.75rem' }}>当前内容</div>
</PluginPopover>
```

`side` 默认 `bottom`，`align` 默认 `start`，`className` 用于自身浮层的布局。浮层维持指定方向并限制可用高度；长内容自行使用 `PluginScroll`。调用方关闭或卸载时清理自己的计时器、Observer 和订阅。此组件需要支持该导出的宿主 Host Runtime，不能只更新插件依赖后向旧宿主请求。

### 会话标题右侧条目

`inline` 和 `overflow` 必须分别声明，可以独立选择普通按钮或自定义视图：

```js
const showSession = {
  type: 'action',
  icon: { type: 'builtin', name: 'file' },
  label: '会话信息',
  onSelect({ source, host }) {
    host.notify({ level: 'info', title: '当前会话', description: source.sessionId })
  }
}

plugin.registerSessionHeaderItem('session-info', {
  inline: {
    type: 'custom',
    minWidthRem: 6,
    load: () => import('./session-info.js').then((module) => module.default)
  },
  overflow: showSession
})
```

- `action` 只接受固定 `icon`、`label`、`onSelect({ source, host, signal })`，不提供动态图标、文字或状态订阅。宿主显示图标加文字，异步操作期间防止重复点击；失败记录局部错误，失效后的回调不得继续使用旧 Host。信号属于该展示生命周期，不会回滚服务端已经产生的副作用。
- `custom` 只提供 `load()`，宿主不包装点击回调。inline custom 必须额外声明正数 `minWidthRem`，单位为 `rem`；有内容时才按此分配宽度。加载中和空内容不占宽度或间距，宿主只观察当前真实挂载，不复制业务视图测量。自定义内容应适应获得的容器，不能靠超宽 DOM 挤占标题。overflow custom 不声明宽度，加载中和空内容也不预留空行。
- 自定义 Target 为 `{ kind: 'session-header-item', source, presentation: 'inline' | 'overflow' }`。两种表现可以使用不同模块，也可以复用同一个 `{ mount }`；loader 分别按表现缓存和重试。可复用上面的 `session-info.js`，或使用公共 React/UI 构建交互视图。
- 标题项按插件名和注册名稳定排列；宽度不足时从末尾收进更多，宿主保留标题及必要操作。普通按钮选择后关闭更多；自定义区域内点击不会被转发，也不会自动关闭更多。Escape 或外部点击关闭浮层，键盘与触控均可操作。
- inline 自定义视图先静默挂载，内容出现后参与宽度计算；收纳会卸载该视图。只有更多打开时才挂载 overflow 自定义视图，关闭后释放。动态状态与运行/停止等复杂交互由自定义视图自行实现；业务状态归插件运行态，不归 mount，也不能只存于会被卸载的组件局部状态。卸载只清理视图资源，不停止项目进程。

两种注册均限定 Browser Entry 同步阶段，名称规则与其他贡献相同。它们需要支持对应方法的宿主和 SDK；旧宿主缺少能力时禁用这项入口，不使用 `registerContribution` 别名或访问宿主 DOM 代替。现有 `composer-panel` 仍是人工打开的会话弹窗，不是上下方挂件。

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

## 统一事件

Browser Entry 和 Node Global 从 `plugin.host.events` 使用统一事件；Lazy View 使用 mount 参数的 `host.events`。下面是两个虚构插件的调用与释放。

`plugin-b` 的 Browser Entry 订阅宿主状态和 `plugin-a` 的自定义事件：

```js
export default function setup(plugin) {
  const host = plugin.host
  const offContext = host.events.on('workbench-context', (context) => {
    console.info('当前工作目录', context?.cwd ?? null)
  })
  const offPlugin = host.events.onPlugin('plugin-a', 'changed', (data) => {
    if (typeof data.label === 'string') {
      console.info('plugin-a 通知', data.label)
    }
  })

  return () => {
    offContext()
    offPlugin()
  }
}
```

`plugin-a` 在业务动作中发布，`host` 来自它自己的 `plugin.host`：

```js
host.events.emit('changed', { label: '示例内容已变化' })
```

| 方法                                  | 用途                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------- |
| `on(name, handler)`                   | 订阅 SDK 类型化的宿主状态或动作；Browser 与 Node Global 的事件表不同            |
| `onPlugin(pluginName, name, handler)` | 按 Pi Desk 注册名和事件名订阅插件自定义 JSON 事件；不是 npm 包名                |
| `emit(name, data)`                    | 发布当前插件自己的事件，同步返回 `void`；发布身份由宿主绑定，不能指定其他发布者 |

两种订阅都同步返回幂等 `off()`。精确类型以 SDK 为准：Browser 的 `HostEvents`、`BrowserHostEventMap` 从 `/browser` 导出，Node 的 `HostEvents`、`NodeHostEventMap` 从 `/entry` 导出；不需要新增运行时 import 或 Browser 白名单项。

### 宿主事件

| 事件名                | Browser | Node Global | 数据与含义                                                                                |
| --------------------- | ------- | ----------- | ----------------------------------------------------------------------------------------- |
| `workbench-context`   | 状态    | —           | `WorkbenchContext`：当前聚焦工作会话的 `{ source, cwd }`，没有有效焦点时为 `null`         |
| `work-sessions`       | 状态    | 状态        | `readonly PluginWorkSession[]`：现有公开会话列表投影，包含 Source、cwd、status 及列表顺序 |
| `connection`          | 状态    | —           | `BrowserConnectionSnapshot`：当前页面连接快照                                             |
| `settings`            | 状态    | 状态        | `HostSettingsSnapshot`：生效的宿主共享地区设置                                            |
| `theme`               | 状态    | —           | `BrowserThemeSnapshot`：生效主题                                                          |
| `plugin-state`        | 状态    | —           | `PluginJsonObject \| null`：仅订阅插件自己的全局状态槽，不是 Session State                |
| `chat-submit-result`  | 动作    | —           | `ChatSubmitResult`：当前页面聊天提交的接管响应、明确拒绝或结果未知                        |
| `chat-input-accepted` | —       | 动作        | `ChatInputAccepted`：`{ source, tempId }`，Worker 已返回接管结果                          |

状态事件在 `on()` 返回后交付当前完整真实值，晚加载的插件也能取得当前状态。Owner 尚未就绪时等待真实基线，不用空数组或 `null` 冒充未初始化；首次交付时取最新值，不回放初始化期间的中间状态。基线建立后，先更新快照再按实际变化顺序通知，相同值不重复通知。

工作上下文只表示聚焦工作会话的 Source 和 CWD，不是预览目录或 Workspace 插件选中的隔离空间。切到同 cwd 的另一个会话、当前 Source 或 cwd 改变时都会通知；再次选择同一有效上下文不通知。点击侧栏、弹窗等不自动清空工作上下文。它与会话侧栏使用同一份最终上下文；现有侧栏仍按 Source/CWD 变化重挂，不需要再订阅事件重复恢复。

`work-sessions` 只表达既有 SDK 列表投影的变化，不额外提供标题、`pinnedCount` 或原始 Pi 消息。

`chat-submit-result` 的每个结果都含完整 `source`。`status: 'accepted'` 时带 `tempId`；`status: 'failed' | 'unknown'` 时带 `message`，不带 `tempId`。它覆盖输入区和 `host.pi.prompt()` 共用的提交通道；进入通道前的空内容、附件和草稿等本地校验失败不发布。已取得接管结果后，本地清理失败不再发布一次发送失败，其他页面也不接收本页面的结果。

`chat-input-accepted` 包含 Worker 在压缩期间接管的排队输入；拒绝、未接管和原生 Pi 自行产生的消息不发布。两种聊天动作都不携带正文或图片。接管成功不表示 Pi 已开始运行、模型已完成或消息已 durable；结果未知不自动重发，也不猜测后续消息与请求的关联。

### 分发与释放

- 动作和自定义事件只交付给发布时已存在、交付时仍有效的订阅，不补发历史。宿主事件和插件事件是独立命名空间，同名不互相触发。
- 自定义事件只在当前 Browser 页面内，或当前 Node 服务进程的 Global 插件之间分发；不跨端、跨页面或跨设备，不进入 Session Facade 或 Pi EventBus。可以订阅尚未加载的发布者，不会因此加载它；没有消费者也允许发布。
- 事件名与插件名使用 1～64 字符小写 kebab-case。自定义数据只能是最大 64KB 的 JSON Object，业务结构由发布者约定、订阅者解析。宿主在分发前隔离发布对象，以只读数据交付；订阅者不得修改收到的数据。名称、数据无效或 Owner 已失效时，调用在边界报错。
- 回调按注册顺序调用，可返回 `void | Promise<void>`；宿主不等待 Promise，隔离同步异常与异步拒绝并记录诊断，不改变发送或其他业务操作的结果。异步处理完成顺序没有保证，同步耗时回调仍占用当前 JS 线程。回调返回值不能拦截操作。
- 每次注册独立，重复注册分别调用；发布者订阅自己的事件也会接收。`off()` 后不再调用，包括尚未交付的首次状态值。已经开始的异步业务由插件自行收尾，不回滚已产生的副作用。
- Browser Entry 的订阅不依赖任何 UI 是否打开。仅供 View 使用的订阅须在该 mount 的 disposer 中调用 `off()`，不能等页面 Owner 释放才清理。
- 插件停用、卸载、重载、页面退出或服务关闭时，宿主释放对应 Owner 的订阅并使旧 Host 失效。发布者重载不删除其他插件按稳定插件名建立的订阅，新实例继续发布；重载期间的事件不回放。自定义事件不保存历史或待处理 Promise 列表，最后一条订阅退出时释放对应路由。

### 兼容与能力边界

新事件能力需要同时支持它的宿主和 SDK，**只升级 SDK 不会让旧宿主具备 `host.events`**。需要兼容旧宿主的插件可在独立兼容边界检测 `host.events`，缺失时禁用依赖功能，不访问宿主 Store 或 DOM 代替。

既有 `workSessions/connection/settings/theme/globalState` 的 `getSnapshot()/subscribe()` 继续可用；旧 `subscribe()` 仍不提供首次回调，与新事件共用状态源。既有 `plugin.onPush()`、`pushGlobal/pushSession` 只用于自身插件通信，不向其他插件开放。通知点击、离开守卫、能力规则应用、Task interrupt 和资源句柄保留各自合同，不作为普通事件广播；原生 Pi 事件继续使用 Pi API。宿主通知与插件自定义通知的扩展统一走 `host.events`，不另加零散通知回调；破坏性事件数据变化使用新事件名。

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
- 刷新后仍需展示的数据必须存在于最终 Pi Entry，仅通过 Tool `onUpdate()` 提供的数据不会自动持久化。插件初始化、更新和热加载不自动重投影或重传旧聊天，新消息使用当前声明；Browser View 需兼容已有消息结构，不靠自动重载旧会话解决兼容问题。

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

## 当前客户端访问后端 TCP 端口

Browser Host 的可选 `host.tunnels` 将当前工作台后端的已发布 TCP 端口映射到访问设备；插件不需要查询提供端身份或传入隧道密钥：

```ts
const tunnels = host.tunnels
if (tunnels) {
  const mapping = tunnels.open({ remotePort: 43191 })
  const unsubscribe = mapping.subscribe(() => {
    const state = mapping.getSnapshot()
    // status 为 ready 后，使用 127.0.0.1:<state.localPort>。
  })
  // 业务结束时释放；需要跨弹窗保持时由 Browser Entry 持有句柄。
  unsubscribe()
  await mapping.close()
}
```

`open()` 同步返回句柄，不表示已连接。快照为 `{ status, localPort, path, error }`：status 为 `connecting / ready / recovering / failed / closed`；localPort 未分配时为 null；path 为 `direct / relay / unknown / null`。unknown 表示尚无真实路径，不能显示成直连；null 表示普通本机访问或无有效路径。`subscribe()` 返回解除观察函数，不关闭连接；`close()` 幂等并等待原生资源释放，失败会拒绝 Promise。旧宿主或远端网页没有原生客户端能力时 `host.tunnels` 缺失。

- 当前工作台使用 `localhost`、IPv4 回环或 `::1` 时直接返回请求端口，不查询发布或建立隧道。
- 跨电脑访问需要 Windows/macOS 桌面能力及有效隧道配置。宿主经当前认证连接查询后端真实发布，再在访问设备分配回环端口；未发布、旧桌面不支持查询或两端控制服务地址不同会失败，不自动发布目标。
- 只转发 TCP，自动尝试直连并回退中继，不修改手动隧道模式。HTTP URL、路径和业务认证由插件／目标服务负责。
- 映射只存当前客户端内存，最多每插件64项、桌面总计128项；同一映射恢复期间保持本地端口，关闭重建不保证同号。不要将访问设备的映射状态写入后端共享状态。
- 关闭贡献视图只解除视图订阅；插件 Browser Owner 释放、页面导航／销毁、客户端退出时宿主回收映射。旧句柄不能影响新插件实例。该能力不是同源插件之间的安全沙箱，不开放桌面任意命令或密钥读取。

## 更新生效

插件界面可在用户点击按钮后重载指定会话的 Pi 配置：

```ts
if (!host.pi.reload) throw new Error('请使用输入框「更多 → 重载 Pi 配置」')
await host.pi.reload(target.source.workId)
// 确认视图仍有效后，调用自己的 Session Method 重新查询。
```

`reload(workId: string): Promise<void>` 等同输入框「更多 → 重载 Pi 配置」，宿主按 workId 查找调用时工作窗口当前绑定的 Pi 会话，保留其聊天历史、sessionId 和当前分支，重新加载配置、Skills 及已安装插件的本机代码；插件无需指定 sessionId 或 branchId。不下载包、不重载 Node/Browser Entry、不刷新网页。仅人工操作触发，不在 mount、缺少方法或重连时自动执行。会话忙碌、workId 不存在或 Browser Owner 失效时拒绝；传输期间绑定变化仍由现有重载流程校验并返回错误，断线或超时结果未知时不得自动重试。Promise 等待重载流程结束，不保证每个插件成功加载；结束后重新查询功能状态，仍不可用时保留错误和手动恢复入口。调用期间禁用重复操作；关闭视图不取消已提交重载，迟到结果不得更新旧视图。旧宿主可能没有可选 `host.pi.reload`，缺失时引导使用宿主菜单；不能只更新 SDK 依赖就获得此能力。

包维护不阻塞聊天订阅、刷新或其他会话。缺失或版本不符的包会被跳过，导入/工厂失败的入口不加载；Pi 生命周期回调和插件 Provider 注册的明确错误保留在插件管理诊断中，不升级为整会话失败。正常扩展继续加载。此隔离不终止同步死循环，也不回滚插件已发生的外部副作用；整体初始化超时仍可能使当前会话回退基础聊天，不阻塞其他会话的历史同步。

`plugins install/reload` 应用 Node/Browser 能力；目标插件活动视图重挂，旧 Browser Owner 失效。现有 Native 会话不自动重载，新 UI 可能连接旧会话方法，需兼容既有消息和方法数据；需要现有会话加载当前原生代码时使用 `session reload`。热加载无法处理的资源按宿主已有重启流程处理，不把重新挂载界面当作后端任务已停止。
