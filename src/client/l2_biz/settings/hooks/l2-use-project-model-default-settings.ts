'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
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
import {
  saveL2ProjectDefaultChanges,
  type L2ModelSettingsBiz,
  type L2ProjectDefaultChanges
} from '../l2-model-settings-biz'
import {
  readL2ProjectModelDefaultCache,
  saveL2ProjectModelDefaultCache
} from '../l2-model-settings-cache'

type DefaultMode = string | null | undefined

export interface L2ProjectModelDefaultSettingsState {
  directories: L2PiDirectoryListResponse['directories']
  cwd: string | null
  models: L2ModelOption[]
  presets: L2ModelPreset[]
  selection: L2ModelSelection | null
  fixed: boolean
  defaultMode: DefaultMode
  modelReady: boolean
  modeReady: boolean
  directoriesLoading: boolean
  projectLoading: boolean
  modeLoading: boolean
  saving: boolean
  dirty: boolean
  canSave: boolean
  directoriesError: string | null
  projectError: string | null
  modeError: string | null
  presetsError: string | null
  saveErrors: { model?: string; mode?: string }
  savedOwners: string[]
  dialog: React.JSX.Element | null
  selectProject: (nextCwd: string | null) => Promise<boolean>
  changeFixed: (value: boolean) => void
  changeDefaultMode: (value: DefaultMode) => void
  selectModel: (model: L2ModelOption) => void
  selectThinking: (value: string) => void
  applyPreset: (preset: L2ModelPreset) => void
  retryDirectories: () => void
  retryProject: () => void
  retryMode: () => void
  retryPresets: () => void
  save: () => Promise<void>
}

function sameSelection(first: L2ModelSelection | null, second: L2ModelSelection | null): boolean {
  return (
    first === second ||
    (first !== null &&
      second !== null &&
      first.provider === second.provider &&
      first.modelId === second.modelId &&
      first.thinkingLevel === second.thinkingLevel)
  )
}

export function useL2ProjectModelDefaultSettings(
  biz: L2ModelSettingsBiz,
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
): L2ProjectModelDefaultSettingsState {
  const { t } = useTranslation('settings')
  const toast = useL4AppToast()
  const { confirm, dialog } = useL4ConfirmDialog()
  const [directories, setDirectories] = useState<L2PiDirectoryListResponse['directories']>([])
  const [cwd, setCwd] = useState<string | null>(null)
  const [models, setModels] = useState<L2ModelOption[]>([])
  const [presets, setPresets] = useState<L2ModelPreset[]>([])
  const [selection, setSelection] = useState<L2ModelSelection | null>(null)
  const [fixed, setFixed] = useState(false)
  const [modelBaseline, setModelBaseline] = useState<L2ModelSelection | null | undefined>()
  const [modeBaseline, setModeBaseline] = useState<{
    cwd: string | null
    value: DefaultMode
  } | null>(null)
  const [defaultMode, setDefaultMode] = useState<DefaultMode>()
  const [modelCwd, setModelCwd] = useState<string | null>(null)
  const [directoriesLoading, setDirectoriesLoading] = useState(true)
  const [projectLoading, setProjectLoading] = useState(false)
  const [modeLoading, setModeLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [directoriesError, setDirectoriesError] = useState<string | null>(null)
  const [projectError, setProjectError] = useState<string | null>(null)
  const [modeError, setModeError] = useState<string | null>(null)
  const [presetsError, setPresetsError] = useState<string | null>(null)
  const [saveErrors, setSaveErrors] = useState<{ model?: string; mode?: string }>({})
  const [savedOwners, setSavedOwners] = useState<string[]>([])
  const [directoryAttempt, setDirectoryAttempt] = useState(0)
  const [projectAttempt, setProjectAttempt] = useState(0)
  const [modeAttempt, setModeAttempt] = useState(0)
  const [presetsAttempt, setPresetsAttempt] = useState(0)
  const requestRef = useRef(0)
  const savingRef = useRef(false)
  const modelDirty =
    cwd !== null &&
    modelCwd === cwd &&
    modelBaseline !== undefined &&
    !sameSelection(fixed ? selection : null, modelBaseline)
  const modeDirty = modeBaseline?.cwd === cwd && defaultMode !== modeBaseline.value
  const dirty = modelDirty || modeDirty
  const dirtyRef = useRef({ model: false, mode: false })
  useEffect(() => {
    dirtyRef.current = { model: modelDirty, mode: modeDirty }
  }, [modelDirty, modeDirty])
  const modelReady =
    cwd !== null &&
    modelCwd === cwd &&
    modelBaseline !== undefined &&
    !projectLoading &&
    !projectError
  const modeReady = modeBaseline?.cwd === cwd && !modeLoading && !modeError
  const canSave =
    !saving &&
    dirty &&
    (!modelDirty || (modelReady && (!fixed || selection !== null))) &&
    (!modeDirty || modeReady)

  const beforeLeave = useCallback(async (): Promise<boolean> => {
    if (savingRef.current) return false
    if (!dirty) return true
    return confirm({
      title: t('discardProjectDefaultsTitle'),
      description: t('discardProjectDefaultsDescription'),
      confirmLabel: t('discardModelConfirm')
    })
  }, [confirm, dirty, t])

  useEffect(() => {
    onBeforeLeaveChange(dirty || saving ? beforeLeave : null)
    return () => onBeforeLeaveChange(null)
  }, [beforeLeave, dirty, onBeforeLeaveChange, saving])

  useEffect(() => {
    if (!dirty && !saving) return
    const preventReload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', preventReload)
    return () => window.removeEventListener('beforeunload', preventReload)
  }, [dirty, saving])

  useEffect(() => {
    let disposed = false
    const parsed = L2PiDirectoryListResponseSchema.safeParse(readL4PiDirectoriesCache())
    const cached = parsed.success ? parsed.data.directories : null
    queueMicrotask(() => {
      if (disposed) return
      setDirectoriesError(null)
      setDirectoriesLoading(!cached)
      if (cached) setDirectories(cached)
    })
    void biz
      .listDirectories()
      .then((result) => {
        if (!disposed) setDirectories(result.directories)
      })
      .catch((error: unknown) => {
        if (disposed || cached) return
        const message = error instanceof Error ? error.message : t('projectDirectoriesFailed')
        console.warn('[Pi Desk][ProjectDefaults] 读取项目目录失败', { message })
        setDirectoriesError(message)
      })
      .finally(() => {
        if (!disposed) setDirectoriesLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [biz, t, directoryAttempt])

  useEffect(() => {
    let disposed = false
    void biz
      .getSettings()
      .then((result) => {
        if (!disposed) {
          setPresets(result.presets)
          setPresetsError(null)
        }
      })
      .catch((error: unknown) => {
        if (!disposed)
          setPresetsError(error instanceof Error ? error.message : t('modelsLoadFailed'))
      })
    return () => {
      disposed = true
    }
  }, [biz, t, presetsAttempt])

  useEffect(() => {
    if (cwd === null) return
    let disposed = false
    const request = requestRef.current
    const isCurrent = (): boolean => !disposed && request === requestRef.current
    function apply(result: L2ProjectModelDefaultGetResponse): void {
      setModels(result.models)
      setModelBaseline(result.default)
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
    queueMicrotask(() => {
      if (!isCurrent()) return
      setProjectError(null)
      setProjectLoading(true)
      const cached = readL2ProjectModelDefaultCache(cwd)
      if (cached && !dirtyRef.current.model) apply(cached)
    })
    void biz
      .getProjectDefault(cwd)
      .then((result) => {
        if (!isCurrent()) return
        if (!dirtyRef.current.model) apply(result)
        setModelCwd(cwd)
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        const message = error instanceof Error ? error.message : t('projectDefaultFailed')
        console.warn('[Pi Desk][ProjectDefaults] 读取项目模型失败', { cwd, message })
        setProjectError(message)
      })
      .finally(() => {
        if (isCurrent()) setProjectLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [biz, cwd, t, projectAttempt])

  useEffect(() => {
    let disposed = false
    const request = requestRef.current
    const isCurrent = (): boolean => !disposed && request === requestRef.current
    queueMicrotask(() => {
      if (!isCurrent()) return
      setModeLoading(true)
      setModeError(null)
    })
    void biz
      .getCapabilityModeDefault(cwd)
      .then((result) => {
        if (!isCurrent() || dirtyRef.current.mode) return
        setDefaultMode(result.defaultMode)
        setModeBaseline({ cwd, value: result.defaultMode })
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return
        const message = error instanceof Error ? error.message : t('projectModeLoadFailed')
        console.warn('[Pi Desk][ProjectDefaults] 读取默认模式失败', { cwd, message })
        setModeError(message)
      })
      .finally(() => {
        if (isCurrent()) setModeLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [biz, cwd, t, modeAttempt])

  async function selectProject(nextCwd: string | null): Promise<boolean> {
    if (nextCwd === cwd) return true
    if (!(await beforeLeave())) return false
    requestRef.current += 1
    dirtyRef.current = { model: false, mode: false }
    setModelCwd(null)
    setModelBaseline(undefined)
    setModeBaseline(null)
    setModels([])
    setSelection(null)
    setFixed(false)
    setDefaultMode(undefined)
    setProjectError(null)
    setModeError(null)
    setSaveErrors({})
    setSavedOwners([])
    setCwd(nextCwd)
    return true
  }

  function changeFixed(value: boolean): void {
    if (modelReady && !savingRef.current) setFixed(value)
  }
  function changeDefaultMode(value: DefaultMode): void {
    if (modeReady && !savingRef.current) setDefaultMode(value)
  }
  function selectModel(model: L2ModelOption): void {
    if (!modelReady || savingRef.current) return
    setSelection({
      provider: model.provider,
      modelId: model.modelId,
      thinkingLevel: model.thinkingLevels[0]
    })
  }
  function selectThinking(value: string): void {
    if (!modelReady || savingRef.current || !selection) return
    const model = models.find(
      (item) => item.provider === selection.provider && item.modelId === selection.modelId
    )
    const level = model?.thinkingLevels.find((item) => item === value)
    if (level) setSelection({ ...selection, thinkingLevel: level })
  }
  function applyPreset(preset: L2ModelPreset): void {
    if (!modelReady || savingRef.current) return
    setSelection({
      provider: preset.provider,
      modelId: preset.modelId,
      thinkingLevel: preset.thinkingLevel
    })
  }

  async function save(): Promise<void> {
    if (!canSave || savingRef.current) return
    const changes: L2ProjectDefaultChanges = {
      ...(modelDirty && cwd !== null ? { model: { cwd, default: fixed ? selection : null } } : {}),
      ...(modeDirty ? { mode: { cwd, ...(defaultMode !== undefined ? { defaultMode } : {}) } } : {})
    }
    savingRef.current = true
    setSaving(true)
    setSaveErrors({})
    setSavedOwners([])
    try {
      const result = await saveL2ProjectDefaultChanges(biz, changes)
      const errors: { model?: string; mode?: string } = {}
      const saved: string[] = []
      if (result.model?.status === 'fulfilled' && changes.model) {
        setModelBaseline(changes.model.default)
        saveL2ProjectModelDefaultCache({ ...changes.model, models })
        saved.push(t('projectDefaultModel'))
      } else if (result.model?.status === 'rejected') {
        errors.model =
          result.model.reason instanceof Error
            ? result.model.reason.message
            : t('projectDefaultSaveFailed')
      }
      if (result.mode?.status === 'fulfilled' && changes.mode) {
        setModeBaseline({ cwd, value: changes.mode.defaultMode })
        saved.push(t('projectDefaultMode'))
      } else if (result.mode?.status === 'rejected') {
        errors.mode =
          result.mode.reason instanceof Error
            ? result.mode.reason.message
            : t('projectModeSaveFailed')
      }
      setSaveErrors(errors)
      setSavedOwners(saved)
      if (errors.model || errors.mode) {
        console.warn('[Pi Desk][ProjectDefaults] 保存默认配置未全部成功', { cwd, errors, saved })
      } else {
        toast.success(t('projectDefaultsSaved'))
      }
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return {
    directories,
    cwd,
    models,
    presets,
    selection,
    fixed,
    defaultMode,
    modelReady,
    modeReady,
    directoriesLoading,
    projectLoading,
    modeLoading,
    saving,
    dirty,
    canSave,
    directoriesError,
    projectError,
    modeError,
    presetsError,
    saveErrors,
    savedOwners,
    dialog,
    selectProject,
    changeFixed,
    changeDefaultMode,
    selectModel,
    selectThinking,
    applyPreset,
    retryDirectories: () => setDirectoryAttempt((attempt) => attempt + 1),
    retryProject: () => setProjectAttempt((attempt) => attempt + 1),
    retryMode: () => setModeAttempt((attempt) => attempt + 1),
    retryPresets: () => setPresetsAttempt((attempt) => attempt + 1),
    save
  }
}
