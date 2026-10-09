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
