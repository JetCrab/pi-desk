'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelOption,
  L2ModelPreset,
  L2ModelSelection,
  L2ProjectModelDefaultGetResponse
} from '@common/l2_biz/model-settings/l2-model-settings-contract'
import {
  L2PiDirectoryListResponseSchema,
  type L2PiDirectoryListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import { readL4PiDirectoriesCache } from '@client/l4_foundation/storage/l4-pi-directory-cache'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import type { L2ModelSettingsBiz } from '../l2-model-settings-biz'
import {
  readL2ProjectModelDefaultCache,
  saveL2ProjectModelDefaultCache
} from '../l2-model-settings-cache'

interface ProjectModelDefaultSettingsState {
  directories: L2PiDirectoryListResponse['directories']
  cwd: string
  models: L2ModelOption[]
  selection: L2ModelSelection | null
  fixed: boolean
  directoriesLoading: boolean
  projectLoading: boolean
  projectRefreshing: boolean
  saving: boolean
  projectReady: boolean
  directoriesError: string | null
  projectError: string | null
  dialog: React.JSX.Element | null
  selectProject: (nextCwd: string) => Promise<boolean>
  changeFixed: (value: boolean) => void
  selectModel: (model: L2ModelOption) => void
  selectThinking: (value: string) => void
  applyPreset: (preset: L2ModelPreset) => void
  retryDirectories: () => void
  retryProject: () => void
  save: () => Promise<void>
}

export function useL2ProjectModelDefaultSettings(
  biz: L2ModelSettingsBiz,
  onDirtyChange?: (dirty: boolean) => void
): ProjectModelDefaultSettingsState {
  const { t } = useTranslation('settings')
  const toast = useL4AppToast()
  const { confirm, dialog } = useL4ConfirmDialog()
  const [directories, setDirectories] = useState<L2PiDirectoryListResponse['directories']>([])
  const [cwd, setCwd] = useState('')
  const [models, setModels] = useState<L2ModelOption[]>([])
  const [selection, setSelection] = useState<L2ModelSelection | null>(null)
  const [fixed, setFixed] = useState(false)
  const [directoriesLoading, setDirectoriesLoading] = useState(true)
  const [projectLoading, setProjectLoading] = useState(false)
  const [projectRefreshing, setProjectRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadedCwd, setLoadedCwd] = useState<string | null>(null)
  const [directoriesError, setDirectoriesError] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [directoryAttempt, setDirectoryAttempt] = useState(0)
  const [projectAttempt, setProjectAttempt] = useState(0)
  const projectReady = loadedCwd === cwd && projectError === null
  const projectDraftDirtyRef = useRef(false)
  const projectCwdRef = useRef('')
  const markDraftDirty = useCallback(
    (dirty: boolean): void => {
      projectDraftDirtyRef.current = dirty
      onDirtyChange?.(dirty)
    },
    [onDirtyChange]
  )

  function applyProjectResult(result: L2ProjectModelDefaultGetResponse): void {
    setModels(result.models)
    setFixed(result.default !== null)
    setSelection(
      result.default ??
        (result.models[0]
          ? {
              provider: result.models[0].provider,
              modelId: result.models[0].modelId,
              thinkingLevel: result.models[0].thinkingLevels[0]
            }
          : null)
    )
  }

  useEffect(() => {
    let disposed = false
    const cachedResponse = L2PiDirectoryListResponseSchema.safeParse(readL4PiDirectoriesCache())
    const cachedDirectories = cachedResponse.success ? cachedResponse.data.directories : null
    queueMicrotask((): void => {
      if (disposed) return
      setDirectoriesError(null)
      setDirectoriesLoading(!cachedDirectories)
      if (cachedDirectories) {
        setDirectories(cachedDirectories)
        setCwd((current): string =>
          current && cachedDirectories.some((directory) => directory.cwd === current)
            ? current
            : (cachedDirectories[0]?.cwd ?? '')
        )
      }
    })

    void (async (): Promise<void> => {
      try {
        const result = await biz.listDirectories()
        if (disposed) return
        setDirectories(result.directories)
        setCwd((current): string =>
          current && result.directories.some((directory) => directory.cwd === current)
            ? current
            : (result.directories[0]?.cwd ?? '')
        )
      } catch (error) {
        if (!disposed && !cachedDirectories) {
          const message = error instanceof Error ? error.message : t('projectDirectoriesFailed')
          console.warn('[Pi Desk][ProjectModelDefault] 读取项目目录失败', { message })
          setDirectoriesError(message)
        }
      } finally {
        if (!disposed) setDirectoriesLoading(false)
      }
    })()
    return (): void => {
      disposed = true
    }
  }, [biz, t, directoryAttempt])

  useEffect(() => {
    let disposed = false
    const projectChanged = projectCwdRef.current !== cwd
    projectCwdRef.current = cwd
    if (projectChanged) markDraftDirty(false)
    if (!cwd) {
      queueMicrotask((): void => {
        if (disposed) return
        setModels([])
        setSelection(null)
        setFixed(false)
        setLoadedCwd(null)
        setProjectError(null)
        setProjectLoading(false)
        setProjectRefreshing(false)
      })
      return (): void => {
        disposed = true
      }
    }

    const cached = readL2ProjectModelDefaultCache(cwd)
    queueMicrotask((): void => {
      if (disposed) return
      setProjectError(null)
      // 同一项目重试或后台刷新时，缓存和远端结果都不能替换未保存草稿。
      if (!projectDraftDirtyRef.current) {
        if (cached) {
          applyProjectResult(cached)
          setLoadedCwd(cwd)
        } else {
          setModels([])
          setSelection(null)
          setFixed(false)
          setLoadedCwd(null)
        }
      }
      setProjectLoading(!cached && !projectDraftDirtyRef.current)
      setProjectRefreshing(Boolean(cached) || projectDraftDirtyRef.current)
    })

    void (async (): Promise<void> => {
      try {
        const result = await biz.getProjectDefault(cwd)
        if (disposed) return
        if (!projectDraftDirtyRef.current) applyProjectResult(result)
        setLoadedCwd(cwd)
      } catch (error) {
        if (!disposed) {
          const message = error instanceof Error ? error.message : t('projectDefaultFailed')
          console.warn('[Pi Desk][ProjectModelDefault] 读取项目模型配置失败', { cwd, message })
          setProjectError(message)
        }
      } finally {
        if (!disposed) {
          setProjectLoading(false)
          setProjectRefreshing(false)
        }
      }
    })()
    return (): void => {
      disposed = true
    }
  }, [biz, cwd, t, markDraftDirty, projectAttempt])

  async function selectProject(nextCwd: string): Promise<boolean> {
    if (saving) return false
    if (nextCwd === cwd) return true
    if (
      projectDraftDirtyRef.current &&
      !(await confirm({
        title: t('discardModelTitle'),
        description: t('discardModelDescription'),
        confirmLabel: t('discardModelConfirm')
      }))
    ) {
      return false
    }
    setCwd(nextCwd)
    return true
  }

  function changeFixed(value: boolean): void {
    markDraftDirty(true)
    setFixed(value)
  }

  function selectModel(model: L2ModelOption): void {
    markDraftDirty(true)
    setSelection({
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevels[0]
    })
  }

  function selectThinking(value: string): void {
    const model = models.find(
      (item): boolean => item.provider === selection?.provider && item.modelId === selection.modelId
    )
    const level = model?.thinkingLevels.find((item): boolean => item === value)
    if (!selection || !level) return
    markDraftDirty(true)
    setSelection({ ...selection, thinkingLevel: level })
  }

  function applyPreset(preset: L2ModelPreset): void {
    markDraftDirty(true)
    setSelection({
      provider: preset.provider,
      modelId: preset.modelId,
      thinkingLevel: preset.thinkingLevel
    })
  }

  function retryDirectories(): void {
    setDirectoryAttempt((attempt): number => attempt + 1)
  }

  function retryProject(): void {
    setProjectAttempt((attempt): number => attempt + 1)
  }

  async function save(): Promise<void> {
    if (
      !cwd ||
      !projectReady ||
      projectLoading ||
      projectRefreshing ||
      saving ||
      (fixed && !selection)
    ) {
      return
    }
    setSaving(true)
    try {
      await biz.replaceProjectDefault({ cwd, default: fixed ? selection : null })
      saveL2ProjectModelDefaultCache({
        cwd,
        default: fixed ? selection : null,
        models
      })
      markDraftDirty(false)
      toast.success(fixed ? t('projectDefaultSaved') : t('projectDefaultGlobalSaved'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('projectDefaultSaveFailed'))
    } finally {
      setSaving(false)
    }
  }

  return {
    directories,
    cwd,
    models,
    selection,
    fixed,
    directoriesLoading,
    projectLoading,
    projectRefreshing,
    saving,
    projectReady,
    directoriesError,
    projectError,
    dialog,
    selectProject,
    changeFixed,
    selectModel,
    selectThinking,
    applyPreset,
    retryDirectories,
    retryProject,
    save
  }
}
