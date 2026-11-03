export type Result = { name: string; passed: boolean; detail?: string }
export type Call = { command: string; args: Record<string, unknown> }

declare global {
  interface Window {
    __desktopTest: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
      listen: (name: string, listener: () => void) => Promise<() => void>
      results: Result[]
      current: string
      done: boolean
    }
  }
}
