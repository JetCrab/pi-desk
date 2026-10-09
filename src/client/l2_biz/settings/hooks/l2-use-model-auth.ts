import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelAuthProvider,
  L2ModelAuthState
} from '@common/l2_biz/model-auth/l2-model-auth-contract'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { copyL2ModelAuthText, createL2ModelAuthBiz, openL2ModelAuthUrl } from '../l2-model-auth-biz'

export function useL2ModelAuth(
  connectionReady: boolean,
  onCompleted: (provider: string, isCurrent: () => boolean) => Promise<void>
): {
  open: boolean
  providers: L2ModelAuthProvider[]
  state: L2ModelAuthState | null
  loading: boolean
  submitting: boolean
  error: string | null
  show: (provider?: string) => void
  close: () => void
  start: (provider: string) => Promise<void>
  respond: (promptId: string, value: string) => Promise<void>
  finish: () => Promise<void>
  logout: (provider: string) => Promise<void>
  copy: (value: string) => Promise<void>
  openUrl: (value: string) => void
} {
  const { appSocket } = useL4AppSocket()
  const biz = useMemo(() => createL2ModelAuthBiz(appSocket), [appSocket])
  const { t } = useTranslation('settings')
  const toast = useL4AppToast()
  const [open, setOpen] = useState(false)
  const [providers, setProviders] = useState<L2ModelAuthProvider[]>([])
  const [state, setState] = useState<L2ModelAuthState | null>(null)
  const [loading, setLoading] = useState(false)
  const [finishing, setFinishing] = useState(false)
  const [submittingPrompt, setSubmittingPrompt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const connectionReadyRef = useRef(connectionReady)
  const login = useRef<L2ModelAuthState | null>(null)
  const pendingResponse = useRef<{ loginId: string; promptId: string } | null>(null)
  const finishingLogin = useRef<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const opening = useRef(0)
  const completed = useRef(onCompleted)
  useEffect(() => {
    completed.current = onCompleted
  }, [onCompleted])

  function release(): void {
    const current = login.current
    login.current = null
    pendingResponse.current = null
    finishingLogin.current = null
    unsubscribe.current?.()
    unsubscribe.current = null
    if (current?.status === 'running') {
      void biz.cancel(current.loginId).catch((cause: unknown) => {
        console.warn('[Pi Desk][ModelAuth] 取消登录失败', {
          message: cause instanceof Error ? cause.message : String(cause)
        })
      })
    }
  }

  useEffect(() => {
    return () => {
      opening.current += 1
      const current = login.current
      login.current = null
      unsubscribe.current?.()
      if (current?.status === 'running') void biz.cancel(current.loginId).catch(() => undefined)
    }
  }, [biz])

  useEffect(() => {
    connectionReadyRef.current = connectionReady
    const current = login.current
    if (connectionReady || current?.status !== 'running') return
    login.current = null
    pendingResponse.current = null
    unsubscribe.current?.()
    unsubscribe.current = null
    void biz.cancel(current.loginId).catch(() => undefined)
    const attempt = opening.current
    queueMicrotask(() => {
      if (opening.current !== attempt) return
      setState(null)
      setSubmittingPrompt(null)
      setError(t('accountDisconnected'))
    })
  }, [connectionReady, biz, t])

  function close(): void {
    opening.current += 1
    release()
    setOpen(false)
  }

  async function finish(): Promise<void> {
    const current = login.current
    if (!current || current.status !== 'completed' || finishingLogin.current) return
    finishingLogin.current = current.loginId
    setFinishing(true)
    setError(null)
    const isCurrent = (): boolean => login.current?.loginId === current.loginId
    try {
      await completed.current(current.provider, isCurrent)
      if (isCurrent()) close()
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : t('accountRefreshFailed'))
    } finally {
      if (isCurrent()) {
        finishingLogin.current = null
        setFinishing(false)
      }
    }
  }

  async function start(provider: string): Promise<void> {
    if (!connectionReadyRef.current) {
      setError(t('accountConnectionNotReady'))
      return
    }
    if (login.current?.status === 'running') return
    release()
    const current: L2ModelAuthState = {
      loginId: crypto.randomUUID(),
      provider,
      status: 'running',
      notice: null,
      prompt: null,
      message: null
    }
    login.current = current
    setState(current)
    setError(null)
    setSubmittingPrompt(null)
    unsubscribe.current = biz.subscribe((next) => {
      if (login.current?.loginId !== next.loginId) return
      if (login.current.prompt?.id !== next.prompt?.id || next.status !== 'running') {
        pendingResponse.current = null
        setSubmittingPrompt(null)
      }
      login.current = next
      setState(next)
      setError(next.status === 'error' && !next.message ? t('accountLoginFailed') : null)
      if (next.status === 'completed') void finish()
    })
    try {
      await biz.start(current.loginId, provider)
    } catch (cause) {
      if (login.current?.loginId !== current.loginId || login.current.status !== 'running') return
      release()
      setState(null)
      setError(cause instanceof Error ? cause.message : t('accountLoginFailed'))
    }
  }

  function show(provider?: string): void {
    close()
    // 退场时保留当前内容，避免关闭动画中切回渠道列表。
    setState(null)
    setError(null)
    setSubmittingPrompt(null)
    setFinishing(false)
    setOpen(true)
    if (!connectionReadyRef.current) {
      setLoading(false)
      setError(t('accountConnectionNotReady'))
      return
    }
    setLoading(true)
    const attempt = ++opening.current
    void biz
      .list()
      .then((next) => {
        if (opening.current !== attempt) return
        setProviders(next)
        if (provider && next.some((item) => item.provider === provider && !item.conflict))
          void start(provider)
      })
      .catch((cause: unknown) => {
        if (opening.current === attempt)
          setError(cause instanceof Error ? cause.message : t('accountLoginFailed'))
      })
      .finally(() => {
        if (opening.current === attempt) setLoading(false)
      })
  }

  async function respond(promptId: string, value: string): Promise<void> {
    const current = login.current
    if (
      !connectionReadyRef.current ||
      !current ||
      current.status !== 'running' ||
      current.prompt?.id !== promptId ||
      pendingResponse.current
    )
      return
    const pending = { loginId: current.loginId, promptId }
    pendingResponse.current = pending
    setSubmittingPrompt(promptId)
    setError(null)
    try {
      await biz.respond(current.loginId, promptId, value)
    } catch (cause) {
      if (login.current?.loginId === current.loginId && login.current.prompt?.id === promptId)
        setError(cause instanceof Error ? cause.message : t('accountLoginFailed'))
    } finally {
      if (pendingResponse.current === pending) {
        pendingResponse.current = null
        setSubmittingPrompt(null)
      }
    }
  }

  return {
    open,
    providers,
    state,
    loading: loading || finishing,
    submitting: submittingPrompt !== null && submittingPrompt === state?.prompt?.id,
    error,
    show,
    close,
    start,
    respond,
    finish,
    async logout(provider): Promise<void> {
      if (!connectionReadyRef.current) throw new Error(t('accountConnectionNotReady'))
      await biz.logout(provider)
    },
    async copy(value): Promise<void> {
      try {
        await copyL2ModelAuthText(value)
        toast.success(t('accountCopied'))
      } catch {
        toast.error(t('accountCopyFailed'))
      }
    },
    openUrl: openL2ModelAuthUrl
  }
}
