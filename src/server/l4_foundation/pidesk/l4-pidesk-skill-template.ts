import 'server-only'

interface SkillPaths {
  agentDir: string
  sdkRoot: string
  piDocs: string
}

export function renderL4PiDeskSkill(paths: SkillPaths): string {
  return `---
name: pi-desk
description: 管理 Pi Desk，或开发、安装、更新、加载供 Pi Desk 使用的插件时使用。
---

# Pi Desk

通过 \`pidesk\` 工具执行宿主命令，参数为 \`{ "args": ["命令", "子命令", "参数"] }\`。当前命令以 \`["--help"]\` 为准，具体命令也支持 \`--help\`。

- 插件开发、安装、更新或卸载：先阅读 [插件管理](references/plugins.md)。
- 开发 Pi Desk 插件：阅读 ${paths.sdkRoot}/README.md 和当前版本的公开类型声明；涉及界面时，先向用户取得对应版本的 UI 标准及分册，并完整阅读。
- 原生 Pi 扩展：阅读 ${paths.piDocs}/extensions.md。

## 执行结果

- \`mode: sync\`：本次执行已经结束，直接使用返回结果。
- \`mode: async\`：本次操作已接纳，尚未完成。宿主会向本会话插入最终结果并唤醒模型；无独立工作时结束当前轮，不持续查询或重复提交。
- 工具报错表示请求失败；不能把已接纳、等待加载或等待重启说成已生效。

## 重载当前会话

调用 \`{ "args": ["session", "reload"] }\`，等同输入框“更多 → 重载 Pi 配置”。保留聊天历史与当前分支，重新加载 Pi 配置、Skills 和本机已安装插件的当前代码；不会自动下载插件新版本，需要更新时先使用插件安装命令。

接纳后结束本轮对话，等待宿主在当前会话完全空闲后执行；最终结果会通知并唤醒本会话。重载可能重建插件内存状态、使缓存失效；配置或工具定义变化也可能影响模型的提示词缓存命中。

## 当前目录

Pi AgentDir：${paths.agentDir}
全局本地扩展：${paths.agentDir}/extensions

这些文件由当前宿主启动时生成；修改指引应修改宿主源码中的模板。
`
}

export function renderL4PiDeskPluginGuide(agentDir: string): string {
  return `# 插件管理

通过 \`pidesk\` 的 \`plugins\` 子命令复用设置中的插件管理。当前只支持全局范围；项目级管理与裸扩展卸载不在当前能力中。

| 任务 | args |
| --- | --- |
| 查询清单与状态 | \`["plugins", "list"]\` |
| 批量检查更新 | \`["plugins", "list", "--check-updates"]\` |
| 只检查跟随 dev 的插件 | \`["plugins", "list", "--check-updates", "--tag", "dev"]\` |
| 查询插件详情 | \`["plugins", "show", "<name>", "--scope", "global"]\` |
| 安装、更新或重装 | \`["plugins", "install", "<name>", "--scope", "global"]\` |
| 批量安装或更新 | \`["plugins", "install", "<name-1>", "<name-2>", "--scope", "global"]\` |
| 安装并跟随 dev 渠道 | \`["plugins", "install", "<name>", "--scope", "global", "--tag", "dev"]\` |
| 安装指定 npm 版本 | \`["plugins", "install", "<name>", "--scope", "global", "--version", "1.2.3"]\` |
| 批量卸载包来源 | \`["plugins", "remove", "<name-1>", "<name-2>", "--scope", "global"]\` |

\`install/remove\` 可传一个或多个名字；批量安装共用所选标签或版本。不指定版本或标签也可以安装。

## 本地开发

源码放在 ${agentDir}/extensions/<name>/，使用插件清单或固定目录中的名字，不传自定义路径。单文件扩展也可使用清单中的名字。

开发完成后验证代码并调用 \`install\`，修改后仍调用 \`install\` 重新加载当前代码。原生 TypeScript 可直接加载；存在浏览器构建入口时先完成必要编译，不要求发布 npm 或生成安装包。本地来源不接受 \`--version\` 或 \`--tag\`。

## npm 插件

使用完整 npm 包名，例如 \`@example/plugin\`。\`install\` 统一表示首次安装、更新和重新安装；已是目标版本也执行重装。

版本和标签均可省略：新插件默认 \`latest\`，已有插件沿保存的更新渠道。\`--tag dev\` 安装该标签指向的版本并保存后续跟随渠道；\`--version\` 只指定本次完整版本，不改变已有渠道。两者不能同时使用，不从版本后缀猜测更新渠道。

\`list --check-updates\` 按各插件自己的渠道检查；附加 \`--tag dev\` 只检查跟随 dev 的插件，不修改渠道、不执行安装。缺少标签或查询失败仅报告对应项错误，不回退 latest。需要只调整渠道、不安装时，在插件管理界面多选后使用“设置渠道”。

插件文件与 \`settings.json\` 由 Pi 官方包管理器维护。不要直接覆盖配置或自行修改安装目录。存在同名来源冲突时，先确认目标，不猜测。

## 生效与卸载

安装与卸载接纳后由宿主串行处理，只等待目标插件必要的在途调用，不冻结常规聊天、不自动重载已有 Pi 会话。完成表示插件包及宿主能力已应用；新建会话采用最新工具配置，需要让已有会话采用新版工具时，再按用户需要重载该会话。

每批只发送一条结果汇总，逐项区分成功、未接纳、失败和等待重启；部分失败不代表其他项失败。最终结果以会话通知为准，需要重启时沿用插件管理界面的维护流程，不能提前报告成功。

\`remove\` 只作用于现有插件管理支持的包来源，不附带业务数据清理，不用删除源码或新增禁用规则代替卸载。
`
}
