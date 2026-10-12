export const documentGroups = ['开始使用', '使用指南', '插件', '帮助'] as const

export const documents = {
  '/docs/': {
    title: '概述',
    description: '多会话、可扩展、随处访问，延续 Pi 的精简理念。',
    group: '开始使用'
  },
  '/docs/installation/': {
    title: '安装与启动',
    description: '让 AI 帮你安装、下载客户端，或通过 Node.js 和 Docker 启动。',
    group: '开始使用'
  },
  '/docs/docker/': {
    title: 'Docker 部署与使用',
    description: '在 Linux 服务器上启动 Pi Desk，管理项目、会话、升级与备份。',
    group: '开始使用'
  },
  '/docs/quickstart/': {
    title: '开始对话',
    description: '配置模型、选择项目，开始对话。',
    group: '开始使用'
  },
  '/docs/devices/': {
    title: '远程访问',
    description: '设置访问密码，启动 Docker 隧道，在其他设备继续使用。',
    group: '使用指南'
  },
  '/docs/plugins/': {
    title: '安装与使用插件',
    description: '按需安装官方插件，为 Pi Desk 增加工具和界面。',
    group: '插件'
  },
  '/docs/background-tasks/': {
    title: '后台任务',
    description: '让命令在后台运行，前台继续独立工作，在任务中心查看日志和停止任务。',
    group: '插件'
  },
  '/docs/subagents/': {
    title: '子代理',
    description: '将独立子任务交给不同角色，查看执行过程，让结论回到主会话。',
    group: '插件'
  },
  '/docs/deliverables/': {
    title: '交付物',
    description: '让助手登记完成的项目文件，从会话侧栏集中查看与预览。',
    group: '插件'
  },
  '/docs/usage/': {
    title: '模型用量',
    description: '查看消耗趋势与模型分布，分析单个会话中主代理和子代理的用量。',
    group: '插件'
  },
  '/docs/context/': {
    title: '上下文管理',
    description: '查看上下文占用，保留对话，少带旧过程。',
    group: '插件'
  },
  '/docs/quota/': {
    title: '额度查看',
    description: '配置支持的服务来源，集中查看账户余额、额度窗口与重置时间。',
    group: '插件'
  },
  '/docs/tibo/': {
    title: 'Tibo 动态',
    description: '跟踪公开动态，阅读中文解读与原文，核对可能的 Codex 额度重置信号。',
    group: '插件'
  },
  '/docs/tool-reason/': {
    title: '工具调用理由',
    description: '在工具消息旁阅读简短调用目的，结合路径、命令和输出核对这一步操作。',
    group: '插件'
  },
  '/docs/remote-debug/': {
    title: '远程调试',
    description: '通过同机桌面端与已配置隧道，临时让其他设备访问项目开发网页。',
    group: '插件'
  },
  '/docs/development/': {
    title: '让 AI 开发插件',
    description: '说清需求，让 AI 参考 SDK 文档和现有项目完成开发。',
    group: '插件'
  },
  '/docs/faq/': {
    title: '常见问题',
    description: '定位启动、模型、插件和访问问题。',
    group: '帮助'
  }
} as const satisfies Record<
  string,
  { title: string; description: string; group: (typeof documentGroups)[number] }
>

export type DocumentPath = keyof typeof documents

export type DocumentContent = {
  html: string
  headings: { id: string; title: string }[]
}
