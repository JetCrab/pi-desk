import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import type { BrowserBeforeLeaveHandler } from '@jetcrab/pi-desk-sdk/browser'
import type {
  L2McpServerConfig,
  L2McpSettings
} from '@common/l2_biz/pi-settings/l2-pi-settings-contract'
import { useL4ConfirmDialog } from '@client/l4_foundation/ui/l4-confirm-dialog'
import { createL2PiSettingsBiz, parseL2McpImport } from '../l2-pi-settings-biz'
import {
  buildL2McpDraft,
  createL2McpDraft,
  isL2McpShorthand,
  L2McpInputError,
  validateL2McpImport,
  type L2McpDraft,
  type L2McpSettingsRow
} from '../l2-pi-settings-model'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'

export type L2McpEditor =
  | { kind: 'manual'; draft: L2McpDraft; initial: string }
  | {
      kind: 'json'
      text: string
      preview: Record<string, L2McpServerConfig> | null
      overwrite: boolean
    }

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '请求失败，请重试。'
}

export interface L2PiSettingsController {
  cwd: string | null
  displayCwd: string | null
  ready: boolean
  mcp: L2McpSettings | null
  editor: L2McpEditor | null
  setEditor: Dispatch<SetStateAction<L2McpEditor | null>>
  loading: boolean
  pending: boolean
  loadError: string | null
  error: { field: string; message: string } | null
  notice: string | null
  check: { name: string; loading: boolean; output: string | null; error: string | null } | null
  rows: L2McpSettingsRow[]
  dirty: boolean
  dialog: React.JSX.Element | null
  retry(): void
  navigate(action: () => void): Promise<void>
  setCwd(cwd: string | null): Promise<void>
  startManual(name: string | null, config?: L2McpServerConfig): void
  startInherited(name: string, config: L2McpServerConfig): void
  updateDraft(patch: Partial<L2McpDraft>): void
  updateJson(text: string): void
  previewJson(): void
  saveEditor(testConnection?: boolean): Promise<void>
  remove(name: string): Promise<void>
  dismissCheck(): void
  beforeLeave(): Promise<boolean>
}

export function useL2PiSettings(
  clientId: string,
  onBeforeLeaveChange: (handler: BrowserBeforeLeaveHandler | null) => void
): L2PiSettingsController {
  const t = useL2PiSettingsText()
  const biz = useMemo(() => createL2PiSettingsBiz(clientId), [clientId])
  const { confirm, dialog } = useL4ConfirmDialog()
  const [cwd, setCwdState] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<{ cwd: string | null; data: L2McpSettings } | null>(null)
  const mcp = snapshot?.data ?? null
  const displayCwd = snapshot ? snapshot.cwd : cwd
  const [editor, setEditor] = useState<L2McpEditor | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, setPending] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<{ field: string; message: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [check, setCheck] = useState<{
    name: string
    loading: boolean
    output: string | null
    error: string | null
  } | null>(null)
  const controller = useRef<AbortController | null>(null)
  const epoch = useRef(0)
  const checkEpoch = useRef(0)
  const confirmRef = useRef(confirm)
  const textRef = useRef(t)
  useEffect(() => {
    confirmRef.current = confirm
    textRef.current = t
  }, [confirm, t])
  const ready = snapshot !== null && snapshot.cwd === cwd && !loading && !loadError
  const dirty =
    ready &&
    ((editor?.kind === 'manual' && JSON.stringify(editor.draft) !== editor.initial) ||
      (editor?.kind === 'json' && Boolean(editor.text)))

  const discard = useCallback((): void => {
    setEditor(null)
    setError(null)
  }, [])

  const beforeLeave = useCallback(async (): Promise<boolean> => {
    if (pending || check?.loading) return false
    if (!dirty) return true
    const leave = await confirmRef.current({
      title: textRef.current('放弃未保存的修改？'),
      description: textRef.current('当前修改尚未保存。放弃后将保留已保存的配置。'),
      confirmLabel: textRef.current('放弃修改')
    })
    return leave
  }, [dirty, pending, check?.loading])

  useEffect(() => {
    onBeforeLeaveChange(beforeLeave)
    return () => onBeforeLeaveChange(null)
  }, [beforeLeave, onBeforeLeaveChange])

  const load = useCallback(
    async (signal: AbortSignal, currentEpoch: number, resetEditor = false): Promise<boolean> => {
      setLoading(true)
      setLoadError(null)
      try {
        const result = await biz.getMcp(cwd, signal)
        if (signal.aborted || epoch.current !== currentEpoch) return false
        setSnapshot({ cwd, data: result })
        if (resetEditor) setEditor(null)
        return true
      } catch (cause) {
        if (!signal.aborted && epoch.current === currentEpoch) {
          console.warn('[Pi Desk][MCP] 读取配置失败', { cwd, message: errorMessage(cause) })
          setLoadError(errorMessage(cause))
        }
        return false
      } finally {
        if (!signal.aborted && epoch.current === currentEpoch) setLoading(false)
      }
    },
    [biz, cwd]
  )

  useEffect(() => {
    const current = new AbortController()
    controller.current = current
    const currentEpoch = ++epoch.current
    void load(current.signal, currentEpoch, true)
    return () => current.abort()
  }, [load])

  const retry = (): void => {
    if (controller.current)
      void load(controller.current.signal, epoch.current, snapshot?.cwd !== cwd)
  }

  const navigate = async (action: () => void): Promise<void> => {
    if (await beforeLeave()) {
      discard()
      setNotice(null)
      action()
    }
  }

  const setCwd = async (next: string | null): Promise<void> => {
    if (next === cwd || !(await beforeLeave())) return
    controller.current?.abort()
    setError(null)
    setNotice(null)
    setCheck(null)
    setLoadError(null)
    setLoading(true)
    setCwdState(next)
  }

  const startManual = (name: string | null, config?: L2McpServerConfig): void => {
    const draft = createL2McpDraft(name, config)
    setError(null)
    setNotice(null)
    setCheck(null)
    setEditor({ kind: 'manual', draft, initial: JSON.stringify(draft) })
  }

  const startInherited = (name: string, config: L2McpServerConfig): void => {
    startManual(name, { enabled: config.enabled !== false })
  }

  const updateDraft = (patch: Partial<L2McpDraft>): void => {
    setEditor((current) =>
      current?.kind === 'manual' ? { ...current, draft: { ...current.draft, ...patch } } : current
    )
    setError(null)
    setNotice(null)
    setCheck(null)
  }

  const updateJson = (text: string): void => {
    setEditor({ kind: 'json', text, preview: null, overwrite: false })
    setError(null)
  }

  const previewJson = (): void => {
    if (editor?.kind !== 'json' || !mcp) return
    try {
      const preview = parseL2McpImport(editor.text)
      validateL2McpImport(preview, cwd, mcp.inherited)
      setEditor({ ...editor, preview, overwrite: false })
      setError(null)
    } catch (cause) {
      setError({ field: 'json', message: errorMessage(cause) })
    }
  }

  const mutation = async (
    action: (signal: AbortSignal) => Promise<unknown>,
    onSaved: () => void
  ): Promise<boolean> => {
    const signal = controller.current?.signal
    if (!signal || !ready || pending || check?.loading) return false
    const currentEpoch = epoch.current
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      await action(signal)
      if (signal.aborted || epoch.current !== currentEpoch) return false
      onSaved()
      setCheck(null)
      setNotice('已保存。新会话使用新配置；已有会话需重载 Pi 配置。')
      // 保留展示快照；重新读取完成前由 ready 阻止旧配置参与下一次写入。
      return await load(signal, currentEpoch)
    } catch (cause) {
      if (!signal.aborted && epoch.current === currentEpoch)
        setError({
          field: cause instanceof L2McpInputError ? cause.field : 'save',
          message: errorMessage(cause)
        })
      return false
    } finally {
      if (!signal.aborted && epoch.current === currentEpoch) setPending(false)
    }
  }

  const saveEditor = async (testConnection = false): Promise<void> => {
    if (!editor || !mcp || !ready || pending || check?.loading) return
    if (
      testConnection &&
      (editor.kind !== 'manual' || !editor.draft.enabled || mcp.projectTrusted === false)
    )
      return
    try {
      const servers =
        editor.kind === 'manual'
          ? buildL2McpDraft(
              editor.draft,
              editor.draft.originalName ? mcp.local[editor.draft.originalName] : undefined
            )
          : editor.preview
      if (!servers) return
      const collisions = Object.keys(servers).filter((name) => Object.hasOwn(mcp.local, name))
      if (editor.kind === 'json' && collisions.length && !editor.overwrite) {
        throw new L2McpInputError('json', '请明确勾选替换已有配置。')
      }
      if (
        editor.kind === 'manual' &&
        collisions.some((name) => name !== editor.draft.originalName)
      ) {
        throw new L2McpInputError('name', '该名称已存在，请编辑已有服务或使用其他名称。')
      }
      const saved = await mutation(
        (signal) => biz.replaceMcp({ cwd, servers }, signal),
        () => {
          if (editor.kind === 'json') {
            setEditor(null)
          } else {
            const name = editor.draft.name.trim()
            const draft = createL2McpDraft(name, servers[name])
            setEditor({ kind: 'manual', draft, initial: JSON.stringify(draft) })
          }
        }
      )
      if (saved && testConnection && editor.kind === 'manual') {
        const passed = await runCheck(editor.draft.name.trim())
        if (!controller.current?.signal.aborted)
          setNotice(passed ? '已保存，连接测试通过。' : '已保存，连接测试失败。')
      }
    } catch (cause) {
      setError({
        field: cause instanceof L2McpInputError ? cause.field : 'save',
        message: errorMessage(cause)
      })
    }
  }

  const remove = async (name: string): Promise<void> => {
    if (!mcp || !ready || pending || !Object.hasOwn(mcp.local, name)) return
    const restore = cwd !== null && Object.hasOwn(mcp.inherited, name)
    if (
      !(await confirmRef.current({
        title: `${textRef.current(restore ? '恢复全局配置' : '删除服务')} · ${name}`,
        description: textRef.current(
          restore ? '删除本项目配置后，将恢复使用同名全局配置。' : '此范围内的服务配置将被删除。'
        ),
        confirmLabel: textRef.current(restore ? '恢复全局配置' : '删除服务')
      }))
    )
      return
    await mutation(
      (signal) => biz.deleteMcp(cwd, name, signal),
      () => setEditor(null)
    )
  }

  const runCheck = async (name: string): Promise<boolean> => {
    const signal = controller.current?.signal
    if (!signal || !mcp || mcp.projectTrusted === false || check?.loading) return false
    const current = ++checkEpoch.current
    setCheck({ name, loading: true, output: null, error: null })
    try {
      const result = await biz.checkMcp(cwd, name, signal)
      if (!signal.aborted && checkEpoch.current === current)
        setCheck({ name, loading: false, output: result.output.slice(0, 32768), error: null })
      return true
    } catch (cause) {
      if (!signal.aborted && checkEpoch.current === current)
        setCheck({ name, loading: false, output: null, error: errorMessage(cause) })
      return false
    }
  }

  const rows = mcp
    ? [...new Set([...Object.keys(mcp.inherited), ...Object.keys(mcp.local)])].map((name) => {
        const local = mcp.local[name]
        const inherited = mcp.inherited[name]
        const shorthand = Boolean(local && inherited && isL2McpShorthand(local))
        return {
          name,
          config: shorthand ? { ...inherited, ...local } : (local ?? inherited),
          local: local ?? null,
          source:
            displayCwd === null
              ? '全局'
              : local
                ? shorthand
                  ? '项目配置 · 继承全局连接'
                  : '项目配置'
                : '继承全局'
        }
      })
    : []

  const dismissCheck = (): void => {
    setCheck(null)
  }

  return {
    cwd,
    displayCwd,
    ready,
    mcp,
    editor,
    setEditor,
    loading,
    pending,
    loadError,
    error,
    notice,
    check,
    rows,
    dirty,
    dialog,
    retry,
    navigate,
    setCwd,
    startManual,
    startInherited,
    updateDraft,
    updateJson,
    previewJson,
    saveEditor,
    remove,
    dismissCheck,
    beforeLeave
  }
}
