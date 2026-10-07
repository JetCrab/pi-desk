import type { L2ModelPreset } from '@common/l2_biz/model-settings/l2-model-settings-contract'

export const L2_MODEL_PRESET_COLORS = [
  { value: '#3b82f6', label: 'presetColorBlue' },
  { value: '#0891b2', label: 'presetColorCyan' },
  { value: '#16a34a', label: 'presetColorGreen' },
  { value: '#b7791f', label: 'presetColorAmber' },
  { value: '#ea580c', label: 'presetColorOrange' },
  { value: '#dc2626', label: 'presetColorRed' },
  { value: '#db2777', label: 'presetColorPink' },
  { value: '#8b5cf6', label: 'presetColorPurple' }
] as const

export function pickL2ModelPresetColor(presets: readonly Pick<L2ModelPreset, 'color'>[]): string {
  const usage = L2_MODEL_PRESET_COLORS.map(({ value }) => ({
    value,
    count: presets.filter((preset) => preset.color?.toLowerCase() === value).length
  }))
  return usage.reduce((leastUsed, color) => (color.count < leastUsed.count ? color : leastUsed))
    .value
}
