import { spawnSync } from 'node:child_process'

const WINDOWS_NODE_PACKAGE_MANAGERS = ['npm', 'npx', 'pnpm', 'yarn']

export interface ProcessTreeChild {
  stdout?: { destroy?(): void } | null
  stderr?: { destroy?(): void } | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export function shellInvocation(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env
): { shell: string; args: string[] } {
  if (platform === 'win32') {
    const prelude = WINDOWS_NODE_PACKAGE_MANAGERS.map(
      (name) =>
        `if command -v ${name}.cmd >/dev/null 2>&1; then ${name}() { command ${name}.cmd "$@"; }; fi`
    ).join('\n')
    return { shell: 'bash.exe', args: ['-c', `${prelude}\n${command}`] }
  }
  return { shell: env.SHELL || '/bin/sh', args: ['-c', command] }
}

export function signalProcessTree(child: ProcessTreeChild, pid: number, force: boolean): void {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true
    })
    if (!result.error && result.status === 0) {
      child.stdout?.destroy?.()
      child.stderr?.destroy?.()
      return
    }
  } else {
    try {
      process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
      return
    } catch {
      // 进程组不可用时回退到直接终止子进程。
    }
  }

  if (!child.kill(force ? 'SIGKILL' : 'SIGTERM')) {
    throw new Error(`无法终止 PID ${pid} 的进程树`)
  }
}
