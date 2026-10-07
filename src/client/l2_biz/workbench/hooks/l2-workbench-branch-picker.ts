'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  L2WorkSessionListItem,
  L2WorkSessionListResponse
} from '@common/l2_biz/work-session/l2-work-session-contract'
import type {
  L2WorkSessionBranchRequest,
  L2WorkSessionTreeEntryGetResponse,
  L2WorkSessionTreeGetResponse
} from '@common/l2_biz/work-session/l2-work-session-tree-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'
import type { L2WorkbenchBranchPickerModel } from '../l2-workbench-branch-picker'
import type { L2WorkbenchChatInputRuntime } from '../l2-workbench-chat-input-runtime'
import { resolveL2WorkbenchBranchTreeDraft } from '../l2-workbench-branch-tree'
import { l2WorkbenchText } from '../l2-workbench-text'

interface L2WorkbenchBranchPickerSource {
  workId: string
  sessionId: string
  branchId: string
}

export type L2WorkbenchBranchIntent =
  { action: 'tree'; entryId: string } | { action: 'fork'; entryId: string } | { action: 'clone' }

interface L2WorkbenchRunningConfirmation {
  intent: L2WorkbenchBranchIntent
  reason: 'main' | 'background'
  waiting: boolean
}

interface L2WorkbenchBranchOperation {
  source: L2WorkbenchBranchPickerSource
  intent: L2WorkbenchBranchIntent
  phase: 'waiting' | 'executing'
}

interface UseL2WorkbenchBranchPickerInput {
  disabled: boolean
  workSessions: readonly L2WorkSessionListItem[]
  workbenchBiz: L2WorkbenchBiz
  chatInputRuntime: L2WorkbenchChatInputRuntime
  applyWorkSessionSnapshot: (snapshot: L2WorkSessionListResponse) => void
  applyCreatedWorkSessionBehavior: (workSession: L2WorkSessionListItem) => Promise<void>
  focusWorkSession: (workId: string) => void
  onError: (message: string) => void
  mobile: boolean
}

interface UseL2WorkbenchBranchPickerResult {
  model: L2WorkbenchBranchPickerModel | null
  open: (workId: string) => void
  close: () => void
  retry: () => void
  selectEntry: (entryId: string) => void
  requestAction: (entryId: string, action: 'tree' | 'fork') => void
  clone: (workId: string) => void
  confirmRunning: () => void
  cancelRunning: () => void
  pendingWorkId: string | null
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'AbortError'
}

function isRunning(workSession: L2WorkSessionListItem): boolean {
  return workSession.status === 'main_running' || workSession.status === 'background_running'
}

function sourceFor(workSession: L2WorkSessionListItem): L2WorkbenchBranchPickerSource {
  return {
    workId: workSession.workId,
    sessionId: workSession.sessionId,
    branchId: workSession.branchId
  }
}

function branchRequest(
  source: L2WorkbenchBranchPickerSource,
  intent: L2WorkbenchBranchIntent
): L2WorkSessionBranchRequest {
  const binding = { workId: source.workId, sessionId: source.sessionId }
  switch (intent.action) {
    case 'tree':
      return { ...binding, action: 'tree', entryId: intent.entryId }
    case 'fork':
      return { ...binding, action: 'fork', entryId: intent.entryId }
    case 'clone':
      return { ...binding, action: 'clone' }
  }
}

export function useL2WorkbenchBranchPicker({
  disabled,
  workSessions,
  workbenchBiz,
  chatInputRuntime,
  applyWorkSessionSnapshot,
  applyCreatedWorkSessionBehavior,
  focusWorkSession,
  onError,
  mobile
}: UseL2WorkbenchBranchPickerInput): UseL2WorkbenchBranchPickerResult {
  const [source, setSource] = useState<L2WorkbenchBranchPickerSource | null>(null)
  const [tree, setTree] = useState<L2WorkSessionTreeGetResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detail, setDetail] = useState<L2WorkSessionTreeEntryGetResponse | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<L2WorkbenchRunningConfirmation | null>(null)
  const [operation, setOperation] = useState<L2WorkbenchBranchOperation | null>(null)
  const treeRequestIdRef = useRef(0)
  const treeAbortControllerRef = useRef<AbortController | null>(null)
  const detailRequestIdRef = useRef(0)
  const detailAbortControllerRef = useRef<AbortController | null>(null)
  const detailCacheRef = useRef(new Map<string, L2WorkSessionTreeEntryGetResponse>())
  const operationStartRef = useRef<string | null>(null)

  const resetPicker = useCallback((): void => {
    treeRequestIdRef.current += 1
    treeAbortControllerRef.current?.abort()
    treeAbortControllerRef.current = null
    detailRequestIdRef.current += 1
    detailAbortControllerRef.current?.abort()
    detailAbortControllerRef.current = null
    detailCacheRef.current.clear()
    operationStartRef.current = null
    setSource(null)
    setTree(null)
    setLoading(false)
    setError(null)
    setDetail(null)
    setDetailLoading(false)
    setDetailError(null)
    setConfirmation(null)
  }, [])

  const close = useCallback((): void => {
    if (operation) return
    resetPicker()
  }, [operation, resetPicker])

  useEffect(
    () => () => {
      treeAbortControllerRef.current?.abort()
      detailAbortControllerRef.current?.abort()
    },
    []
  )

  const loadTree = useCallback(
    async (nextSource: L2WorkbenchBranchPickerSource): Promise<void> => {
      const requestId = ++treeRequestIdRef.current
      treeAbortControllerRef.current?.abort()
      const controller = new AbortController()
      treeAbortControllerRef.current = controller
      detailRequestIdRef.current += 1
      detailAbortControllerRef.current?.abort()
      detailAbortControllerRef.current = null
      detailCacheRef.current.clear()
      setSource(nextSource)
      setTree(null)
      setLoading(true)
      setError(null)
      setDetail(null)
      setDetailLoading(false)
      setDetailError(null)
      setConfirmation(null)
      try {
        const response = await workbenchBiz.getWorkSessionTree(
          { workId: nextSource.workId, sessionId: nextSource.sessionId },
          controller.signal
        )
        if (treeRequestIdRef.current !== requestId) return
        setTree(response)
      } catch (cause) {
        if (treeRequestIdRef.current !== requestId || isAbortError(cause)) return
        setError(errorMessage(cause, l2WorkbenchText('treeLoadFailed')))
      } finally {
        if (treeRequestIdRef.current === requestId) {
          if (treeAbortControllerRef.current === controller) treeAbortControllerRef.current = null
          setLoading(false)
        }
      }
    },
    [workbenchBiz]
  )

  const open = useCallback(
    (workId: string): void => {
      if (disabled) return
      const workSession = workSessions.find((item) => item.workId === workId)
      if (!workSession) {
        onError(l2WorkbenchText('treeSourceInvalid'))
        return
      }
      focusWorkSession(workId)
      void loadTree(sourceFor(workSession))
    },
    [disabled, focusWorkSession, loadTree, onError, workSessions]
  )

  const retry = useCallback((): void => {
    if (source && !disabled) void loadTree(source)
  }, [disabled, loadTree, source])

  const selectEntry = useCallback(
    (entryId: string): void => {
      if (!source) return
      const cached = detailCacheRef.current.get(entryId)
      if (cached) {
        detailRequestIdRef.current += 1
        detailAbortControllerRef.current?.abort()
        detailAbortControllerRef.current = null
        setDetail(cached)
        setDetailLoading(false)
        setDetailError(null)
        return
      }

      const requestId = ++detailRequestIdRef.current
      detailAbortControllerRef.current?.abort()
      const controller = new AbortController()
      detailAbortControllerRef.current = controller
      setDetail(null)
      setDetailLoading(true)
      setDetailError(null)
      void workbenchBiz
        .getWorkSessionTreeEntry(
          { workId: source.workId, sessionId: source.sessionId, entryId },
          controller.signal
        )
        .then((response) => {
          if (detailRequestIdRef.current !== requestId) return
          detailCacheRef.current.set(entryId, response)
          setDetail(response)
        })
        .catch((cause: unknown) => {
          if (detailRequestIdRef.current !== requestId || isAbortError(cause)) return
          setDetailError(errorMessage(cause, l2WorkbenchText('treeDetailFailed')))
        })
        .finally(() => {
          if (detailRequestIdRef.current !== requestId) return
          if (detailAbortControllerRef.current === controller) {
            detailAbortControllerRef.current = null
          }
          setDetailLoading(false)
        })
    },
    [source, workbenchBiz]
  )

  const reportOperationError = useCallback(
    (message: string): void => {
      onError(message)
    },
    [onError]
  )

  const execute = useCallback(
    async (
      operationSource: L2WorkbenchBranchPickerSource,
      intent: L2WorkbenchBranchIntent
    ): Promise<void> => {
      if (disabled) return
      const preservedTreeText =
        intent.action === 'tree' ? chatInputRuntime.getState(operationSource).text : null
      setOperation({ source: operationSource, intent, phase: 'executing' })
      setError(null)
      try {
        const response = await workbenchBiz.branchWorkSession(
          branchRequest(operationSource, intent)
        )
        const snapshot: L2WorkSessionListResponse = {
          workSessions: response.workSessions,
          pinnedCount: response.pinnedCount
        }
        applyWorkSessionSnapshot(snapshot)
        const target = response.workSessions.find(
          (workSession) => workSession.workId === response.targetWorkId
        )
        if (!target) throw new Error(l2WorkbenchText('branchTargetMissing'))

        const targetSource = sourceFor(target)
        if (intent.action === 'tree') {
          focusWorkSession(target.workId)
          await chatInputRuntime.loadSource(targetSource)
          chatInputRuntime.setText(
            targetSource,
            resolveL2WorkbenchBranchTreeDraft(preservedTreeText ?? '', response.editorText)
          )
        } else {
          if (response.editorText !== null) {
            await chatInputRuntime.loadSource(targetSource)
            chatInputRuntime.setText(targetSource, response.editorText)
          }
          await applyCreatedWorkSessionBehavior(target)
        }
        setOperation(null)
        operationStartRef.current = null
        resetPicker()
      } catch (cause) {
        setOperation(null)
        operationStartRef.current = null
        setConfirmation((current) => (current ? { ...current, waiting: false } : null))
        reportOperationError(errorMessage(cause, l2WorkbenchText('branchOperationFailed')))
      }
    },
    [
      applyCreatedWorkSessionBehavior,
      applyWorkSessionSnapshot,
      chatInputRuntime,
      disabled,
      focusWorkSession,
      reportOperationError,
      resetPicker,
      workbenchBiz
    ]
  )

  const startAfterRunning = useCallback(
    (
      operationSource: L2WorkbenchBranchPickerSource,
      intent: L2WorkbenchBranchIntent,
      current: L2WorkSessionListItem
    ): void => {
      setOperation({ source: operationSource, intent, phase: 'waiting' })
      setConfirmation((value) => (value ? { ...value, waiting: true } : value))
      if (current.status !== 'main_running') return
      void chatInputRuntime.interrupt(operationSource).catch((cause: unknown) => {
        setOperation(null)
        operationStartRef.current = null
        setConfirmation((value) => (value ? { ...value, waiting: false } : value))
        reportOperationError(errorMessage(cause, l2WorkbenchText('interruptForBranchFailed')))
      })
    },
    [chatInputRuntime, reportOperationError]
  )

  const requestIntent = useCallback(
    (operationSource: L2WorkbenchBranchPickerSource, intent: L2WorkbenchBranchIntent): void => {
      if (disabled || operation) return
      operationStartRef.current = null
      const current = workSessions.find(
        (workSession) => workSession.workId === operationSource.workId
      )
      if (
        !current ||
        current.sessionId !== operationSource.sessionId ||
        current.branchId !== operationSource.branchId
      ) {
        reportOperationError(l2WorkbenchText('treeChanged'))
        return
      }

      if (intent.action === 'fork' || !isRunning(current)) {
        void execute(operationSource, intent)
        return
      }
      const reason = current.status === 'main_running' ? 'main' : 'background'
      if (mobile) {
        startAfterRunning(operationSource, intent, current)
        return
      }
      setConfirmation({ intent, reason, waiting: false })
      setSource(operationSource)
      setError(null)
    },
    [disabled, execute, mobile, operation, reportOperationError, startAfterRunning, workSessions]
  )

  const requestAction = useCallback(
    (entryId: string, action: 'tree' | 'fork'): void => {
      if (!source) return
      requestIntent(source, { action, entryId })
    },
    [requestIntent, source]
  )

  const clone = useCallback(
    (workId: string): void => {
      const current = workSessions.find((workSession) => workSession.workId === workId)
      if (!current) {
        onError(l2WorkbenchText('cloneUnavailable'))
        return
      }
      requestIntent(sourceFor(current), { action: 'clone' })
    },
    [onError, requestIntent, workSessions]
  )

  const confirmRunning = useCallback((): void => {
    if (disabled || !source || !confirmation || confirmation.waiting || operation) return
    const current = workSessions.find((workSession) => workSession.workId === source.workId)
    if (!current) {
      reportOperationError(l2WorkbenchText('branchUnavailable'))
      return
    }
    if (!isRunning(current)) {
      void execute(source, confirmation.intent)
      return
    }
    startAfterRunning(source, confirmation.intent, current)
  }, [
    confirmation,
    disabled,
    execute,
    operation,
    reportOperationError,
    source,
    startAfterRunning,
    workSessions
  ])

  const cancelRunning = useCallback((): void => {
    if (confirmation?.waiting || operation) return
    const cloneOnly = confirmation?.intent.action === 'clone' && tree === null
    setConfirmation(null)
    if (cloneOnly) resetPicker()
  }, [confirmation, operation, resetPicker, tree])

  useEffect(() => {
    if (disabled || !operation || operation.phase !== 'waiting') return
    const current = workSessions.find(
      (workSession) => workSession.workId === operation.source.workId
    )
    if (!current) {
      const key = `${operation.source.workId}:${operation.intent.action}:missing`
      if (operationStartRef.current === key) return
      operationStartRef.current = key
      queueMicrotask(() => {
        setOperation(null)
        operationStartRef.current = null
        setConfirmation((value) => (value ? { ...value, waiting: false } : value))
        reportOperationError(l2WorkbenchText('branchUnavailable'))
      })
      return
    }
    if (
      current.sessionId !== operation.source.sessionId ||
      current.branchId !== operation.source.branchId
    ) {
      const key = `${operation.source.workId}:${operation.intent.action}:changed`
      if (operationStartRef.current === key) return
      operationStartRef.current = key
      queueMicrotask(() => {
        setOperation(null)
        operationStartRef.current = null
        setConfirmation((value) => (value ? { ...value, waiting: false } : value))
        reportOperationError(l2WorkbenchText('branchChanged'))
      })
      return
    }
    if (isRunning(current)) return

    const key = `${operation.source.workId}:${operation.intent.action}:${
      'entryId' in operation.intent ? operation.intent.entryId : ''
    }`
    if (operationStartRef.current === key) return
    operationStartRef.current = key
    let active = true
    queueMicrotask(() => {
      if (active) void execute(operation.source, operation.intent)
    })
    return () => {
      active = false
      // 重连可能取消尚未执行的调度，不能让旧标记阻止恢复后的再次调度。
      if (operationStartRef.current === key) operationStartRef.current = null
    }
  }, [disabled, execute, operation, reportOperationError, workSessions])

  useEffect(() => {
    if (!source || operation || confirmation) return
    const current = workSessions.find((workSession) => workSession.workId === source.workId)
    if (current?.sessionId === source.sessionId && current.branchId === source.branchId) return

    let active = true
    queueMicrotask(() => {
      if (active) resetPicker()
    })
    return () => {
      active = false
    }
  }, [confirmation, operation, resetPicker, source, workSessions])

  const model = useMemo<L2WorkbenchBranchPickerModel | null>(() => {
    if (!source) return null
    const current = workSessions.find((workSession) => workSession.workId === source.workId)
    const bindingMatches =
      current?.sessionId === source.sessionId && current.branchId === source.branchId
    if (!operation && !confirmation && !bindingMatches) return null
    return {
      workId: source.workId,
      tree,
      loading,
      actionsDisabled: disabled,
      pending: operation !== null,
      error,
      detail,
      detailLoading,
      detailError,
      runningConfirmation: confirmation
    }
  }, [
    confirmation,
    detail,
    detailError,
    detailLoading,
    disabled,
    error,
    loading,
    operation,
    source,
    tree,
    workSessions
  ])

  return {
    model,
    open,
    close,
    retry,
    selectEntry,
    requestAction,
    clone,
    confirmRunning,
    cancelRunning,
    pendingWorkId: operation?.source.workId ?? null
  }
}
