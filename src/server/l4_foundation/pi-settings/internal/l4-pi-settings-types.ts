export type L4PiSettingsJsonValue =
  | null
  | boolean
  | number
  | string
  | L4PiSettingsJsonValue[]
  | { [key: string]: L4PiSettingsJsonValue }
export type L4McpServerConfig = Record<string, L4PiSettingsJsonValue>
export interface L4McpSettings {
  local: Record<string, L4McpServerConfig>
  inherited: Record<string, L4McpServerConfig>
  projectTrusted: boolean | null
  diagnostics: Array<{ name: string | null; message: string }>
}
export interface L4McpSettingsReplaceInput {
  cwd: string | null
  servers: Record<string, L4McpServerConfig>
}
