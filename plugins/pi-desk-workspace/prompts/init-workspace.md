---
description: 为尚未配置的项目设计并实现一套隔离工作区命令
---

# 配置项目的隔离工作区能力

为当前项目完成一次性接入：调查项目的开发方式，和用户确定隔离边界，在 `.pi/pi-desk.yaml` 的 `plugins.workspace` 分组生成配置及配套 Node Handler。最终产出是一套可复用、用途明确的项目命令，不是某次需求的工作区。

完成后，未参与配置的 AI 仅凭 `workspace` 工具返回的命令说明、参数和执行结果，就能操作工作区。正常使用不需要阅读 Handler，也不需要手工补充环境准备、启动或清理步骤。

本提示词包含所需的插件配置合同。读取待配置项目的规则和脚本即可，不需要读取插件源码或另找配置 Skill。

## 1. 入口与职责

`/init-workspace` 只用于尚未配置的项目，不接收需求名称、需求分支等任务参数。以当前会话 CWD 为项目根目录；若该目录不是用户要接入的目录，先确认并让用户在目标目录打开会话。插件不会向上查找 Git 根目录的配置。

先检查 `<项目根目录>/.pi/pi-desk.yaml` 的 `plugins.workspace` 分组。只要该分组已存在，就说明项目已有配置并结束，不在此入口覆盖、修复或迁移；仅有共享文件或其他分组不表示已配置工作区。若只有残留的 `.pi/workspace/` 脚本，先确认其用途，不覆盖未知文件。

| 入口或对象          | 职责                                                           |
| ------------------- | -------------------------------------------------------------- |
| `/init-workspace`   | 一次性设计并实现项目命令，不分配工作区、不开始需求开发         |
| `workspace acquire` | 日常由插件分配可复用目录；没有兼容目录时创建并调用 `provision` |
| `workspace run`     | 日常执行配置中声明的项目命令，调用者不手工执行 Handler         |
| 插件                | 管理工作区目录、占用、复用、命令调度、日志和状态转换           |
| 项目 Handler        | 实现源码、依赖、构建、运行、测试环境和资源回收                 |

工作区提供目录隔离，不是容器或权限沙箱。数据库、外部服务、端口和进程是否隔离，取决于项目命令的实现。

## 2. 调查项目并确定方案

先读取项目规则、仓库结构、工具链与锁文件、已有安装/构建/启动/测试脚本及本地运行说明。沿实际依赖调查，不扫描无关业务代码。

整理下表。已有明确约定的直接采用；缺少依据、且会改变命令行为的事项再询问用户。不要让用户重复提供可从项目读取的信息。

| 需要确定的内容 | 调查与确认重点                                                                                   |
| -------------- | ------------------------------------------------------------------------------------------------ |
| 源码范围       | 单仓库、多仓库或普通目录；需要哪些目录；采用 clone、worktree 还是复制；标准源码基线是什么        |
| 分支规范       | 是否需要需求分支命令；分支起点、命名与远程跟踪规则；是否允许命令推送。此处不询问某次需求的分支名 |
| 支持的能力     | 仅隔离源码，还是还需准备依赖、构建、启动、测试；优先复用项目已有脚本                             |
| 工具链与配置   | 所需程序、版本和项目配置如何取得；遵守现有机器配置方式，不复制其他项目的路径                     |
| 隔离与共享     | 端口、进程、产物、日志、测试证据如何归属；数据库、缓存、外部服务和业务附件共享还是独立           |
| 准备与复用     | 哪些内容首次准备，哪些按需准备；缓存保留条件及失效判断；复用前恢复到什么基线                     |
| 成果与回收     | 如何保护未提交、未推送内容；哪些数据和证据必须保留；资源何时释放；哪些操作另需授权               |

先向用户给出简短方案：工作区结构、共享/隔离边界、首次准备内容、命令表和回收规则。命令表列出用途、参数、前置条件、主要副作用和成功结果。明确未决问题，获得确认后再写项目文件。

一个项目先定义一套满足实际需要的工作区。只有存在确实不同、不能共用同一套准备与命令的环境时，才增加 definition。

## 3. 设计稳定的命令接口

按调用者目标拆命令，不按内部 Shell 步骤拆命令。稳定的仓库结构、工具链和回收规则留在项目实现中；需求分支、操作范围等调用者意图作为参数。可由实现确定的临时路径、PID 等不交给调用者管理。

### 必需与按需能力

插件 Schema 要求 `provision` 和非空 `commands`，不强制具体命令名。以下是本次项目接入采用的命令规范，不代表插件内置了这些行为。

| 能力                      | 要求                                           | 完成语义                                                   |
| ------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| `provision`               | 必需，首次创建时自动调用，不重复定义为普通命令 | 准备约定的源码与基础环境；可以将耗时依赖或构建留给后续命令 |
| `reset`                   | 必需，`occupied → available`                   | 检查成果、停止所属服务、清理本次占用并恢复可复用基线       |
| `remove`                  | 必需，`available/occupied → removed`           | 检查成果、清理所属资源并实际删除整个工作区                 |
| `prepare-runtime`         | 依赖或环境需要按需准备时提供                   | 完成指定范围准备，复用有效结果；说明是否包含构建           |
| `prepare-branch`          | 项目需要封装需求分支流程时提供                 | 按项目规范准备指定分支；明确是否推送及跟踪关系             |
| `build`                   | 需要生成构建产物时提供                         | 返回产物位置和构建结果，不代表功能测试通过                 |
| `start`、`status`、`stop` | 需要托管服务时成组提供                         | 分别负责就绪、真实状态查询、停止与资源释放                 |
| `test`                    | 有实际可执行的测试入口时提供                   | 执行约定范围测试，返回结果与证据位置                       |
| `test-target`             | 外部测试需要获取工作区目标时提供               | 返回有效地址、测试批次与证据目录，不代表已执行业务测试     |

没有实际需求的可选命令不生成。项目独有能力使用含义明确的命令名；同一目标不同时提供多套等价入口。

### 每个命令的约定

逐个落实以下内容。稳定使用所需的信息写进 `description`、参数说明和执行结果，不只写在初始化会话或内部注释里。

| 合同项     | 设计要求与原因                                                                   |
| ---------- | -------------------------------------------------------------------------------- |
| 用途与前置 | 说明何时调用、必要准备及顺序；缺少前置时指出该执行哪个命令，避免调用者猜流程     |
| 参数       | 说明含义、默认值、允许值；只保留确实影响行为的参数，减少调用负担                 |
| 副作用     | 明确安装、构建、推送、启动、删除等行为；`status` 不偷偷安装或构建                |
| 成功条件   | 完成目标才返回成功；`start` 要达到约定就绪条件，`reset` 要真正恢复基线           |
| 结果       | 返回后续所需的地址、路径和摘要；区分构建、连通性检查与业务测试                   |
| 重复调用   | 明确复用、无操作成功或拒绝；不能重复启动服务或忽略环境已变化                     |
| 失败       | 返回原因、部分完成情况和可操作的下一步；保留必要现场，不要求调用者读实现才能判断 |
| 资源归属   | 每个进程、端口、目录和外部资源都有 owner 与释放条件；只清理本工作区拥有的资源    |

准备和清理必须覆盖部分失败的情况。`remove` 应能处理首次准备未完成的工作区；`reset` 若无法恢复完整基线，应失败并保持占用，不能假装可复用。默认保护未提交、未推送成果；强制丢弃能力仅在项目确需且用户确认后提供。

常驻服务的生命周期不能等同一次 Handler 调用。若提供 `start`，项目实现要有可追踪的进程归属、就绪检查、停止和退出清理；不能把后台启动成功当成服务就绪，也不能按端口直接杀死未知进程。简单项目不为此预建服务管理框架。

## 4. 配置与 Handler 合同

### 文件和 YAML

配置固定为 `<项目根目录>/.pi/pi-desk.yaml` 的 `plugins.workspace` 分组。写入时保留共享文件的其他分组及内容，仅写项目明确需要的覆盖，不复制全局或默认值。Handler 与其项目内部模块放在 `.pi/workspace/`，简单能力直接写在 Handler 中，复杂且复用的实现再提取模块。

下面是 Node 项目的 `plugins.workspace` 分组内容示例，展示必需生命周期和一个可选测试命令；将其置于共享文件该分组下，不写到根层。按已确认方案生成实际实现，不把示例说明或未实现的命令当成最终交付。

```yaml
schema: pi.workspace/v3
definitions:
  development:
    description: 项目源码开发工作区；运行依赖按项目约定准备
    provision:
      description: 准备项目约定的源码与基础环境
      handler: .pi/workspace/provision.mjs
      timeoutSeconds: 1800
    commands:
      test:
        description: 源码和依赖就绪后执行项目测试；不构建或启动服务
        from: [occupied]
        onSuccess: occupied
        handler: .pi/workspace/commands/test.mjs
        timeoutSeconds: 900
      reset:
        description: 检查成果后恢复项目基线并释放；保留约定的有效缓存
        from: [occupied]
        onSuccess: available
        handler: .pi/workspace/commands/reset.mjs
        timeoutSeconds: 900
      remove:
        description: 检查成果、释放所属资源并删除整个工作区
        from: [available, occupied]
        onSuccess: removed
        handler: .pi/workspace/commands/remove.mjs
        timeoutSeconds: 900
```

- `definitions`、每项 `commands` 都是非空对象。每个 definition 只包含 `description`、`provision`、`commands`。
- definition ID、command ID、参数名使用小写 kebab-case，如 `development`、`prepare-runtime`、`build-admin`。
- definition、provision、每个 command 都必须有非空 `description`。
- provision 只支持 `description`、`handler`、可选 `parameters`、可选正整数 `timeoutSeconds`；command 额外必须有 `from`、`onSuccess`。
- Handler 路径相对原项目根目录，必须位于 `.pi/workspace/`、以 `.mjs` 结尾、使用 `/` 分隔，不能含绝对路径、反斜杠、`.` 或 `..` 路径段。
- YAML 不使用 anchors、aliases、自定义 tags、多文档或未列出的字段。没有参数时直接省略 `parameters`。

参数格式如下，可放在 provision 或单个 command 下。这不是任意 JSON Schema；`required` 写在每个属性内，不是顶层数组。

```yaml
parameters:
  type: object
  additionalProperties: false
  properties:
    scope:
      type: string
      required: false
      default: related
      enum: [related, full]
      description: related执行相关测试，full执行全部测试
```

属性类型支持 `string`、`boolean`、`integer`、`number`、`array`。每项必须显式包含 `required: true|false`，可带 `description`、`default`、`enum`；array 可带 `items`。`items` 只支持 `type`、`description`、`enum` 和递归 `items`。默认值和枚举必须符合类型，未声明的参数会被拒绝。

provision 参数是物理工作区复用条件的一部分，不放需求标题或需求分支。仅在准备方式确实需要调用者选择环境差异时声明。

### Handler API

每次调用使用独立 Node 子进程。Handler 默认导出异步函数 `run(input, context)`；函数名可以按职责命名。

| input 字段                                                         | 含义                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `schema`                                                           | 固定为 `pi.workspace-command/v2`，由插件提供             |
| `command`                                                          | 当前命令 ID，首次准备为 `provision`                      |
| `project.root`                                                     | 原项目绝对目录；Handler 从该项目加载                     |
| `workspace.id`、`workspace.root`                                   | 物理工作区 ID 与绝对目录                                 |
| `workspace.definition`                                             | 对应 definition ID                                       |
| `workspace.provisionParameters`                                    | 创建该物理工作区时校验并补默认值后的初始化参数           |
| `occupation.id`、`occupation.requirement`、`occupation.occupiedAt` | 本次占用 ID、简短需求名、Unix 毫秒时间                   |
| `parameters`                                                       | 当前命令校验并补默认值后的参数；provision 时为初始化参数 |

`context` 只提供：

- `signal`：中断信号，长步骤应响应取消并清理自己创建的资源。
- `log(message)`：记录诊断信息；在关键阶段记录范围、结果和失败原因。
- `exec(program, args, { cwd? })`：程序和字符串参数数组分开传入；默认 cwd 为 `input.workspace.root`。成功返回 `{ stdout, stderr, code }`，非零退出码抛错；不是带有任意选项的 Shell API。

Node 文件 API 的相对路径仍依赖进程 CWD，不会自动指向工作区。使用 `input.project.root` 或 `input.workspace.root` 拼出明确路径。Windows 的 `.cmd/.bat` 由 `context.exec` 适配，不依赖 POSIX 管道或变量展开；工具链仍需在本机可用。优先使用 Node 内置模块和项目已有脚本；新增依赖归项目所有，不借用插件的依赖。

以下是 `.pi/workspace/commands/test.mjs` 的完整接口示例，仅适用于工作区 root 使用 Node 内置测试器的项目；实际程序、参数和 cwd 按项目调整。

```js
export default async function run(input, context) {
  context.log('开始执行项目测试')
  await context.exec(process.execPath, ['--test'], { cwd: input.workspace.root })
  return { success: true, summary: '项目测试通过' }
}
```

成功返回 `{ success: true, summary?: string }`；失败返回 `{ success: false, error: string }` 或抛出错误。`summary` 如提供，应非空且不超过 4000 字符；`error` 必须非空。返回值不携带自定义结果字段，不自己写结果信封或插件元数据。完整诊断写日志，摘要给调用者需要的结果与下一步。

### 工作区与状态边界

- 目录由插件分配在 `~/pi-workspaces/<project-key>/<workspace-id>`，项目按本机路径区分。root 已存在且带有 `.pi-workspace/` 元数据，不是空目录。
- 在约定子目录中准备仓库，或选择兼容已有目录的准备方法；不要直接把需要空目录的 clone/worktree 命令套到 root，也不要移动或删除元数据来腾空目录。
- 工作区 root 与 `.pi-workspace/` 不能是 symlink/junction。除物理删除整个工作区外，保留 `.pi-workspace/`；Handler 不修改其中的 `workspace.json`，Git 清理也必须保留它。
- `available` 表示已恢复约定基线、可直接分配；`occupied` 表示属于本次占用。没有 `running`、`failed` 等持久状态。
- `from` 是非空数组，只能包含 `available`、`occupied`；`onSuccess` 只能是 `available`、`occupied`、`removed`。普通操作保持 `occupied`，reset 释放为 `available`，remove 要实际删除 root。
- 从 available 执行命令时，插件先创建占用，再调用 Handler。因此失败后保持 occupied，不自动恢复 available。
- 插件仅在执行成功、结果有效及路径/元数据后置检查通过后转换状态。失败不自动回滚已经发生的文件、进程或外部副作用；结果未知时先查日志与状态，不盲目重放。
- acquire 只复用同一项目、definition、初始化参数完全匹配的 available 目录。复用时不再执行 provision，所以 reset 必须恢复完整基线；可选准备命令负责其约定的后续准备。
- 选择工作区不改变 Pi 会话 CWD。项目命令应封装所需目录切换，不要求调用者切换会话或手工找内部脚本。

## 5. 实现、检查与交付

按确认的方案生成配置和真实可执行的 Handler。保持命令接口与实现一致，不用空函数返回成功代替准备、清理或验证。项目资料按项目自身归属规则保存，不把初始化会话作为后续使用所需的唯一依据。

检查所有配置字段、命令说明、参数、状态转换和 Handler 路径；对每个 `.mjs` 执行 `node --check <路径>`。核对实现中的源码基线、共享资源、缓存和清理范围符合确认方案。

配置完成后重载当前会话：

- Pi Desk：调用 `pidesk` 工具 `{ "args": ["session", "reload"] }`。接纳后结束当前轮，等待重载完成通知再继续。
- 独立 Pi：提示用户执行 `/reload`，完成后继续验证。

重载后通过 `workspace` 的 `list` 查询确认项目定义及命令已识别，不需要先 acquire。工具未出现时检查项目是否受信任、配置路径与错误提示；不要为了绕过注册条件手工执行 Handler。

默认不创建工作区、不创建需求分支、不启动服务。真实生命周期验收需单独确认范围，通过插件执行，并清理验收创建的资源；未执行时明确说明，语法和加载检查不等于运行验收。

最终输出：

1. 生成文件及项目的共享/隔离边界。
2. 定型命令表：用途、参数与默认值、前置条件、主要副作用、成功结果。
3. 已完成的检查、未验证项和阻塞；需要用户重载时给出对应操作。

交付前以不知内部实现的调用者视角检查：能否仅靠工具中的命令说明、参数和结果完成操作？若仍需猜命令顺序、读 Handler 或手工补步骤，先完善命令合同或实现再交付。
