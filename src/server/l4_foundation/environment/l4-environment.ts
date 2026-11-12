// 原生 Node 底座，可由 Next 服务端或独立 Node 进程调用。
export {
  ENVIRONMENT_ARCHIVE_DEFAULT_LIMITS,
  readEnvironmentArchive,
  writeEnvironmentArchive,
  type EnvironmentArchiveEntry,
  type EnvironmentArchiveEntryHeader,
  type EnvironmentArchiveLimits
} from './l4-environment-archive'
export {
  assertEnvironmentEntryPath,
  assertEnvironmentTargetPaths,
  environmentPathKey,
  mapEnvironmentPath,
  normalizeEnvironmentPath,
  type EnvironmentPathMapping,
  type EnvironmentPlatform
} from './l4-environment-paths'
export {
  convertEnvironmentSessionLine,
  type EnvironmentMissingReference,
  type EnvironmentSessionConversion
} from './l4-environment-sessions'
