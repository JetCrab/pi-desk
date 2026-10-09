export type SiteRelease = {
  siteUrl: string | null
  sourceUrl: string | null
  license: { name: string; url: string } | null
  installCommand: string | null
  downloads: Partial<Record<'windows' | 'macos' | 'linux' | 'android', string>>
}

export const startCommand = 'pi-desk'
export const nodeRequirement = 'Node.js ≥ 22.19.0'
