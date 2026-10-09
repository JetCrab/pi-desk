import 'server-only'

export type L4PiDeskPluginAction = 'list' | 'show' | 'install' | 'remove'

export type L4PiDeskCommand =
  | { kind: 'help'; message: string }
  | { kind: 'version' | 'info' }
  | { kind: 'session'; action: 'reload' }
  | {
      kind: 'plugins'
      action: L4PiDeskPluginAction
      name?: string
      names?: string[]
      version?: string
      tag?: string
      checkUpdates?: boolean
    }

interface CommandDefinition {
  path: readonly string[]
  description: string
  name?: 'single' | 'multiple'
  scope?: 'optional' | 'required'
  version?: boolean
  tag?: boolean
  checkUpdates?: boolean
}

const definitions: readonly CommandDefinition[] = [
  { path: ['--version'], description: '查看 Pi Desk 版本' },
  { path: ['info'], description: '查看当前宿主环境与目录' },
  {
    path: ['session', 'reload'],
    description: '等待当前会话空闲后重载 Pi 配置与已安装插件；完成后通知并唤醒本会话'
  },
  {
    path: ['plugins', 'list'],
    description: '查看全局插件及维护状态；可按跟随渠道筛选并检查更新，不改变渠道',
    scope: 'optional',
    tag: true,
    checkUpdates: true
  },
  {
    path: ['plugins', 'show'],
    description: '查看插件详情',
    name: 'single',
    scope: 'required'
  },
  {
    path: ['plugins', 'install'],
    description: '安装、更新或重新安装一个或多个插件；版本可省略，完成后向本会话汇总结果',
    name: 'multiple',
    scope: 'required',
    version: true,
    tag: true
  },
  {
    path: ['plugins', 'remove'],
    description: '卸载一个或多个包来源；完成后向本会话汇总结果',
    name: 'multiple',
    scope: 'required'
  }
]

function usage(definition: CommandDefinition): string {
  return [
    'pidesk',
    ...definition.path,
    ...(definition.name ? [definition.name === 'multiple' ? '<name...>' : '<name>'] : []),
    ...(definition.scope === 'required'
      ? ['--scope global']
      : definition.scope
        ? ['[--scope global]']
        : []),
    ...(definition.checkUpdates ? ['[--check-updates]'] : []),
    ...(definition.version
      ? ['[--tag <tag> | --version <exact>]']
      : definition.tag
        ? ['[--tag <tag>]']
        : [])
  ].join(' ')
}

function help(path: readonly string[]): string {
  const matches = definitions.filter((definition) =>
    path.every((part, index) => definition.path[index] === part)
  )
  if (matches.length === 0) throw new Error('未知命令，请使用 pidesk --help')
  return [
    ...matches.map((definition) => `${usage(definition)}\n  ${definition.description}`),
    '各级命令均支持 --help。当前插件管理只支持 global 范围。',
    ...(path[0] === 'plugins' && (path.length === 1 || path[1] === 'install')
      ? [
          'install = install + update + reinstall。版本和渠道均可省略：新 npm 插件默认 latest，已有插件沿保存的渠道；--tag 选择跟随渠道，--version 固定完整版本号，两者互斥。',
          '多个插件可共用同一渠道或具体版本；同版本仍重新安装。',
          '本地扩展使用 Pi 全局 extensions 目录中的名字，加载当前代码；不接受版本、渠道或自定义路径。',
          '异步接纳不代表生效；结果会插入本会话并唤醒模型，无需持续查询。'
        ]
      : [])
  ].join('\n\n')
}

export function parseL4PiDeskCommand(args: readonly string[]): L4PiDeskCommand {
  if (args.length > 32) throw new Error('命令参数最多 32 项')
  if (args.length === 0) return { kind: 'help', message: help([]) }
  const definition = definitions.find((candidate) =>
    candidate.path.every((part, index) => args[index] === part)
  )
  if (
    args.includes('--help') ||
    args.includes('-h') ||
    (args.length === 1 && ['plugins', 'session'].includes(args[0]))
  ) {
    const group = ['plugins', 'session'].includes(args[0]) ? args[0] : null
    const path = definition?.path ?? (group ? [group] : [])
    if (!definition && !group && !['--help', '-h'].includes(args[0])) {
      throw new Error('未知命令，请使用 pidesk --help')
    }
    if (!definition && group && args[1] && !['--help', '-h'].includes(args[1])) {
      throw new Error(`未知子命令，请使用 pidesk ${group} --help`)
    }
    return { kind: 'help', message: help(path) }
  }
  if (!definition) throw new Error('未知命令，请使用 pidesk --help')

  const names: string[] = []
  let scope: string | undefined
  let version: string | undefined
  let tag: string | undefined
  let checkUpdates: boolean | undefined
  for (let index = definition.path.length; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--scope' && definition.scope) {
      if (scope !== undefined) throw new Error('--scope 不允许重复')
      scope = args[++index]
      if (!scope || scope.startsWith('--')) throw new Error('--scope 缺少范围')
    } else if (argument === '--version' && definition.version) {
      if (version !== undefined) throw new Error('--version 不允许重复')
      version = args[++index]
      if (!version || version.startsWith('--')) throw new Error('--version 缺少版本号')
    } else if (argument === '--tag' && definition.tag) {
      if (tag !== undefined) throw new Error('--tag 不允许重复')
      tag = args[++index]
      if (!tag || tag.startsWith('--')) throw new Error('--tag 缺少渠道标签')
    } else if (argument === '--check-updates' && definition.checkUpdates) {
      if (checkUpdates !== undefined) throw new Error('--check-updates 不允许重复')
      checkUpdates = true
    } else if (
      definition.name &&
      (definition.name === 'multiple' || names.length === 0) &&
      !argument.startsWith('-')
    ) {
      names.push(argument)
    } else {
      throw new Error(`不支持的参数：${argument}\n${usage(definition)}`)
    }
  }
  if (definition.scope === 'required' && scope === undefined) {
    throw new Error(`必须指定 --scope global\n${usage(definition)}`)
  }
  if (scope !== undefined && scope !== 'global') {
    throw new Error('当前插件管理只支持 global 范围，不支持项目级操作')
  }
  if (definition.name) {
    if (names.length === 0) throw new Error(`缺少插件名字\n${usage(definition)}`)
    for (const name of names) {
      if (
        !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name) ||
        name === 'node_modules'
      ) {
        throw new Error(`插件名字必须是扩展名字或完整 npm 包名，不接受路径或内嵌版本号：${name}`)
      }
    }
  }
  if (
    version !== undefined &&
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      version
    )
  ) {
    throw new Error('--version 必须是完整版本号，例如 1.2.3；版本可省略')
  }
  if (tag !== undefined && (tag.length > 128 || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(tag))) {
    throw new Error('--tag 必须是有效的渠道标签，例如 latest 或 dev')
  }
  if (tag !== undefined && version !== undefined) {
    throw new Error('--tag 与 --version 互斥，不能同时指定')
  }
  if (definition.path[0] === '--version') return { kind: 'version' }
  if (definition.path[0] === 'info') return { kind: 'info' }
  if (definition.path[0] === 'session') return { kind: 'session', action: 'reload' }
  return {
    kind: 'plugins',
    action: definition.path[1] as L4PiDeskPluginAction,
    ...(names.length === 1 ? { name: names[0] } : names.length > 1 ? { names } : {}),
    ...(version === undefined ? {} : { version }),
    ...(tag === undefined ? {} : { tag }),
    ...(checkUpdates === undefined ? {} : { checkUpdates })
  }
}
