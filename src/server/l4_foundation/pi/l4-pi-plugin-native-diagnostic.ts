import 'server-only'

const L4_PI_NATIVE_DIAGNOSTIC_LIMIT = 100

export interface L4PiPluginNativeDiagnostic {
  cwd: string
  message: string
}

function diagnostics(): L4PiPluginNativeDiagnostic[] {
  if (!globalThis.__piDeskNativePluginDiagnostics) {
    globalThis.__piDeskNativePluginDiagnostics = []
  }
  return globalThis.__piDeskNativePluginDiagnostics
}

export function reportL4PiPluginNativeDiagnostic(cwd: string, message: string): void {
  const records = diagnostics()
  if (records.some((record) => record.cwd === cwd && record.message === message)) return
  records.push({ cwd, message })
  if (records.length > L4_PI_NATIVE_DIAGNOSTIC_LIMIT) {
    records.splice(0, records.length - L4_PI_NATIVE_DIAGNOSTIC_LIMIT)
  }
}

export function clearL4PiPluginNativeDiagnostics(path: string): void {
  const normalize = (value: string): string => {
    const normalized = value.replaceAll('\\', '/')
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized
  }
  const root = normalize(path).replace(/\/$/, '')
  const records = diagnostics()
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const message = normalize(records[index].message)
    if (message.includes(`${root}:`) || message.includes(`${root}/`)) records.splice(index, 1)
  }
}

export function readL4PiPluginNativeDiagnostics(): readonly L4PiPluginNativeDiagnostic[] {
  return diagnostics().map((record) => ({ ...record }))
}

declare global {
  var __piDeskNativePluginDiagnostics: L4PiPluginNativeDiagnostic[] | undefined
}
