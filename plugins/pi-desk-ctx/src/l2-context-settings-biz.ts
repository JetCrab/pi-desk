import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  BrowserPluginHost,
  BrowserSettingsPageTarget,
  PluginJsonObject
} from '@jetcrab/pi-desk-sdk/browser'
import {
  defaultContextIgnoreSettings,
  parseContextIgnoreSettings,
  type ContextIgnoreProfile,
  type ContextIgnoreSettings
} from './context-settings.js'

export interface RuleDraft {
  currentEnabled: boolean
  currentK: string
  projectedEnabled: boolean
  projectedK: string
}

export interface ProfileDraft {
  key: number
  maxContextK: string | null
  checkpointEnabled: boolean
  checkpointK: string
  keepRecentUserTurns: string
  processBudgetK: string
  rules: RuleDraft[]
}

interface SettingsDraft {
  enabled: boolean
  profiles: ProfileDraft[]
}

interface DraftIssue {
  profileKey: number
  field: string
  message: string
}

class InvalidDraft extends Error {
  constructor(readonly issue: DraftIssue) {
    super(issue.message)
  }
}

let draftKey = 0

function profileToDraft(profile: ContextIgnoreProfile): ProfileDraft {
  draftKey += 1
  return {
    key: draftKey,
    maxContextK:
      profile.maxContextTokens === undefined ? null : String(profile.maxContextTokens / 1000),
    checkpointEnabled: profile.checkpointTokens !== undefined,
    checkpointK:
      profile.checkpointTokens === undefined ? '' : String(profile.checkpointTokens / 1000),
    keepRecentUserTurns: String(profile.keepRecentUserTurns),
    processBudgetK: String(profile.processTokenBudget / 1000),
    rules: profile.rules.map((rule) => ({
      currentEnabled: rule.currentTokensAtLeast !== undefined,
      currentK:
        rule.currentTokensAtLeast === undefined ? '' : String(rule.currentTokensAtLeast / 1000),
      projectedEnabled: rule.projectedTokensAtMost !== undefined,
      projectedK:
        rule.projectedTokensAtMost === undefined ? '' : String(rule.projectedTokensAtMost / 1000)
    }))
  }
}

function settingsToDraft(settings: ContextIgnoreSettings): SettingsDraft {
  return { enabled: settings.enabled, profiles: settings.profiles.map(profileToDraft) }
}

function readAmount(
  value: string,
  minimum: number,
  maximum: number,
  scale: number,
  profileKey: number,
  field: string,
  label: string
): number {
  const valueNumber = Number(value)
  const amount = Math.round(valueNumber * scale)
  if (
    value.trim() === '' ||
    !Number.isInteger(amount) ||
    amount / scale !== valueNumber ||
    amount < minimum ||
    amount > maximum
  ) {
    throw new InvalidDraft({
      profileKey,
      field,
      message: `${label}需为 ${minimum / scale}–${maximum / scale}${scale === 1000 ? 'k' : ' 轮'}`
    })
  }
  return amount
}

function draftToSettings(draft: SettingsDraft): ContextIgnoreSettings {
  const limits = new Set<number>()
  const profiles = draft.profiles.map((profile): ContextIgnoreProfile => {
    const amount = (
      value: string,
      field: string,
      label: string,
      minimum = 0,
      maximum = 100_000_000,
      scale = 1000
    ): number => readAmount(value, minimum, maximum, scale, profile.key, field, label)
    const maxContextTokens =
      profile.maxContextK === null
        ? undefined
        : amount(profile.maxContextK, 'maxContextK', '模型容量上限', 1)
    if (maxContextTokens !== undefined) {
      if (limits.has(maxContextTokens)) {
        throw new InvalidDraft({
          profileKey: profile.key,
          field: 'maxContextK',
          message: '这个模型容量上限已存在'
        })
      }
      limits.add(maxContextTokens)
    }
    return {
      ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
      ...(profile.checkpointEnabled
        ? { checkpointTokens: amount(profile.checkpointK, 'checkpointK', '记录进展用量', 1) }
        : {}),
      keepRecentUserTurns: amount(
        profile.keepRecentUserTurns,
        'keepRecentUserTurns',
        '最近对话轮数',
        1,
        100,
        1
      ),
      processTokenBudget: amount(profile.processBudgetK, 'processBudgetK', '过程用量上限'),
      rules: profile.rules.map((rule, index) => {
        if (!rule.currentEnabled && !rule.projectedEnabled) {
          throw new InvalidDraft({
            profileKey: profile.key,
            field: `rule-${index}`,
            message: '请至少选择一个条件'
          })
        }
        return {
          ...(rule.currentEnabled
            ? {
                currentTokensAtLeast: amount(rule.currentK, `current-${index}`, '当前用量')
              }
            : {}),
          ...(rule.projectedEnabled
            ? {
                projectedTokensAtMost: amount(
                  rule.projectedK,
                  `projected-${index}`,
                  '忽略后预计用量'
                )
              }
            : {})
        }
      })
    }
  })
  return parseContextIgnoreSettings({ enabled: draft.enabled, profiles })
}

function sortProfiles(profiles: ProfileDraft[]): ProfileDraft[] {
  return [...profiles].sort((left, right) => {
    if (left.maxContextK === null) return 1
    if (right.maxContextK === null) return -1
    if (left.maxContextK === '') return 1
    if (right.maxContextK === '') return -1
    return Number(left.maxContextK) - Number(right.maxContextK)
  })
}

function comparableDraft(draft: SettingsDraft): string {
  return JSON.stringify({
    enabled: draft.enabled,
    profiles: draft.profiles.map(({ key: _key, ...profile }) => profile)
  })
}

export interface ContextSettingsController {
  draft: SettingsDraft
  profile: ProfileDraft
  issue: DraftIssue | null
  error: string | null
  loading: boolean
  loaded: boolean
  saving: boolean
  dirty: boolean
  advancedOpen: boolean
  leaveOpen: boolean
  setEnabled(enabled: boolean): void
  selectProfile(key: number): void
  updateProfile(update: Partial<ProfileDraft>): void
  updateRule(index: number, update: Partial<RuleDraft>): void
  sortProfiles(): void
  addProfile(): void
  deleteProfile(): void
  addRule(): void
  removeRule(index: number): void
  setAdvancedOpen(open: boolean): void
  cancel(): void
  restoreRecommended(): void
  save(): void
  reload(): void
  finishLeave(leave: boolean): void
}

export function useContextSettings(
  target: BrowserSettingsPageTarget,
  host: BrowserPluginHost,
  signal: AbortSignal
): ContextSettingsController {
  const initialDraft = useMemo(() => settingsToDraft(defaultContextIgnoreSettings()), [])
  const [baseline, setBaseline] = useState(initialDraft)
  const [draft, setDraft] = useState(initialDraft)
  const [activeKey, setActiveKey] = useState(initialDraft.profiles[1]!.key)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [leaveOpen, setLeaveOpen] = useState(false)
  const leaveResolve = useRef<((value: boolean) => void) | null>(null)
  const dirty = comparableDraft(draft) !== comparableDraft(baseline)
  const dirtyRef = useRef(dirty)
  const profile =
    draft.profiles.find((candidate) => candidate.key === activeKey) ?? draft.profiles[0]!
  const validation = useMemo(() => {
    try {
      return { settings: draftToSettings(draft), issue: null, error: null }
    } catch (cause) {
      return {
        settings: null,
        issue: cause instanceof InvalidDraft ? cause.issue : null,
        error: cause instanceof Error ? cause.message : String(cause)
      }
    }
  }, [draft])

  useEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])

  const applySettings = useCallback(
    (settings: ContextIgnoreSettings, selectedLimit?: string | null): void => {
      const next = settingsToDraft(settings)
      setBaseline(next)
      setDraft(next)
      setLoaded(true)
      setActiveKey(
        next.profiles.find((candidate) => candidate.maxContextK === selectedLimit)?.key ??
          (next.profiles[1] ?? next.profiles[0]!).key
      )
    },
    []
  )

  const load = useCallback(async (): Promise<void> => {
    if (dirtyRef.current) return
    setLoading(true)
    setError(null)
    try {
      const settings = parseContextIgnoreSettings(
        await host.piDesk.invokeGlobal('settings-get', {})
      )
      if (!signal.aborted) applySettings(settings)
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [applySettings, host, signal])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void load()
    })
    const dispose = host.connection.subscribe(() => {
      if (host.connection.getSnapshot().status === 'ready') void load()
    })
    return () => {
      active = false
      void dispose()
    }
  }, [host, load])

  useEffect(() => {
    target.setBeforeLeave(
      () =>
        !dirty ||
        new Promise<boolean>((resolve) => {
          leaveResolve.current?.(false)
          leaveResolve.current = resolve
          setLeaveOpen(true)
        })
    )
    return () => {
      target.setBeforeLeave(null)
      leaveResolve.current?.(false)
      leaveResolve.current = null
    }
  }, [dirty, target])

  const updateProfile = (update: Partial<ProfileDraft>): void => {
    setDraft((current) => ({
      ...current,
      profiles: current.profiles.map((candidate) =>
        candidate.key === profile.key ? { ...candidate, ...update } : candidate
      )
    }))
  }

  const save = (): void => {
    if (saving || !dirty) return
    if (!validation.settings) {
      if (validation.issue) {
        setActiveKey(validation.issue.profileKey)
        if (['maxContextK', 'checkpointK'].includes(validation.issue.field)) setAdvancedOpen(true)
      } else {
        setError(validation.error)
      }
      return
    }
    setSaving(true)
    setError(null)
    const input = JSON.parse(JSON.stringify(validation.settings)) as PluginJsonObject
    void host.piDesk
      .invokeGlobal('settings-save', input)
      .then((value) => {
        if (signal.aborted) return
        applySettings(parseContextIgnoreSettings(value), profile.maxContextK)
        host.notify({ level: 'success', title: '设置已保存' })
      })
      .catch((cause: unknown) => {
        if (signal.aborted) return
        const message = cause instanceof Error ? cause.message : String(cause)
        setError(message)
        host.notify({ level: 'error', title: '设置保存失败', description: message })
      })
      .finally(() => {
        if (!signal.aborted) setSaving(false)
      })
  }

  return {
    draft,
    profile,
    issue: validation.issue,
    error,
    loading,
    loaded,
    saving,
    dirty,
    advancedOpen,
    leaveOpen,
    setEnabled(enabled) {
      setDraft((current) => ({ ...current, enabled }))
    },
    selectProfile: setActiveKey,
    updateProfile,
    updateRule(index, update) {
      updateProfile({
        rules: profile.rules.map((rule, ruleIndex) =>
          ruleIndex === index ? { ...rule, ...update } : rule
        )
      })
    },
    sortProfiles() {
      setDraft((current) => ({ ...current, profiles: sortProfiles(current.profiles) }))
    },
    addProfile() {
      const recommended = defaultContextIgnoreSettings().profiles[1]!
      const next = profileToDraft({ ...recommended, checkpointTokens: undefined, rules: [] })
      next.maxContextK = ''
      setDraft((current) => ({ ...current, profiles: sortProfiles([...current.profiles, next]) }))
      setActiveKey(next.key)
      setAdvancedOpen(true)
    },
    deleteProfile() {
      const next = draft.profiles.filter((candidate) => candidate.key !== profile.key)
      setDraft({ ...draft, profiles: next })
      setActiveKey(next[0]!.key)
    },
    addRule() {
      updateProfile({
        rules: [
          ...profile.rules,
          { currentEnabled: true, currentK: '', projectedEnabled: true, projectedK: '' }
        ]
      })
    },
    removeRule(index) {
      updateProfile({ rules: profile.rules.filter((_, ruleIndex) => ruleIndex !== index) })
    },
    setAdvancedOpen,
    cancel() {
      setDraft(baseline)
      setError(null)
    },
    restoreRecommended() {
      const next = settingsToDraft(defaultContextIgnoreSettings())
      setDraft(next)
      setActiveKey(next.profiles[1]!.key)
      setAdvancedOpen(false)
      setError(null)
    },
    save,
    reload() {
      void load()
    },
    finishLeave(leave) {
      const resolve = leaveResolve.current
      leaveResolve.current = null
      setLeaveOpen(false)
      resolve?.(leave)
    }
  }
}
