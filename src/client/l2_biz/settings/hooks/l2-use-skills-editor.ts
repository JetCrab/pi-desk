import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  L2SkillFileGetRequest,
  L2SkillFileGetResponse
} from '@common/l2_biz/settings/l2-skills-contract'
import { useL4CodePreferences } from '@client/l4_foundation/ui/code/l4-code-preferences'
import { setL2SkillsWrapLines, type L2SkillsBiz } from '../l2-skills-biz'
import { l2SkillsText } from '../l2-skills-text'

export interface L2SkillDocument {
  target: L2SkillFileGetRequest
  file: L2SkillFileGetResponse | null
  draft: string
  error: string | null
}
interface SkillsEditor {
  document: L2SkillDocument | null
  dirty: boolean
  loading: boolean
  openingTarget: L2SkillFileGetRequest | null
  saving: boolean
  confirmOpen: boolean
  wrapLines: boolean
  setWrapLines: (value: boolean) => void
  change: (content: string) => void
  open: (target: L2SkillFileGetRequest) => Promise<boolean>
  save: () => Promise<boolean>
  beforeLeave: () => Promise<boolean>
  decide: (choice: 'save' | 'discard' | 'cancel') => Promise<void>
}

function normalize(text: string): string {
  return text.replace(/\r\n|\r/g, '\n')
}
function isDirty(document: L2SkillDocument | null): boolean {
  return document?.file?.kind === 'text' && document.draft !== normalize(document.file.content)
}

export function useL2SkillsEditor(
  biz: L2SkillsBiz,
  onSaved: (cwd: string | null) => void
): SkillsEditor {
  const { wrapLines } = useL4CodePreferences()
  const [document, setDocument] = useState<L2SkillDocument | null>(null)
  const current = useRef<L2SkillDocument | null>(null)
  const mounted = useRef(true)
  const [loading, setLoading] = useState(false)
  const [openingTarget, setOpeningTarget] = useState<L2SkillFileGetRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const savePending = useRef<Promise<boolean> | null>(null)
  const navigatePending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const decision = useRef<{
    promise: Promise<boolean>
    resolve: (allowed: boolean) => void
  } | null>(null)

  const apply = useCallback((next: L2SkillDocument | null): void => {
    if (!mounted.current) return
    current.current = next
    setDocument(next)
  }, [])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      controller.current?.abort()
      decision.current?.resolve(false)
      decision.current = null
    }
  }, [])

  const save = useCallback((): Promise<boolean> => {
    if (savePending.current) return savePending.current
    const selected = current.current
    if (!selected || selected.file?.kind !== 'text' || selected.file.readOnlyReason)
      return Promise.resolve(false)
    if (!isDirty(selected)) return Promise.resolve(true)
    setSaving(true)
    const operation = (async (): Promise<boolean> => {
      try {
        await biz.replaceFile({ ...selected.target, content: selected.draft })
        const latest = current.current
        if (latest?.file?.kind === 'text' && latest.target === selected.target) {
          // 提交的文本成为基线；保存过程中后续输入仍保留为未保存内容。
          apply({ ...latest, file: { ...latest.file, content: selected.draft }, error: null })
        }
        if (mounted.current) onSaved(selected.target.cwd)
        return true
      } catch (error) {
        const latest = current.current
        if (latest?.target === selected.target)
          apply({
            ...latest,
            error: error instanceof Error ? error.message : l2SkillsText('saveFailed')
          })
        return false
      } finally {
        savePending.current = null
        if (mounted.current) setSaving(false)
      }
    })()
    savePending.current = operation
    return operation
  }, [apply, biz, onSaved])

  const beforeLeave = useCallback(async (): Promise<boolean> => {
    if (savePending.current) await savePending.current
    if (!mounted.current) return false
    if (!isDirty(current.current)) return true
    if (decision.current) return decision.current.promise
    let resolveDecision!: (allowed: boolean) => void
    const promise = new Promise<boolean>((resolve) => {
      resolveDecision = resolve
    })
    decision.current = { promise, resolve: resolveDecision }
    setConfirmOpen(true)
    return promise
  }, [])

  const decide = useCallback(
    async (choice: 'save' | 'discard' | 'cancel'): Promise<void> => {
      if (!decision.current || savePending.current) return
      if (choice === 'save' && (!(await save()) || isDirty(current.current))) return
      if (choice === 'discard') {
        const latest = current.current
        if (latest?.file?.kind === 'text')
          apply({ ...latest, draft: normalize(latest.file.content), error: null })
      }
      const pending = decision.current
      decision.current = null
      setConfirmOpen(false)
      pending?.resolve(choice !== 'cancel')
    },
    [apply, save]
  )

  const open = useCallback(
    async (target: L2SkillFileGetRequest): Promise<boolean> => {
      if (navigatePending.current) return false
      navigatePending.current = true
      try {
        if (!(await beforeLeave()) || !mounted.current) return false
        controller.current?.abort()
        const request = new AbortController()
        controller.current = request
        // 保留已打开的内容，只有新文件完整读取后才替换 Monaco 的 Model。
        setOpeningTarget(target)
        setLoading(true)
        try {
          const file = await biz.getFile(target, request.signal)
          if (request.signal.aborted || !mounted.current) return false
          apply({
            target,
            file,
            draft: file.kind === 'text' ? normalize(file.content) : '',
            error: null
          })
          return true
        } catch (error) {
          if (!request.signal.aborted) {
            const previous = current.current
            const message = error instanceof Error ? error.message : l2SkillsText('fileReadFailed')
            apply(
              previous
                ? { ...previous, error: message }
                : { target, file: null, draft: '', error: message }
            )
          }
          return false
        } finally {
          if (mounted.current) {
            setOpeningTarget(null)
            setLoading(false)
          }
        }
      } finally {
        navigatePending.current = false
      }
    },
    [apply, beforeLeave, biz]
  )

  const change = useCallback(
    (draft: string): void => {
      const latest = current.current
      if (latest?.file?.kind === 'text' && !latest.file.readOnlyReason && latest.draft !== draft)
        apply({ ...latest, draft })
    },
    [apply]
  )
  const dirty = isDirty(document)
  useEffect(() => {
    if (!dirty) return
    const guard = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [dirty])
  return {
    document,
    dirty,
    loading,
    openingTarget,
    saving,
    confirmOpen,
    wrapLines,
    setWrapLines: setL2SkillsWrapLines,
    change,
    open,
    save,
    beforeLeave,
    decide
  }
}
