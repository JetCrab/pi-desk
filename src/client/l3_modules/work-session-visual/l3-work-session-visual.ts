'use client'

export function getL3WorkSessionProjectColor(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/').toLowerCase()
  let hash = 2_166_136_261
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16_777_619)
  }
  const hue = (hash >>> 0) % 360
  // 项目身份与任务状态分离；主题只校准明度和彩度，不改变稳定色相。
  return `oklch(var(--project-color-lightness, 0.49) var(--project-color-chroma, 0.1) ${hue})`
}
