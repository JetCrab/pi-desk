import type { L4EnvironmentFileDeclaration } from '@common/l4_foundation/environment/l4-environment-file-contract'

// 只描述当前配置位置；一次性配置迁移不属于运行时或归档收集器。
export const L4_ENVIRONMENT_HOST_FILES: readonly L4EnvironmentFileDeclaration[] = [
  { base: 'config', path: 'pi-desk-settings.json', format: 'json' },
  { base: 'config', path: 'pi-desk-capability-modes.json', format: 'json' },
  { base: 'config', path: 'pi-desk-models.json', format: 'json' },
  { base: 'config', path: 'pi-desk-auth.json', format: 'json' },
  { base: 'config', path: 'pi-desk-plugins.json', format: 'json', localPaths: ['/disabled/*'] },
  { base: 'config', path: 'pi-desk-ignored-directories.json', format: 'json', localPaths: ['/*'] }
]
