# Pi Desk 文档

这里只说明 Pi Desk 相对原生 Pi 新增或不同的行为。Pi 的配置、模型、会话格式和扩展基础沿用官方资料，不在此重复维护。

## 按任务查阅

| 任务                                    | 资料                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| 让 AI 管理 Pi Desk、安装或重载插件      | [管理命令](./commands.md)                                 |
| 开发 Pi Desk 应用、面板、通知或消息视图 | [插件开发](./plugins.md)，含可直接加载的最小示例          |
| 安装、启动或升级 Pi Desk                | [官网：安装与启动](https://pidesk.dev/docs/installation/) |
| 配置模型并完成第一次对话                | [官网：开始对话](https://pidesk.dev/docs/quickstart/)     |
| 从手机或其他设备访问同一服务            | [官网：远程访问](https://pidesk.dev/docs/devices/)        |
| 使用 Docker 部署、升级或备份            | [官网：Docker](https://pidesk.dev/docs/docker/)           |
| 排查启动、模型、会话或插件问题          | [官网：常见问题](https://pidesk.dev/docs/faq/)            |

本目录及示例随当前 Pi Desk 版本分发；官网链接需要联网。已有官网说明先通过链接复用，不在本目录另存一份。

## 需要原生 Pi 能力时

优先读取会话系统提示所指向的已安装 Pi 文档和示例；下表路径相对那个 Pi 文档目录，不是当前工作目录或本目录。在线入口为 [Pi 官方文档](https://pi.dev/docs/latest)，版本差异以实际安装版本的文档和类型为准。

| 主题                          | Pi 官方资料                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| 配置作用域、设置与环境变量    | `configuration.md`、`settings.md`、`environment-variables.md` |
| 模型、服务商与自定义 Provider | `models.md`、`providers.md`、`custom-provider.md`             |
| 会话历史、上下文与压缩        | `sessions.md`、`session-format.md`、`compaction.md`           |
| 原生工具、命令、事件与包      | `extensions.md`、`packages.md`                                |
| Skills、提示模板与终端主题    | `skills.md`、`prompt-templates.md`、`themes.md`               |
| MCP 与 codemode               | `mcp.md`、`codemode.md`                                       |
| 嵌入 Pi、进程控制与终端 UI    | `sdk.md`、`rpc.md`、`json.md`、`tui.md`                       |
| 原生权限与项目信任            | `security.md`                                                 |

Pi Desk 的工作会话、界面操作和宿主管理与原生 Pi 命令不一定一一对应；这些差异归入下面的增量主题。

## 待补充主题

以下文件尚未创建，当前使用上面的已有资料。补充时只写右列范围，完成后加入任务导航。

| 文件                 | 只补充的 Pi Desk 内容                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `usage.md`           | 工作会话、固定与并排、界面分支/Fork、消息队列、文件/Git 和终端操作；多设备共享与本地状态的区别 |
| `configuration.md`   | 宿主设置、项目默认模型、能力模式与配置生效范围；哪些变更需要重载                               |
| `running.md`         | 主程序启动、桌面托管、服务与访问设备的区别，日志、数据位置、更新和重启影响                     |
| `troubleshooting.md` | 按宿主启动、连接、模型接入、插件加载分层排查，定位日志与恢复入口                               |

插件开发继续维护在 `plugins.md`；Session、通知和消息视图示例按实际需要加入 `examples/`，不预建空示例目录。
