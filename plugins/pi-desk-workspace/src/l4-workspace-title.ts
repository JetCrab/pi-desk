export const WORKSPACE_TITLE_LIMIT = 20

export function shortWorkspaceTitle(value: string): string {
  const characters = Array.from(value.trim().replace(/\s+/gu, ' '))
  if (characters.length <= WORKSPACE_TITLE_LIMIT) return characters.join('')
  return `${characters.slice(0, WORKSPACE_TITLE_LIMIT - 1).join('')}…`
}
