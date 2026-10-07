'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L3PiNativeCommandInfo } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'
import {
  buildL2WorkbenchSlashCommandGroups,
  L2_WORKBENCH_RELOAD_COMMAND,
  readL2WorkbenchSlashCommandQuery,
  type L2WorkbenchSlashCommandCandidate,
  type L2WorkbenchSlashCommandGroup
} from '../l2-workbench-slash-command'

interface L2WorkbenchSlashCommandRemoteState {
  sourceKey: string
  status: 'idle' | 'loading' | 'ready' | 'error'
  commands: readonly L3PiNativeCommandInfo[]
  error: string | null
}

interface L2WorkbenchSlashCommandActiveSelection {
  contextKey: string
  commandKey: string
}

interface UseL2WorkbenchSlashCommandInput {
  source: L2ChatSource
  text: string
  enabled: boolean
  listPiCommands: L2WorkbenchBiz['listPiCommands']
  onSelect: (command: L2WorkbenchSlashCommandCandidate) => void
}

export interface L2WorkbenchSlashCommandController {
  open: boolean
  loading: boolean
  error: string | null
  groups: readonly L2WorkbenchSlashCommandGroup[]
  commands: readonly L2WorkbenchSlashCommandCandidate[]
  activeIndex: number
  dismiss: () => void
  reopen: () => void
  refresh: () => Promise<void>
  select: (index: number) => void
  setActiveIndex: (index: number) => void
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean
  handleCompositionStart: () => void
  handleCompositionEnd: () => void
}

function sourceKey(source: L2ChatSource): string {
  return JSON.stringify([source.workId, source.sessionId, source.branchId])
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : '查询命令失败'
}

export function useL2WorkbenchSlashCommand({
  source,
  text,
  enabled,
  listPiCommands,
  onSelect
}: UseL2WorkbenchSlashCommandInput): L2WorkbenchSlashCommandController {
  const currentSourceKey = sourceKey(source)
  const [composing, setComposing] = useState(false)
  const [dismissedContextKey, setDismissedContextKey] = useState<string | null>(null)
  const [activeSelection, setActiveSelection] =
    useState<L2WorkbenchSlashCommandActiveSelection | null>(null)
  const [remote, setRemote] = useState<L2WorkbenchSlashCommandRemoteState>({
    sourceKey: currentSourceKey,
    status: 'idle',
    commands: [],
    error: null
  })
  const requestIdRef = useRef(0)
  const mountedRef = useRef(true)
  const query = enabled && !composing ? readL2WorkbenchSlashCommandQuery(text) : null
  const contextKey = query === null ? null : `${currentSourceKey}\u0000${text}`
  const open = contextKey !== null && contextKey !== dismissedContextKey
  const { workId, sessionId, branchId } = source

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      requestIdRef.current += 1
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const requestId = ++requestIdRef.current
    queueMicrotask(() => {
      if (!mountedRef.current || requestIdRef.current !== requestId) return
      setRemote((current) =>
        current.sourceKey === currentSourceKey
          ? { ...current, status: 'loading', error: null }
          : {
              sourceKey: currentSourceKey,
              status: 'loading',
              commands: [],
              error: null
            }
      )
    })

    try {
      const response = await listPiCommands({ source: { workId, sessionId, branchId } })
      if (!mountedRef.current || requestIdRef.current !== requestId) return
      setRemote({
        sourceKey: currentSourceKey,
        status: 'ready',
        commands: response.commands,
        error: null
      })
    } catch (cause: unknown) {
      if (!mountedRef.current || requestIdRef.current !== requestId) return
      console.warn('[Pi Desk][SlashCommand] 查询当前会话命令失败', {
        workId,
        sessionId,
        branchId,
        errorName: cause instanceof Error ? cause.name : 'UnknownError'
      })
      setRemote((current) => ({
        sourceKey: currentSourceKey,
        status: 'error',
        commands: current.sourceKey === currentSourceKey ? current.commands : [],
        error: errorMessage(cause)
      }))
      throw cause
    }
  }, [branchId, currentSourceKey, listPiCommands, sessionId, workId])

  useEffect(() => {
    if (!open) return
    void refresh().catch(() => undefined)
  }, [open, refresh])

  const candidates = useMemo<readonly L2WorkbenchSlashCommandCandidate[]>(() => {
    const remoteCommands = remote.sourceKey === currentSourceKey ? remote.commands : []
    return [
      L2_WORKBENCH_RELOAD_COMMAND,
      ...remoteCommands
        .filter((command) => command.name !== L2_WORKBENCH_RELOAD_COMMAND.name)
        .map((command) => ({
          key: `${command.source}:${command.name}`,
          name: command.name,
          description: command.description,
          source: command.source
        }))
    ]
  }, [currentSourceKey, remote.commands, remote.sourceKey])
  const groups = useMemo(
    () => buildL2WorkbenchSlashCommandGroups(candidates, query ?? ''),
    [candidates, query]
  )
  const commands = useMemo(() => groups.flatMap((group) => group.commands), [groups])
  const selectedIndex =
    contextKey && activeSelection?.contextKey === contextKey
      ? commands.findIndex((command) => command.key === activeSelection.commandKey)
      : -1
  const activeIndex = selectedIndex >= 0 ? selectedIndex : 0

  const setActiveIndex = useCallback(
    (index: number): void => {
      if (!contextKey || commands.length === 0) return
      const normalizedIndex = (index + commands.length) % commands.length
      const command = commands[normalizedIndex]
      if (!command) return
      setActiveSelection({ contextKey, commandKey: command.key })
    },
    [commands, contextKey]
  )

  const dismiss = useCallback((): void => {
    if (contextKey) setDismissedContextKey(contextKey)
  }, [contextKey])

  const reopen = useCallback((): void => {
    if (contextKey) setDismissedContextKey(null)
  }, [contextKey])

  const select = useCallback(
    (index: number): void => {
      const command = commands[index]
      if (!command) return
      if (contextKey) setDismissedContextKey(contextKey)
      onSelect(command)
    },
    [commands, contextKey, onSelect]
  )

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open || event.nativeEvent.isComposing) return false
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false

      if (event.key === 'Escape') {
        event.preventDefault()
        dismiss()
        return true
      }
      if (commands.length === 0) return false
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex(activeIndex + 1)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex(activeIndex - 1)
        return true
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        select(activeIndex)
        return true
      }
      return false
    },
    [activeIndex, commands.length, dismiss, open, select, setActiveIndex]
  )

  const handleCompositionStart = useCallback((): void => {
    setComposing(true)
  }, [])
  const handleCompositionEnd = useCallback((): void => {
    setComposing(false)
    setDismissedContextKey(null)
  }, [])

  return {
    open,
    loading: remote.sourceKey === currentSourceKey && remote.status === 'loading',
    error: remote.sourceKey === currentSourceKey && remote.status === 'error' ? remote.error : null,
    groups,
    commands,
    activeIndex,
    dismiss,
    reopen,
    refresh,
    select,
    setActiveIndex,
    handleKeyDown,
    handleCompositionStart,
    handleCompositionEnd
  }
}
