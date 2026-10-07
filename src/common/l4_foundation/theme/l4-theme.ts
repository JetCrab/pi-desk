export const L4_THEME_STORAGE_KEY = 'pi-super-theme'
export const L4_DEFAULT_THEME = 'dark' as const
export const L4_THEME_VALUES = ['system', 'light', 'dark'] as const

export type L4Theme = (typeof L4_THEME_VALUES)[number]
export type L4ResolvedTheme = Exclude<L4Theme, 'system'>

export function isL4Theme(value: unknown): value is L4Theme {
  return L4_THEME_VALUES.some((theme) => theme === value)
}

export function resolveL4Theme(theme: L4Theme, systemDark: boolean): L4ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light'
  return theme
}
