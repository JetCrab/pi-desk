import 'server-only'

const safeMode = process.argv.includes('--safe-mode') || process.env.PI_DESK_SAFE_MODE === '1'

export function isL4PiDeskSafeMode(): boolean {
  return safeMode
}
