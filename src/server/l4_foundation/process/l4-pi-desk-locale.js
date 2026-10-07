'use strict'

const { createInstance } = require('i18next')

const messages = {
  en: {
    cli: {
      port: 'Port must be an integer from 1 to 65535: {{value}}',
      hostname: 'Invalid listening hostname: {{value}}',
      standby: 'Standby warm-up requires both --standby-ready-file and --standby-activate-file',
      nodeRequired: 'Pi Desk requires Node.js {{minimum}} or newer.',
      nodeCurrent: 'Current Node.js version: {{version}}.',
      logCreate: 'Could not create the Pi Desk managed log: {{message}}',
      logWrite: 'Could not continue writing the managed log: {{message}}',
      installIncomplete:
        'Pi Desk installation is incomplete: TypeScript runtime dependencies are missing.',
      browserOpen: 'Could not open the browser automatically: {{message}}',
      packageFailed: 'Plugin maintenance failed; the core service will restart: {{message}}'
    }
  },
  'zh-CN': {
    cli: {
      port: '端口必须是 1 到 65535 的整数：{{value}}',
      hostname: '监听主机名无效：{{value}}',
      standby: '候选预热必须同时提供 --standby-ready-file 和 --standby-activate-file',
      nodeRequired: 'Pi Desk 需要 Node.js {{minimum}} 或更高版本。',
      nodeCurrent: '当前 Node.js 版本：{{version}}。',
      logCreate: '无法创建 Pi Desk 托管日志：{{message}}',
      logWrite: '无法继续写入托管日志：{{message}}',
      installIncomplete: 'Pi Desk 安装不完整：找不到 TypeScript 运行依赖。',
      browserOpen: '无法自动打开浏览器：{{message}}',
      packageFailed: '插件维护失败，核心服务仍会重新启动：{{message}}'
    }
  }
}

function resolveCliLocale(env = process.env) {
  const value =
    env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale
  return /^zh(?:[-_]|$)/i.test(value) ? 'zh-CN' : 'en'
}

const translation = createInstance()
void translation.init({
  lng: resolveCliLocale(),
  fallbackLng: 'en',
  resources: messages,
  ns: ['cli'],
  defaultNS: 'cli',
  initAsync: false,
  interpolation: { escapeValue: false }
})

function cliText(key, params) {
  return translation.t(key, params)
}

module.exports = { cliText, resolveCliLocale }
