# @jetcrab/pi-desk-workspace

为 Pi 会话分配可复用的隔离工作目录，并在 Pi Desk 会话侧栏中查看和管理工作区。项目通过 `.pi/pi-desk.yaml` 的 `plugins.workspace` 分组和 Node Handler 定义初始化与项目命令。

官方说明：[使用说明](https://pidesk.dev/docs/workspace/)

工作区是目录隔离，不是容器或权限沙箱。源码准备方式、依赖安装、端口分配和清理策略由项目 Handler 决定。

## 安装

在 Pi Desk 中调用管理工具：

```json
{ "args": ["plugins", "install", "@jetcrab/pi-desk-workspace", "--scope", "global"] }
```

等待安装完成；已有会话需要采用新插件时，再调用 `pidesk` 的 `session reload`。独立 Pi 可使用：

```bash
pi install npm:@jetcrab/pi-desk-workspace
```

只有当前项目已受信任、且存在有效的 `plugins.workspace` 配置时，插件才向模型注册 `workspace` 工具。新增或修改配置后需要重载当前会话；Pi 中使用 `/reload`，Pi Desk 中使用 `session reload`。

## 首次配置项目

在尚无 `plugins.workspace` 配置的项目会话中输入：

```text
/init-workspace
```

提示词随插件加载，不要求项目先有工作区配置，也不接收具体需求参数。AI 调查项目的仓库、工具链和运行方式，与用户确认共享/隔离边界，生成工作区定义及项目命令实现。配置规范要求 `provision`、`reset`、`remove`；依赖准备、分支、构建和测试命令按项目需要提供，需要托管服务时成组提供 `start/status/stop`。

已有配置时结束初始化，不覆盖或迁移。此入口不分配工作区、不创建需求分支、不启动服务；配置与语法检查、重载后的命令识别和另行授权的运行验收分别报告。配置完成后，通过 `workspace` 操作项目命令，正常使用不需要读取 Handler。

## 最小示例

下面演示插件协议的最小调用；项目接入时按 `/init-workspace` 的命令规范补齐生命周期。

在项目 `.pi/pi-desk.yaml` 中添加 `plugins.workspace`，保留其他分组。读取按默认值、全局、当前会话 CWD 的项目层逐字段覆盖，对象递归合并，数组整体替换；不向上查找父目录。Handler 路径仍相对原项目根目录。配置编辑只写明确的项目覆盖，不复制继承值。

```yaml
plugins:
  workspace:
    schema: pi.workspace/v3
    definitions:
      demo:
        description: 示例工作区
        provision:
          description: 准备示例文件
          handler: .pi/workspace/prepare.mjs
          timeoutSeconds: 30
        commands:
          reset:
            description: 将示例文件恢复为初始内容并释放工作区
            from: [occupied]
            onSuccess: available
            handler: .pi/workspace/prepare.mjs
            timeoutSeconds: 30
```

创建 `.pi/workspace/prepare.mjs`：

```js
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default async function run(input, context) {
  await writeFile(join(input.workspace.root, 'example.txt'), 'workspace baseline\n', 'utf8')
  context.log('示例文件已准备')
  return { success: true, summary: '示例基线已准备' }
}
```

重载后调用 `workspace` 工具：

```json
{ "action": "acquire", "definition": "demo", "requirement": "示例任务" }
```

返回 `root` 和本次占用的 `workspaceRef`。在返回的目录内操作文件，完成后执行：

```json
{ "action": "run", "command": "reset" }
```

再次 acquire 相同 definition 和初始化参数时，插件优先复用可用目录。此示例只恢复 `example.txt`，不会清理其他文件；真实项目应在 Handler 中定义完整的准备与复用基线。

## 工具调用

所有操作使用同一个 `workspace` 工具，通过 `action` 选择行为：

| action    | 输入                                           | 作用                                                                                  |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| `acquire` | `definition`、`requirement`、可选 `parameters` | 优先复用兼容的可用工作区，否则首次初始化；返回 root 和 workspaceRef，并选为当前工作区 |
| `info`    | 可选 `workspace`                               | 查询指定或当前工作区，以及项目定义的命令和参数                                        |
| `use`     | 完整 `workspaceRef` 作为 `workspace`           | 在当前会话选中已有占用；不传 workspace 则只取消当前选择                               |
| `run`     | `command`、可选 `workspace` 和 `parameters`    | 执行项目声明的命令；默认使用当前工作区                                                |
| `list`    | 无                                             | 查询当前项目的工作区池                                                                |

`requirement` 是简短单行任务名，去除首尾空白后非空，最多 20 个 Unicode 字符。已占用工作区必须使用完整 `workspaceRef`；每次重新分配都会生成新的引用，旧引用失效。

切换工作区不会改变 Pi 会话的 CWD，文件和命令操作应显式使用返回的 root。取消当前选择不会释放工作区；释放由项目命令的状态转换决定。

## 项目配置与生命周期

物理目录保存在 `~/pi-workspaces/<project-key>/<workspace-id>`，项目按本机路径区分。工作区 Root 直接作为项目目录；插件元数据位于其 `.pi-workspace/` 子目录中。

- `available`：已准备好，可被分配。
- `occupied`：属于本次占用，不进入复用池。
- 初始化参数属于复用条件：仅复用同一项目、definition 和初始化参数完全匹配的可用工作区。
- `provision` 只在首次创建物理目录时执行；复用前需要恢复的内容由项目的重置命令负责。
- 命令通过 `from` 声明允许的起始状态，通过 `onSuccess` 选择保持 `occupied`、释放为 `available` 或确认 `removed`。

Handler 必须位于项目的 `.pi/workspace/` 内，使用 `.mjs`，默认导出异步函数。`context.exec(program, args, { cwd? })` 默认在工作区 root 执行，程序与参数分开传入，非零退出码抛错。Windows 的 `.cmd`、`.bat` 通过 `cmd.exe` 适配，不应依赖 POSIX shell 的管道或变量展开；外部程序需要自行安装。

Handler 返回明确的 `{ success: true, summary? }` 或 `{ success: false, error }`。插件只在执行成功、结果有效、路径与元数据后置校验通过后应用 `onSuccess`。失败不释放工作区；从 available 执行命令时，会先占用再执行。结果未知时应先检查日志和实际状态，不直接重放操作。

除删除整个工作区的命令外，Handler 必须保留 `.pi-workspace/`，不得修改其中的 `workspace.json`。项目的清理和 Git 忽略规则也应保留这份插件元数据。

完整的项目命令设计流程、配置与 Handler 合同包含在 `/init-workspace` 提示词中；源码为 `prompts/init-workspace.md`，npm 包中为 `dist/prompts/init-workspace.md`，无需读取插件源码或额外配置附件。日常调用仍由 `workspace-usage` Skill 提供指导，源码位于 `skills/`，npm 包中位于 `dist/skills/`。

## Pi Desk 侧栏

会话侧栏“隔离工作区”支持查看占用与可用工作区、选择当前工作区、执行项目命令、查看活动记录和日志，以及打开来源会话。工作区由模型通过 acquire 获取，侧栏不提供人工创建入口。选中工作区后，输入框底部显示当前需求标题；旧长需求仅缩略展示，取消选择或占用失效后清除。

重置和删除按命令声明识别，执行前显示影响与确认。确认后立即关闭弹窗，列表显示提交状态；受理后在后台执行，可在任务中心查看进度、日志或停止任务。关闭侧栏不取消已提交的命令；执行期间仅禁用当前工作区的冲突操作，仍可查看记录、预览目录或操作其他工作区。

提交失败或结果未确认时，列表保留提示，重新打开详情可恢复原参数，不自动重试。页面最多保留最近 20 份失败草稿，刷新页面或重载插件后清空。后台命令失败保留占用、记录和日志，并显示错误通知；重连后从服务端快照恢复执行状态。模型通过工具执行 `workspace run` 时仍等待最终结果。

重置成功后清除本次占用与记录，目录保留以供复用；来源聊天不会被删除。每次占用最多保存 50 条活动记录，取消当前选择不会清除它们。

支持会话多目录预览的宿主会登记选中工作区的 root，供文件查看器使用；这不会改变 Pi CWD。独立 Pi 使用同一工具与项目配置，不提供 Web 侧栏。

## 开发

在仓库根目录安装依赖后，构建 SDK 和本插件：

```bash
pnpm build:plugin-host-runtime
pnpm --filter @jetcrab/pi-desk-workspace build
pnpm --filter @jetcrab/pi-desk-workspace test
```

许可证：[Apache-2.0](LICENSE)。
