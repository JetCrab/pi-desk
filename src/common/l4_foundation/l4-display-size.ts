export const L4_DISPLAY_SIZES = ['compact', 'standard', 'large'] as const

export type L4DisplaySize = (typeof L4_DISPLAY_SIZES)[number]

export const L4_DEFAULT_DISPLAY_SIZE: L4DisplaySize = 'compact'
export const L4_DISPLAY_SIZE_STORAGE_KEY = 'pi-desk:display-size'
export const L4_LEGACY_CHAT_SIZE_STORAGE_KEY = 'pi-super:work-session-visual'

export function resolveL4DisplaySize(saved: unknown, legacy: unknown): L4DisplaySize {
  if (saved === 'compact' || saved === 'standard' || saved === 'large') return saved
  if (
    saved === null &&
    legacy !== null &&
    typeof legacy === 'object' &&
    !Array.isArray(legacy) &&
    'chatSize' in legacy &&
    legacy.chatSize === 'large'
  ) {
    return 'standard'
  }
  return L4_DEFAULT_DISPLAY_SIZE
}
