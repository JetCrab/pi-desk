export type SiteRelease = {
  siteUrl: string | null
  sourceUrl: string | null
  license: { name: string; url: string } | null
  installCommand: string | null
  desktop: { url: string } | null
  androidUrl: string | null
}

export const startCommand = 'pi-desk'
export const nodeRequirement = 'Node.js ≥ 22.19.0'
