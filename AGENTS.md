# Pi Desk 项目规则

本项目默认使用中文交流与输出。

## 开源仓库边界

- 本仓库连接 https://github.com/JetCrab/pi-desk，始终按可公开内容维护，不能因当前可见性为私有而存放维护者资料。
- 主程序在根目录与 src/，应用在 apps/，插件与 SDK 统一在 plugins/；不要创建插件源码用的 packages/。
- 公开主包、SDK 和插件使用 `@jetcrab/`，Registry 为 https://registry.npmjs.org；公开自有代码使用 Apache-2.0，保留第三方许可证、版权和来源说明。
- 首批插件仅包括 pi-desk-bg-run、pi-desk-subagent、pi-desk-deliverables、pi-desk-usage、pi-desk-ctx、pi-desk-quota-viewer、pi-desk-tibo-monitor、pi-desk-tool-reason、pi-desk-remote-debug，另含公共依赖 pi-desk-sdk。新增插件或扩大公开范围必须先获得用户确认。
- 真实密钥、Token、正式签名及密码、个人模型／SSH／隧道配置、私人运行数据和未经确认的私有源码不得写入本仓库，包括文档、示例、测试、日志和截图；示例只用占位符或测试数据。归属不明先询问，不先写入后靠忽略规则处理。
- 代码、workspace、锁文件和构建入口不得依赖外层私人目录、私有包或私有 Registry，不通过链接或复制绕过；本仓库必须能独立克隆、安装和构建。
- 提交、推送和发布前核对仓库根目录、remote、实际差异、待推送历史及制品内容；忽略文件不等于移除已跟踪内容和历史。发现私人内容时停止并报告。
- 发布凭据通过 Actions Secrets 注入，不写入源码、日志或制品；公开安装包使用 GitHub Releases，隧道镜像使用 GHCR。首次推送、正式发布及可见性变更先获用户确认，镜像发布不等于生产部署。
- 两层仓库独立管理，不复制外层私人维护规则；目录整理不表示自动发布、跨平台构建或正式分发已经验证。
- 官网源码与维护用 `.pi/`、个人构建和部署配置归属私有侧，不存放于本仓库。官网页面对外访问不等于网站源码开源。除许可证、第三方归属、最小入口说明与项目维护规则外，详细文档默认由维护者私有管理，新增公开文档须逐篇获得用户确认并审查正文、引用和附件。

## 技术栈

- Next.js App Router、React、TypeScript、Tailwind CSS
- Shadcn UI（Base UI 版本）、Lucide
- Vercel AI SDK、AI Elements
- pnpm

## 顶层运行边界

| 目录         | 职责                                        |
| ------------ | ------------------------------------------- |
| `src/app`    | Next 强制入口，只做 Client 与 Server 的装配 |
| `src/client` | React 展示、交互和浏览器能力                |
| `src/server` | 服务端业务、Pi 集成和底层执行               |
| `src/common` | 前后端共享协议、Schema、DTO 和纯逻辑        |

依赖规则：

- `client -> common`，禁止 `client -> server`。
- `server -> common`，禁止 `server -> client`。
- `common` 禁止依赖 `app`、`client` 或 `server`。
- `src/app` 是唯一允许同时装配 Client 和 Server 的边界；`page.tsx`、`layout.tsx`、`route.ts` 保持精简。
- Next Server 专属入口和实现使用 `import 'server-only'`。原生 Node 启动代码在 Next、tsx 或 Pi 就绪前运行，保留独立 JS/MJS 加载边界，不依赖 `server-only` 或浏览器能力。
- `client` 表示前端归属，不代表所有组件都添加 `'use client'`；默认使用 Server Component，只在需要状态、事件、生命周期或浏览器 API 的叶子组件声明 Client Component。
- Server 向 Client 传递的数据必须可序列化，并遵循 `common` 中的协议。

## L1-L4 分层

Client、Server 分别采用相同分层；Common 不设置 L1：

| 层级 | 目录            | 职责                                                 |
| ---- | --------------- | ---------------------------------------------------- |
| L1   | `l1_entry`      | 页面、布局、Provider、HTTP/WebSocket/Stream 入口适配 |
| L2   | `l2_biz`        | 面向用户任务的完整业务功能和用例编排                 |
| L3   | `l3_modules`    | 被多个 L2 真实复用的复杂能力                         |
| L4   | `l4_foundation` | UI 基础组件、传输、Pi、文件、数据库、日志等底座      |

允许依赖：`L1 -> L2/L4`、`L2 -> L3/L4`、`L3 -> L4`。禁止反向依赖。简单功能允许 `L2 -> L4`，不强制创建 L3。

同一层的 L2 业务默认不互相依赖；共用业务能力提升到 L3。模块外只调用稳定入口，不绕过入口导入内部实现。

## WorkSession 持久化边界

- WorkSession 持久化记录只允许 `{ workId, cwd, sessionId }`，三个字段都必须存在；`cwd` 用于限定 Pi 会话目录，且必须与 JSONL header 一致。
- 工作会话集合持久化额外只允许顶层 `pinnedCount`，表示有序列表的固定前缀长度；固定 workId 必须由列表前缀推导，不得重复保存。
- 除单条记录字段和集合级 `pinnedCount` 外，所有 WorkSession 状态都必须根据当前 Pi 会话和运行态实时计算，不得写入持久文件、数据库或 sidecar。
- Pi SDK 和 Pi JSONL 只使用 Pi 自身的身份，如 `sessionId`、entry `id` 和 `toolCallId`；`tempId`、`requestId` 和 `clientId` 只允许存在于传输或内存运行态。Pi Desk 身份不得传入 Pi、写入 Pi JSONL 或替代 Pi ID；临时映射在 durable entry 形成后必须以 Pi entry `id` 收敛。
- 需要增加其他持久字段时，必须先说明无法实时计算的原因并获得用户明确确认。
- 服务端 `branchId` 只允许保存在 L3 `WorkSession` 持有的内存运行态中，包括其 L4 Runtime 或 Worker，不得写入服务端 WorkSession 持久记录、sidecar 或 Pi JSONL；浏览器可丢弃缓存只能把它用作 Source 分区键。绑定或恢复会话、Worker 重启、session reload 时可从 Pi JSONL 全量构建一次分支索引。
- 查询工作会话列表或读取 WorkSession 状态时必须直接使用内存 `branchId`，禁止扫描全部 Pi 会话、重新遍历 JSONL 或重建分支索引。
- `branch(entryId)` 只切换当前 WorkSession 在同一 Pi JSONL 中的运行态 leaf，`sessionId` 不变；切换本身不持久化，后续 append 通过 `parentId` 将分支写入 JSONL。
- `createBranchedSession(workId, entryId)` 必须从当前 JSONL 的根到该节点创建全新 JSONL 和全新 `sessionId`，源 WorkSession 不变，新 WorkSession 绑定传入的 `workId`。
- 普通 append 的分支索引同步必须在 L4 增量完成，不得全量重算。L3 `WorkSession` 只保留单个工作会话的生命周期与 Pi 交互编排；分支索引、JSONL 读写、Worker 通信和 SDK 适配等复杂实现必须下沉到 L4 内部模块。
- `WorkSession` public 方法只允许 `create(workId, cwd, sessionId?)`、`branch(entryId)`、`createBranchedSession(workId, entryId)`、`send(input)`、`interrupt()`、`restoreQueuedMessages()` 和 `setModel(input)`，以及只读的 `workId`、`cwd`、`sessionId`、`branchId`；增加其他 public 方法前，必须先说明用途并获得用户明确确认，底层同步方法不得直接对外暴露。

## 服务端权威与简单化

- 多客户端可见的聊天消息、队列、模型和上下文只以服务端 WorkSession Chat Runtime 与 Pi JSONL 为准；客户端 Draft/Outbox 只负责发送前内容，不得作为共享消息或乐观插入聊天时间线。
- 聊天身份固定为 `requestId -> tempId -> entryId`：`requestId` 只关联请求响应，`tempId` 由服务端 Worker 在接纳时生成，durable 后只认 Pi `entryId`。默认禁止增加 `sendId`、`payloadHash`、`restoreId`、发送回执、业务重放缓存或两阶段确认；确有新需求时必须先说明无法用现有身份完成的原因并获得用户确认。
- 对已经明确接受的低概率断线或服务重启边界，直接记录边界，不为其增加持久字段、sidecar、幂等缓存或恢复协议；请求结果未知时不得通过正文、图片、时间或数组位置猜测并自动重放。
- 新增字段前必须明确 owner、生命周期、释放条件和实际消费者；可以由 Source、数组位置、现有运行态或其他字段可靠推导时不得加入协议或持久化结构。
- Pi durable 消息提交必须使用 `createAgentSession()` 后注册的 `session.agent.subscribe()` 后置监听取得真实 entryId；`session.subscribe()` 只处理 queue、settled、compaction、thinking 等 AgentSession 独有事件，并过滤重复的普通 AgentEvent。

## 聊天消息协议边界

- 公共消息固定分为 `location`、`fixed`、`summary`、`detail`、`increments` 五层；服务端是 Pi 原始消息到公共层的唯一投影边界，客户端只应用 Common Snapshot/Update，不解析 Pi 原始类型。
- Snapshot 携带完整定位、fixed、summary 和按策略携带的 detail；实时 Update 必须携带临时定位，其余只发送变化字段。第一版 increments 只允许 `summary.text`、`detail.thinking`，所有工具（含 bash）禁止实时传输 output。
- Assistant usage 必有，ToolResult usage 可选；公共 usage 只保留实际消费者使用的最小字段。`hasDetail` 表示 canonical detail 可按需获取，不表示当前 Push 已携带 detail；Temporary 不展开，Durable 且 `hasDetail = true` 才能查询详情。
- 服务端 ChatRecord 必须保存当前 Temporary 完整 Snapshot；Snapshot 与后续增量使用仅内存 `sourceEventVersion/watermark` 划定边界，队列排空前不得 ready，溢出时重建 Snapshot。该 version 不进入公共协议、WorkSession、Pi JSONL 或持久化。
- 客户端使用页面内存 connection epoch 隔离旧物理连接事件，同一 Source 严格串行应用全部增量，禁止沿用“连续 update 只保留最后一条”的完整快照优化；重连以完整 Temporary Snapshot 重建基线，不增加公开 version、ACK 或重放缓存。

## Pi 插件运行态边界

- 需要向 Pi Desk 同步的 Pi 插件会话运行态统一放在 `ChatRuntime.plugins`，结构固定为 `Record<pluginName, 可 JSON 序列化对象>`；对象 Key 就是插件名，不再为插件状态增加 `id`、`version` 或其他信封字段。
- 插件禁止向 `ChatRuntime`、`contextUsage`、WorkSession、Source、聊天消息或其他核心结构增加插件专属顶层字段；核心协议只维护统一的 `plugins` 专区。
- 服务端每个 Pi 会话只允许由一个独立的 L4 插件状态模块维护全部插件槽位；Worker 只持有这个通用状态模块，禁止增加 `contextIgnore`、`xxxPlugin` 等插件专属成员、分支或同步流程。
- 插件状态统一通过 `pi-desk:session-plugins` EventBus Channel 更新，Payload 使用 `{ [pluginName]: object | null }`；对象整体替换对应插件槽位，`null` 删除槽位，禁止深层 merge。
- 插件状态只属于当前 AgentSession 内存运行态，不得写入 WorkSession 持久记录、Pi JSONL、sidecar、数据库或浏览器权威状态；Session、Branch 或 Worker 被替换、关闭时必须释放并从当前插件重新构建。
- WebSocket 继续通过现有 `session_sync.runtime` 和 `runtime_update.runtime` 传递完整 `plugins` 快照；禁止为普通插件状态增加插件专属 WebSocket path、Push 类型或 HTTP 接口。
- Client 对 `runtime.plugins` 执行整体替换；具体业务只解析自己消费的插件 Key，未知插件 Key 直接忽略，插件不得读取或修改其他插件槽位。
- 每个插件槽位只保留已有实际消费者的最少字段。`context-ignore` 只允许 `{ ignoredTokens, potentialTokens, effectiveTokens? }`；`effectiveTokens` 由上下文圆环消费，在自动忽略后的 Provider usage 刷新窗口内提供当前有效预计，旧插件缺失时客户端回退 `contextUsage.tokens`。不得增加 `id`、`version`、`enabled` 或其他没有消费者的字段。

## 多客户端与共享状态

- 每个网页实例加载时使用 `crypto.randomUUID()` 生成一个仅在本次页面生命周期内固定的 `clientId`，同一浏览器的多个标签页也必须使用不同 ID；它只用于连接和推送路由，不作为认证信息。
- 浏览器发起的 HTTP API 请求统一携带 `X-Pi-Desk-Client-Id` 请求头。应用 WebSocket 使用 `/api/ws?clientId=<UUID>` 和子协议 `pi-desk.v1` 标识页面实例，并在断开时释放连接。
- 每个页面只有一个逻辑客户端并只建立一条应用 WebSocket。服务端同一 `clientId` 只保留一个当前连接，新连接替换旧连接；连接后必须先完成 `work-sessions/list` 初始化，成功应用快照前不得使用其他业务路径；断线重连后重新初始化 WorkSession，再按 source cursor 恢复聊天。
- 需要跨客户端一致的数据以服务端为权威。WorkSession HTTP 修改完成后通过 `work-sessions/update` 推送所有 ready 客户端；创建、排序或多项变化推 snapshot，单项字段变化推 update，删除推 delete。
- 工作会话列表顺序和 `pinnedCount` 属于服务端数据；排列操作提交完整 `{ workIds, pinnedCount }`，服务端校验集合与分界后串行保存。固定会话是列表前 `pinnedCount` 项，不给 WorkSession 增加 `order` 或 `pinned` 字段。

- 同一个 `workId` 的多个客户端共享同一个服务端 WorkSession 和 Worker；客户端不得各自创建运行时，命令由服务端按 `workId` 串行处理。
- `primaryWorkId`、移动端抽屉开关、焦点、滚动位置和面板尺寸属于客户端本地界面状态。`pinnedWorkIds` 只能由服务端有序列表前缀派生；移动端按“主会话 + 固定前缀”分页展示聊天窗口，滑动固定会话只改变焦点，不替换 `primaryWorkId`。

### WorkSession 聊天订阅池

- 订阅池是页面生命周期内曾经需要持续接收消息的有效 Source 集合，必须保持：`当前展示的 Source ⊆ 订阅池 ⊆ 当前有效 WorkSession Source`。
- 聊天窗口一旦展示就必须加入订阅池：桌面端并排、移动端分页展示 `primaryWorkId + 服务端固定前缀`；发送订阅前实时读取本地最新 cursor。
- 会话切换、取消固定或移动端隐藏固定列时不得清理仍有效的订阅；隐藏期间继续接收并缓存消息，方便来回切换。
- 仅当 WorkSession 被删除、`sessionId/branchId` 变化导致旧 Source 失效，或页面刷新时清理对应池项；断线时客户端保留池，重连完成 `work-sessions/list` 后统一恢复。
- 本设备主动替换 WorkSession 时保留该 workId 的 `primaryWorkId` 和焦点，共享固定位置不变；删除旧 Source 后由仍在展示的会话自动订阅新 Source。
- 其他设备被动替换 WorkSession 时清除关联的本地 `primaryWorkId`、焦点和旧 Source；共享固定位置不变，桌面端仍显示的固定会话自动订阅新 Source。被动删除同时由服务端列表移除固定关系。
- 页面刷新后先用最新 WorkSession 列表校验本地 `primaryWorkId`；桌面端恢复并排窗口，移动端以 `primaryWorkId` 为第一页恢复分页窗口，两端都按服务端固定前缀恢复展示和订阅。

## 应用 WebSocket 维护边界

- 页面级 `AppSocketClient` 只能由 Client L1 Provider 创建和关闭；L2 只能通过 L4 公共入口执行幂等 connect、request、subscribe 和 unsubscribe，禁止直接 `new WebSocket`、保存物理连接或关闭共享连接。
- 每次物理连接必须独占 socket、pending request、heartbeat、监听器和 close 状态；重连必须创建新连接对象，旧连接回调只能清理旧对象。
- Server 使用 `clientId -> 当前 Session` 的唯一映射；同 clientId 新连接替换旧连接，旧连接以 4001 关闭。旧 close 只有注册表仍指向自己时才能删除记录，push 只能发送给当前连接。
- WebSocket path、请求 Schema、响应 Schema 或 push Schema 必须绑定为同一个 Common 合同对象，Client 和 Server 复用同一对象；禁止业务代码使用裸 path 搭配独立 Schema，同一路径重复注册必须报错。
- `src/server/l1_entry/node/l1-server.ts` 只负责 Next、HTTP、Upgrade 和进程关闭；Server L4 负责物理连接与消息信封；Server L1 负责路由和每连接 Controller；L2 业务不得依赖原始 WebSocket 对象。
- 每个业务使用独立的每连接 Controller，只清理自己的初始化状态、订阅和 cursor；dispose 必须幂等，禁止一个业务 Controller 清理其他业务的连接状态。
- 传输层不得全局串行所有请求；只负责 requestId、path 匹配、并发上限和连接生命周期，具体串行规则由 WorkSession、Worker 等业务 owner 负责。
- 修改连接注册、重连、路由或清理逻辑时，至少验证同 clientId 替换、不同 clientId 独立推送、旧 close 不影响新连接、断线重新初始化和优雅关闭。

## Common 边界

- 具体业务协议放在 `common/l2_biz/<业务>/`。
- 跨业务模块协议放在 `common/l3_modules/<模块>/`。
- 全项目纯基础能力放在 `common/l4_foundation/`。
- Common 代码不得依赖 React、Next、Node API、浏览器 API、数据库、Pi SDK、配置或导入副作用。
- 跨边界结构优先使用 Zod Schema，并通过 `z.infer` 生成类型；不重复维护 Schema 和 TypeScript 类型。
- 不把数据库记录、Provider 原始响应或 UI 状态直接作为公共协议。

## 接口文档

详细接口文档由维护者私有管理；变更前先向用户获取对应版本，不在本仓库创建未经确认的文档副本。

- 所有 HTTP 成功响应为 `{ code: 0, msg: "", data }`；失败响应为 `{ code, msg, data: null, i18n? }`，`code != 0`、`msg` 必须说明原因，并保留正确的 HTTP 状态码；可识别的宿主错误可选携带 `i18n: { key, params? }`。
- 所有对外时间字段使用 Unix 毫秒时间戳；无值使用 `null`；客户端按当前生效的语言和 IANA 时区展示，时区检测失败时使用 UTC，不得手工修改原始时间戳。
- 普通 HTTP 接口统一使用 POST；路径使用 `/api/<资源>/<行为>`，行为按需使用 `list`、`get`、`add`、`del`，排序和替换分别使用 `sort`、`replace`，没有实际需求时不预建接口。`GET /api/health` 是健康检查例外。分页参数统一放在 Body 的 `page` 字段。应用 WebSocket 固定使用 `/api/ws`，消息使用逻辑 path。
- 已确认但尚未实现的 HTTP 或 WebSocket 契约可以先写入维护者提供的接口文档的“冻结待开发契约”区域，并明确标注不可调用；代码实现时必须在同一次改动中将对应契约移入“当前已实现契约”，同步更新实现状态。
- HTTP 表格至少列出方法、路径、作用、参数和返回；统一响应格式只在文档顶部说明，表格返回列只描述 `data` 内容。WebSocket 文档至少说明连接、信封、path、请求响应、推送、ID、错误和重连规则。
- 私有接口文档分为“当前已实现契约”和“冻结待开发契约”；冻结区只记录经过用户确认的目标契约，不记录未确认设想，当前区只记录真实可调用接口。一行能说明的接口只写一行，确实说不清时才在表格下补充。
- 删除接口或事件时同步删除文档条目，禁止保留已失效内容。

## 命名与模块入口

- 分层源码按归属使用 `l1-`、`l2-`、`l3-`、`l4-` 前缀；根目录、`bin/` 和构建发布入口按功能命名，不添加层级前缀。`bin/` 只保留命令入口，服务实现归入 `src/server/`，禁止源码反向导入 `bin/`。
- Next 保留文件名和第三方生成组件是例外。
- 同一业务在 `client/server/common` 使用相同业务目录名和稳定前缀。
- 模块根目录只保留少量公共入口；内部按 `views`、`hooks`、`runtime`、`adapter`、`mapper`、`util` 等稳定职责组织。
- 跨模块使用 `@client/*`、`@server/*`、`@common/*`；同模块相邻文件可使用相对路径。
- 不使用深层 `../../..`，不创建职责模糊的全局 `utils.ts`、`types.ts` 或 `service.ts`。
- 不为了一个文件创建子目录，不提前定义未使用接口或扩展点。

## UI 边界

- `src/client/l4_foundation/ui/shadcn` 和 `ui/ai-elements` 是第三方生成层，默认禁止直接修改。
- 业务差异优先在 L2/L3 或项目自有 L4 UI 中封装；确需修改生成组件时先说明原因并获得用户确认。
- 新增 Shadcn 或 AI Elements 组件前先复用现有组件，并获得用户确认后通过官方 CLI 添加。
- AI Elements 只负责通用 AI 界面，不承载 Pi 会话、权限、业务状态或服务端调用。
- 宿主与插件界面设计统一使用维护者提供的 ui-design Skill；开始界面任务前先取得对应版本，视觉与交互设计规则不在本仓库重复维护。

## 客户端组件模块

- L2 业务组件入口只负责页面/区域组装、展示状态和用户事件分发；不得同时堆叠 HTTP 请求、响应解析、WebSocket 消息解析、浏览器持久化、重连和弹窗业务流程。
- 涉及 HTTP API、WebSocket、浏览器存储或跨模块能力的业务步骤由同业务目录的 `l2-<业务>-biz.ts` 编排；具有独立生命周期的展示状态和订阅逻辑放入 `hooks/`；纯展示子组件放入 `views/`。
- 业务子组件只接收展示数据和事件回调，不直接调用外部能力；模块入口通过少量稳定 props 组装子组件，避免子组件绕过业务入口依赖内部实现。
- 按职责边界拆分，不按行数机械拆分：当一个组件同时承担布局组装、远程数据生命周期和多个独立交互流程时必须拆开；强绑定且简单的展示逻辑可以保留在一起。
- 不为了单个文件预建目录；同一稳定职责至少有两个文件或明确会持续扩展时，使用 `views/`、`hooks/`、`runtime/`、`adapter/`、`mapper/`、`util/` 等已有目录名。

## E2E 与视觉测试

- E2E 和视觉测试必须复用 `tests/l4-e2e-server-runtime.mjs` 启动 Pi Desk，不得使用临时 `pnpm dev` 后台命令绕过统一生命周期。
- `PI_CODING_AGENT_DIR` 和 `PI_CODING_AGENT_SESSION_DIR` 必须指向 `<项目根目录>/temp/pi/<测试入口>/<本次运行>/agent/` 下的独立目录；禁止读取默认 `~/.pi/agent`、真实 WorkSession 或真实登录记录。
- 测试结束时必须终止完整 Windows 进程树并确认端口释放，不得遗留 pnpm、tsx、Next 或浏览器进程。

## 开发约定

- 先复用，再新增；优先完成当前闭环，不提前铺设未来能力。
- 每个文件保持单一边界；按职责变化拆分，不按行数机械拆分。
- 禁止使用 `as any` 规避类型检查；函数明确返回类型。
- 注释只解释边界、原因和约束。
- 修改文件后格式化相关文件，并执行与改动直接相关的检查。

## 常用命令

- `pnpm dev`
- `pnpm build`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm check:layers`
- `pnpm check`
- `pnpm format`

**开发期间绝不要运行 `next build`**

## 其他规范

- l2 l3 l4 每一层对外的那个类 或者 文件。只保留必要的接口或者入口。优先复用。或者考虑是否真的必要。
- 项目按单用户操作场景设计，一个用户会打开多个设备，但是不会同时操作，不为极低概率的两个设备同时操作引入 revision 锁、复杂冲突协议或幂等缓存。服务端只需串行处理修改，后到的有效请求生效；出现网络或集合不一致时返回错误并让客户端重新获取快照。
- 涉及新增接口、修改协议必须经过用户同意，同时维护对应的私有接口文档。

## 常见问题避免

- Pi Package 与业务插件默认保持独立，不得互相依赖或借用对方的运行态、生命周期、Task、配置 Owner；只有已经明确属于通用底座且被多个真实消费者复用的稳定能力才允许下沉共享。
- 消息展示协议由最终 `viewKey` 对应的 Message Declaration/View 拥有；`fixed.type` 只表示公共消息分类和生命周期。仅单个 View 消费的数据必须放入该 `viewKey` 的 Summary/Detail Schema，不得扩充通用 Tool Schema；客户端只按最终 `viewKey` 选择 View，并保留第三方 Declaration 改写和高优先级 View 覆盖能力。
- 设计或实现 Pi Desk Plugin UI、Browser Module、Global Application、Composer Panel、Settings Page、Message Declaration 或 Message View 前，必须先向用户取得对应版本的 SDK UI 标准及适用分册并完整阅读；不得为单个插件绕过统一入口、Host Capability、Mount/Dispose、消息协议或错误视图边界。
- 只有插件运行代码、已实现公共 API/类型、构建入口或运行依赖变化时才升级版本；仅文档、注释或测试变化不升级、不发布。完成直接相关的 build、test 和 pack 内容检查后，列出包名、版本、Registry 和验证结果，获得用户明确确认后才能发布；不得默认更新本机全局插件。
- 从 AI Elements、旧版 Shadcn 或第三方示例引入交互组件时，必须按当前 Base UI Primitive 核对 data 属性和 CSS 变量，不得直接沿用 Radix 的 `data-[state=*]` 写法。
- 很多通用组件能力应该优先使用Shadcn UI。如果没有就征求用户同意后添加。
- pi-desk-sdk是通用协议。 如果插件开发需要改协议。必须重点说明争取用户的同意。新增东西的时候需要思考。是否真的有必要。是否可以被其他的插件复用。是否确定了现有的能力不满足。
- 当 `plugins/` 下的代码被更新时。需要顺手递增一下版本。
