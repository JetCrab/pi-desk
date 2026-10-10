import 'server-only'

export function renderL4PiDeskSystemPrompt(paths: {
  docsDirectory: string
  sdkRoot: string
}): string {
  return `Pi Desk 资料（仅在使用、管理 Pi Desk 或开发其插件时读取）：
- 文档入口：${paths.docsDirectory}/README.md
- SDK 公开类型声明：${paths.sdkRoot}/dist/
从入口选择并完整阅读对应文档及引用示例；原生 Pi 能力按入口引用查阅官方资料。相对路径从文档所在目录解析。`
}
