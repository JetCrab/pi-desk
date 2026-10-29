'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L2ChatModelContextGetResponse } from '@common/l2_biz/chat/l2-chat-context-contract'
import type {
  L3PiNativeCommandsListResponse,
  L3PiNativeToolsListResponse
} from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type { L2WorkbenchBiz } from '../l2-workbench-biz'
import type { L2WorkbenchChatInputRuntime } from '../l2-workbench-chat-input-runtime'
import type { L2NativeUiBiz, L2NativeUiState } from '../native-ui/l2-native-ui-biz'

export type L2WorkbenchContextTab = 'tools' | 'system' | 'mcp'

interface PanelData<T> {
  value: T | null
  loading: boolean
  error: string | null
  retry: () => void
}

function usePanelData<T>(enabled: boolean, load: () => Promise<T>): PanelData<T> {
  const [state, setState] = useState<Omit<PanelData<T>, 'retry'>>({
    value: null,
    loading: false,
    error: null
  })
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let current = true
    void Promise.resolve().then(async () => {
      if (!current) return
      setState({ value: null, loading: true, error: null })
      try {
        const value = await load()
        if (current) setState({ value, loading: false, error: null })
      } catch (cause) {
        if (current)
          setState({
            value: null,
            loading: false,
            error: cause instanceof Error ? cause.message : String(cause)
          })
      }
    })
    return () => {
      current = false
    }
  }, [attempt, enabled, load])
  return { ...state, retry: () => setAttempt((value) => value + 1) }
}

export function useL2WorkbenchModelContext(input: {
  source: L2ChatSource
  open: boolean
  tab: L2WorkbenchContextTab
  runtime: L2WorkbenchChatInputRuntime
  getContext: L2WorkbenchBiz['getChatModelContext']
  listCommands: L2WorkbenchBiz['listPiCommands']
  nativeBiz: L2NativeUiBiz
  nativeState: L2NativeUiState
}): {
  context: PanelData<L2ChatModelContextGetResponse>
  tools: PanelData<L3PiNativeToolsListResponse>
  commands: PanelData<L3PiNativeCommandsListResponse>
} {
  const { source, runtime, getContext, listCommands, open, tab, nativeBiz, nativeState } = input
  const loadContext = useCallback(() => getContext({ source }), [getContext, source])
  const loadTools = useCallback(() => runtime.listTools(source), [runtime, source])
  const loadCommands = useCallback(() => listCommands({ source }), [listCommands, source])
  const context = usePanelData(open && tab === 'system', loadContext)
  const tools = usePanelData(open && tab === 'tools', loadTools)
  const commands = usePanelData(open && tab === 'mcp', loadCommands)
  const queriedMcp = useRef(false)
  useEffect(() => {
    if (!open || tab !== 'mcp') {
      queriedMcp.current = false
      return
    }
    if (
      queriedMcp.current ||
      commands.loading ||
      !commands.value?.commands.some(
        (command) => command.name === 'mcp' && command.source === 'extension'
      ) ||
      !nativeState.ready ||
      nativeState.commandPending ||
      nativeState.snapshot.requests.length > 0
    )
      return
    queriedMcp.current = true
    void nativeBiz.executeCommand(source, 'mcp', '')
  }, [
    open,
    tab,
    commands.loading,
    commands.value,
    nativeState.ready,
    nativeState.commandPending,
    nativeState.snapshot.requests.length,
    nativeBiz,
    source
  ])
  return { context, tools, commands }
}
