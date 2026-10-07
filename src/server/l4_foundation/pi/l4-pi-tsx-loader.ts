import 'server-only'

function isTsxImport(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return normalized === 'tsx' || /(?:^|\/)tsx(?:\/|$)/.test(normalized)
}

export function readL4PiTsxImport(execArgv: readonly string[] = process.execArgv): string {
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index]
    if (argument === '--import') {
      const value = execArgv[index + 1]
      if (value && isTsxImport(value)) return value
      index += 1
      continue
    }
    if (argument.startsWith('--import=')) {
      const value = argument.slice('--import='.length)
      if (isTsxImport(value)) return value
    }
  }
  throw new Error('Pi Desk 服务缺少 tsx loader，无法启动插件维护子进程')
}
