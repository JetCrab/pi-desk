'use client'

import {
  ArrowRightIcon,
  ArrowUpToLineIcon,
  CopyPlusIcon,
  CornerDownLeftIcon,
  EllipsisIcon,
  GitBranchIcon,
  FileTextIcon,
  LoaderCircleIcon,
  MessageSquarePlusIcon,
  PaperclipIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SendIcon,
  SquareIcon,
  Trash2Icon,
  XIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode
} from 'react'
import { L2ChatSourceSchema, type L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import type { L2PiModelOption } from '@common/l2_biz/pi-model/l2-pi-model-contract'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import type { L4PluginBrowserContributionDescriptor } from '@client/l4_foundation/plugin-host/l4-plugin-host-runtime'
import { useL4PluginRegistry } from '@client/l4_foundation/plugin-host/l4-plugin-host-context'
import { L4PluginIcon } from '@client/l4_foundation/plugin-host/l4-plugin-icon'
import {
  getL3WorkSessionSurfacePresentation,
  L3WorkSessionStatusBorder
} from '@client/l3_modules/work-session-visual/l3-work-session-visual-view'
import {
  PromptInputButton,
  PromptInputFooter,
  PromptInputTools
} from '@client/l4_foundation/ui/ai-elements/prompt-input'
import { L4ImageViewer, type L4ImageViewerSlide } from '@client/l4_foundation/ui/l4-image-viewer'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { useL4PowerSaving } from '@client/l4_foundation/ui/l4-power-saving'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@client/l4_foundation/ui/shadcn/dropdown-menu'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupTextarea
} from '@client/l4_foundation/ui/shadcn/input-group'
import type { L2WorkbenchBiz } from './l2-workbench-biz'
import type { L2WorkbenchChatRuntime } from './l2-workbench-chat'
import { L2GitBranchButton } from './git-workspace/l2-git-branch-button'
import type { L2GitWorkspaceRuntime } from './git-workspace/l2-git-workspace-runtime'
import type { L2GitBranchPickerTarget } from './git-workspace/l2-git-workspace-model'
import type {
  L2WorkbenchChatInputRuntime,
  L2WorkbenchChatInputState
} from './l2-workbench-chat-input-runtime'
import { useL2WorkbenchSlashCommand } from './hooks/l2-workbench-slash-command'
import { useL2WorkbenchComposerLayout } from './hooks/l2-workbench-composer-layout'
import { L2WorkbenchContextUsage } from './l2-workbench-context-usage'
import { L2WorkbenchModelContextDialog } from './l2-workbench-model-context-dialog'
import { L2WorkbenchModelPicker } from './views/l2-workbench-model-picker'
import { L2WorkbenchQueuePreview } from './l2-workbench-queue-preview'
import {
  getL2WorkbenchSlashCommandOptionId,
  L2_WORKBENCH_RELOAD_COMMAND,
  L2_WORKBENCH_SLASH_COMMAND_MENU_ID,
  type L2WorkbenchSlashCommandCandidate
} from './l2-workbench-slash-command'
import { L2WorkbenchSlashCommandMenu } from './l2-workbench-slash-command-menu'
import styles from './l2-workbench-chat-composer.module.css'
import type { L3CapabilityModeNames } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { L2WorkbenchCapabilityModePicker } from './l2-workbench-capability-mode-picker'
import { useL2NativeUi } from './native-ui/l2-native-ui'
import { L2NativeUiExtras, L2NativeUiQuestions } from './native-ui/l2-native-ui-view'

interface L2WorkbenchTaskSlotInput {
  source: L2ChatSource
  cwd: string
  pluginState: unknown
}

export interface L2WorkbenchComposerSlots {
  renderTaskSummary: (input: L2WorkbenchTaskSlotInput) => ReactNode
  renderTaskMenu: (input: L2WorkbenchTaskSlotInput) => ReactNode
  renderPluginComposerPanel: (input: {
    pluginName: string
    descriptor: Extract<L4PluginBrowserContributionDescriptor, { kind: 'composer-panel' }>
    source: L2ChatSource
    onClose: () => void
  }) => ReactNode
}

interface L2WorkbenchChatComposerProps extends L2WorkbenchComposerSlots {
  onOpenSettings?: (target?: 'model-presets') => void
  workSession: L2WorkSessionListItem
  chatRuntime: L2WorkbenchChatRuntime
  inputRuntime: L2WorkbenchChatInputRuntime
  gitRuntime: L2GitWorkspaceRuntime
  active: boolean
  mobile: boolean
  invokePluginMethod: L2WorkbenchBiz['invokePluginMethod']
  listPiCommands: L2WorkbenchBiz['listPiCommands']
  getChatModelContext: L2WorkbenchBiz['getChatModelContext']
  capabilityModes: L3CapabilityModeNames
  setChatCapabilityMode: L2WorkbenchBiz['setChatCapabilityMode']
  newSessionPending: boolean
  newSessionDisabled: boolean
  onNewSession: () => void
  clonePending: boolean
  cloneDisabled: boolean
  onCloneWorkSession: () => void
  onOpenBranchPicker: (workId: string) => void
  onOpenGitBranchPicker: (target: L2GitBranchPickerTarget) => void
}

const THINKING_LABELS: Record<L2PiModelOption['thinkingLevels'][number], string> = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax'
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function fileListFromClipboard(event: ClipboardEvent<HTMLTextAreaElement>): File[] {
  return [...(event.clipboardData?.items ?? [])].flatMap((item) => {
    if (item.kind !== 'file') return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

function L2WorkbenchChatComposerComponent({
  onOpenSettings,
  workSession,
  chatRuntime,
  inputRuntime,
  renderTaskSummary,
  renderTaskMenu,
  renderPluginComposerPanel,
  gitRuntime,
  active,
  mobile,
  invokePluginMethod,
  listPiCommands,
  getChatModelContext,
  capabilityModes,
  setChatCapabilityMode,
  newSessionPending,
  newSessionDisabled,
  onNewSession,
  clonePending,
  cloneDisabled,
  onCloneWorkSession,
  onOpenBranchPicker,
  onOpenGitBranchPicker
}: L2WorkbenchChatComposerProps): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const toast = useL4AppToast()
  const pluginDescriptors = useL4PluginRegistry()
  const powerSaving = useL4PowerSaving()
  const source = useMemo(
    () =>
      L2ChatSourceSchema.parse({
        workId: workSession.workId,
        sessionId: workSession.sessionId,
        branchId: workSession.branchId
      }),
    [workSession.branchId, workSession.sessionId, workSession.workId]
  )
  const getInputSnapshot = useCallback(() => inputRuntime.getState(source), [inputRuntime, source])
  const getChatRuntimeSnapshot = useCallback(
    () => chatRuntime.getSourceState(source).runtime,
    [chatRuntime, source]
  )
  const inputState = useSyncExternalStore(
    inputRuntime.subscribe,
    getInputSnapshot,
    getInputSnapshot
  )
  const chatRuntimeState = useSyncExternalStore(
    chatRuntime.subscribe,
    getChatRuntimeSnapshot,
    getChatRuntimeSnapshot
  )
  const getChatSyncSnapshot = useCallback(
    () => chatRuntime.getSourceState(source).syncStatus,
    [chatRuntime, source]
  )
  const syncStatus = useSyncExternalStore(
    chatRuntime.subscribe,
    getChatSyncSnapshot,
    getChatSyncSnapshot
  )
  const chatReady = syncStatus === 'ready'
  const nativeUi = useL2NativeUi(source, chatRuntime.nativeUi, inputRuntime, chatReady)
  const hasNativeQuestion = nativeUi.state.snapshot.requests.length > 0
  const basicChat = chatRuntimeState.extensionMode === 'basic'
  const basicPresentation = chatRuntimeState.presentationMode === 'basic'
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const footerRef = useRef<HTMLDivElement | null>(null)
  const submitToolsRef = useRef<HTMLDivElement | null>(null)
  const statusRef = useRef<HTMLSpanElement | null>(null)
  const desktopMetadataRow = useL2WorkbenchComposerLayout(
    mobile,
    footerRef,
    submitToolsRef,
    statusRef
  )
  const [localError, setLocalError] = useState<string | null>(null)
  const [activePluginPanel, setActivePluginPanel] = useState<{
    pluginName: string
    contributionName: string
    sourceKey: string
  } | null>(null)
  const closePluginPanel = useCallback((): void => {
    setActivePluginPanel(null)
  }, [])
  const [actionPending, setActionPending] = useState(false)
  const [modelContextSourceKey, setModelContextSourceKey] = useState<string | null>(null)
  const [contextIgnorePending, setContextIgnorePending] = useState(false)
  const [contextCompactPending, setContextCompactPending] = useState(false)
  const [reloadPending, setReloadPending] = useState(false)
  const [imagePreview, setImagePreview] = useState<{
    slides: L4ImageViewerSlide[]
    index: number
  } | null>(null)
  const [idleSendPreview, setIdleSendPreview] = useState<Pick<
    L2WorkbenchChatInputState,
    'text' | 'images'
  > | null>(null)

  const currentSourceKey = JSON.stringify([source.workId, source.sessionId, source.branchId])
  const pluginPanels = useMemo(
    () =>
      basicChat
        ? []
        : pluginDescriptors.flatMap((pluginModule) =>
            pluginModule.contributions.flatMap((descriptor) =>
              descriptor.kind === 'composer-panel'
                ? [{ pluginName: pluginModule.pluginName, descriptor }]
                : []
            )
          ),
    [pluginDescriptors, basicChat]
  )
  const activePluginPanelDescriptor = activePluginPanel
    ? pluginPanels.find(
        (panel) =>
          panel.pluginName === activePluginPanel.pluginName &&
          panel.descriptor.contributionName === activePluginPanel.contributionName
      )
    : undefined

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (!active) return
      setActivePluginPanel((current) =>
        current && current.sourceKey !== currentSourceKey ? null : current
      )
      setModelContextSourceKey(null)
    })
    return () => {
      active = false
    }
  }, [currentSourceKey])

  useEffect(() => {
    void inputRuntime.loadSource(source)
    void inputRuntime.loadModels(source)
  }, [inputRuntime, source])

  const mainRunning = workSession.status === 'main_running'
  const workSessionRunning = mainRunning || workSession.status === 'background_running'
  const completionPending = workSession.status === 'completed'
  const idleSending = idleSendPreview !== null
  const composerText = idleSendPreview?.text ?? inputState.text
  const composerImages = idleSendPreview?.images ?? inputState.images
  // Workbench 内置命令必须走控制动作，不能作为聊天消息交给模型。
  const isReloadCommand =
    composerImages.length === 0 && composerText.trim() === `/${L2_WORKBENCH_RELOAD_COMMAND.name}`
  const composerImageBytes = composerImages.reduce((total, image) => total + image.blob.size, 0)
  const openImagePreview = (localId: string): void => {
    const readyImages = composerImages.filter((image) => image.status === 'ready')
    const index = readyImages.findIndex((image) => image.localId === localId)
    if (index < 0) return

    setImagePreview({
      index,
      slides: readyImages.map((image) => ({
        src: image.objectUrl,
        alt: image.name,
        width: image.width,
        height: image.height
      }))
    })
  }
  const visibleOutbox =
    inputState.outbox && !(idleSending && inputState.outbox.status === 'sending')
      ? inputState.outbox
      : null
  const showRunningActions = mainRunning && !idleSending
  const queues = chatRuntimeState.queues
  const imageBytes = inputState.images.reduce((total, image) => total + image.blob.size, 0)
  const imageProcessing = inputState.images.some((image) => image.status === 'optimizing')
  const imageFailed = inputState.images.some((image) => image.status === 'error')
  const currentModel = chatRuntimeState.model
  const currentModelOption = currentModel
    ? inputState.models.models.find(
        (model) =>
          model.provider === currentModel.provider && model.modelId === currentModel.modelId
      )
    : null
  const imageModelUnsupported =
    inputState.images.length > 0 && !currentModelOption?.input.includes('image')
  const sendActionPending = actionPending && !contextCompactPending
  const canSend =
    chatReady &&
    !hasNativeQuestion &&
    inputState.loaded &&
    !inputState.outbox &&
    (inputState.text.trim().length > 0 || inputState.images.length > 0) &&
    inputState.images.length <= 10 &&
    !imageProcessing &&
    !imageFailed &&
    imageBytes <= 20 * 1024 * 1024 &&
    !imageModelUnsupported
  const taskCenterPluginState = chatRuntimeState.plugins['task-center']
  const contextUsage = chatRuntimeState.contextUsage
  const currentModelName = currentModelOption?.name || currentModel?.modelId || t('noModelSelected')
  const modelLabel = !chatReady
    ? t('synchronizing')
    : currentModel
      ? `${currentModelName} · ${t(THINKING_LABELS[currentModel.thinkingLevel])}`
      : t('selectModel')
  const modelTooltip = currentModel ? t('modelTooltip', { model: modelLabel }) : t('chooseModel')
  const displayedError = localError ?? inputState.error
  const visualState = workSessionRunning ? 'running' : completionPending ? 'completed' : 'idle'
  const surface = getL3WorkSessionSurfacePresentation(workSession.cwd)

  const runAction = useCallback(
    async (action: () => Promise<void>, successMessage?: string): Promise<void> => {
      setActionPending(true)
      setLocalError(null)
      try {
        await action()
        if (successMessage) toast.success(successMessage)
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : t('operationFailed'))
      } finally {
        setActionPending(false)
      }
    },
    [t, toast]
  )

  const changeCapabilityMode = useCallback(
    (capabilityMode: string | null): void => {
      setLocalError(null)
      void setChatCapabilityMode({ source, capabilityMode }).catch((cause: unknown) => {
        setLocalError(cause instanceof Error ? cause.message : t('modeChangeFailed'))
      })
    },
    [setChatCapabilityMode, source, t]
  )

  const ignoreContext = useCallback(async (): Promise<void> => {
    if (contextIgnorePending || chatRuntime.getSourceState(source).syncStatus !== 'ready') return
    setContextIgnorePending(true)
    try {
      await runAction(async () => {
        await invokePluginMethod({
          pluginName: 'context-ignore',
          method: 'ignore',
          scope: 'session',
          source,
          input: {}
        })
      })
    } finally {
      setContextIgnorePending(false)
    }
  }, [chatRuntime, contextIgnorePending, invokePluginMethod, runAction, source])

  const compactContext = useCallback(async (): Promise<void> => {
    if (contextCompactPending) return
    setContextCompactPending(true)
    try {
      await runAction(() => chatRuntime.compact(source))
    } finally {
      setContextCompactPending(false)
    }
  }, [chatRuntime, contextCompactPending, runAction, source])

  const selectSlashCommand = useCallback(
    (command: L2WorkbenchSlashCommandCandidate): void => {
      inputRuntime.setText(source, `/${command.name} `)
    },
    [inputRuntime, source]
  )
  const slashCommands = useL2WorkbenchSlashCommand({
    source,
    text: composerText,
    enabled: active && chatReady && inputState.loaded && !inputState.loading && !idleSending,
    listPiCommands,
    onSelect: selectSlashCommand
  })
  const refreshSlashCommands = slashCommands.refresh

  const reloadPi = useCallback(
    async (clearCommand: boolean): Promise<void> => {
      if (reloadPending || actionPending) return
      setReloadPending(true)
      try {
        await runAction(async () => {
          await chatRuntime.reload(source)
          await refreshSlashCommands()
          await inputRuntime.loadModels(source, true)
          if (clearCommand) inputRuntime.setText(source, '')
        })
      } finally {
        setReloadPending(false)
      }
    },
    [
      actionPending,
      chatRuntime,
      inputRuntime,
      refreshSlashCommands,
      reloadPending,
      runAction,
      source
    ]
  )

  const addFiles = useCallback(
    (files: readonly File[]): void => {
      if (idleSending || files.length === 0) return
      setLocalError(null)
      void inputRuntime.addFiles(source, files)
    },
    [idleSending, inputRuntime, source]
  )

  const send = useCallback(
    async (mode: 'auto' | 'follow_up'): Promise<void> => {
      if (chatRuntime.getSourceState(source).syncStatus !== 'ready') return
      if (isReloadCommand) {
        if (!inputState.loaded || inputState.loading) return
        await reloadPi(true)
        return
      }
      if (!canSend || sendActionPending) return

      const preview = mainRunning ? null : { text: inputState.text, images: inputState.images }
      if (preview) setIdleSendPreview(preview)
      setLocalError(null)
      try {
        await inputRuntime.send(source, mode)
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : t('sendFailed'))
      } finally {
        if (preview) setIdleSendPreview(null)
      }
    },
    [
      canSend,
      sendActionPending,
      chatRuntime,
      inputRuntime,
      inputState.images,
      inputState.loaded,
      inputState.loading,
      inputState.text,
      isReloadCommand,
      mainRunning,
      reloadPi,
      source,
      t
    ]
  )

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void send('auto')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashCommands.handleKeyDown(event)) return

    if (
      event.key !== 'Enter' ||
      event.shiftKey ||
      event.nativeEvent.isComposing ||
      event.currentTarget.form === null
    ) {
      return
    }
    event.preventDefault()
    event.currentTarget.form.requestSubmit()
  }

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = fileListFromClipboard(event)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const handleDrop = (event: DragEvent<HTMLFormElement>): void => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    addFiles([...event.dataTransfer.files])
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2 pb-2 sm:px-4 sm:pb-3">
      {visibleOutbox ? (
        <div
          className={cn(
            'mb-2 rounded-lg border px-3 py-2 text-xs',
            visibleOutbox.status === 'unknown'
              ? 'border-amber-500/50 bg-amber-500/10 text-amber-900 dark:text-amber-200'
              : visibleOutbox.status === 'failed'
                ? 'border-destructive/40 bg-destructive/5 text-destructive'
                : 'border-border bg-muted/50 text-muted-foreground'
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 flex-1">
              {visibleOutbox.status === 'sending'
                ? t('confirmingSend')
                : visibleOutbox.status === 'unknown'
                  ? t('sendUnknown')
                  : t('sendFailure', { error: visibleOutbox.error ?? t('unknownError') })}
            </span>
            {visibleOutbox.status === 'sending' ? null : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={actionPending}
                  onClick={() =>
                    void runAction(() => inputRuntime.restoreOutbox(source), t('outboxRestored'))
                  }
                >
                  <RotateCcwIcon />
                  {t('restoreDraft')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={actionPending}
                  onClick={() =>
                    void runAction(() => inputRuntime.deleteOutbox(source), t('outboxDeleted'))
                  }
                >
                  <Trash2Icon />
                  {t('delete')}
                </Button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {inputState.notice || displayedError ? (
        <div
          role={displayedError ? 'alert' : 'status'}
          className={cn(
            'mb-2 rounded-md px-2 py-1 text-sm',
            displayedError ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
          )}
        >
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">{displayedError ?? inputState.notice}</span>
            {!inputState.loaded && !inputState.loading && inputState.error ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={actionPending}
                onClick={() => void runAction(() => inputRuntime.loadSource(source))}
              >
                <RotateCcwIcon />
                {t('retryDraft')}
              </Button>
            ) : inputState.loaded ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setLocalError(null)
                  inputRuntime.dismissFeedback(source)
                }}
              >
                {t('close', { ns: 'common' })}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {renderTaskSummary({ source, cwd: workSession.cwd, pluginState: taskCenterPluginState })}

      <L2NativeUiQuestions model={nativeUi} />
      <L2NativeUiExtras snapshot={nativeUi.state.snapshot} placement="aboveEditor" />
      {hasNativeQuestion ? (
        <p className="mb-1 px-1 text-xs text-muted-foreground">{t('nativeUiComposer')}</p>
      ) : null}

      <form
        aria-label={
          workSessionRunning
            ? t('composerRunning')
            : completionPending
              ? t('composerCompleted')
              : t('composer')
        }
        className={cn(styles.inputFrame, surface.className)}
        data-composer-mobile={mobile ? 'true' : 'false'}
        data-composer-metadata-row={desktopMetadataRow ? 'true' : 'false'}
        style={surface.style}
        onSubmit={handleSubmit}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDrop={handleDrop}
      >
        <L2WorkbenchSlashCommandMenu
          open={slashCommands.open}
          loading={slashCommands.loading}
          error={slashCommands.error}
          groups={slashCommands.groups}
          activeIndex={slashCommands.activeIndex}
          onActiveIndexChange={slashCommands.setActiveIndex}
          onSelect={slashCommands.select}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif,image/bmp"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.currentTarget.files) addFiles([...event.currentTarget.files])
            event.currentTarget.value = ''
          }}
        />
        {/* 巡边与内容裁切分层，避免描线被裁细；禁用工具只弱化自身，不连带输入区。 */}
        <div className="relative rounded-xl">
          <InputGroup
            className="relative z-[1] overflow-hidden rounded-xl border-border bg-card shadow-xs transition-[background-color,border-color] duration-150 ease-out has-disabled:bg-card has-disabled:opacity-100 dark:shadow-none motion-reduce:transition-none"
            aria-busy={idleSending}
          >
            {composerImages.length > 0 ? (
              <InputGroupAddon
                align="block-start"
                className="pi-desk-chat-scrollbar gap-2 overflow-x-auto px-3 pt-3 pb-1"
              >
                {composerImages.map((image) => (
                  <div
                    key={image.localId}
                    className="relative size-16 shrink-0 overflow-hidden rounded-md border bg-muted"
                    title={`${image.name} · ${image.width}×${image.height} · ${formatBytes(image.blob.size)}`}
                  >
                    <button
                      type="button"
                      disabled={image.status !== 'ready'}
                      aria-label={t('imagePreview', { name: image.name })}
                      className="group size-full cursor-zoom-in outline-none disabled:cursor-default focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      onClick={() => openImagePreview(image.localId)}
                    >
                      {/* Blob 已在浏览器压缩，且 URL 会随 Draft 生命周期主动释放。 */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={image.objectUrl}
                        alt={image.name}
                        className="size-full object-cover transition-transform duration-200 group-hover:scale-105 motion-reduce:transition-none"
                      />
                    </button>
                    {image.status === 'optimizing' ? (
                      <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/85 text-xs">
                        {t('imageProcessing')}
                      </div>
                    ) : null}
                    {image.status === 'error' ? (
                      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-popover px-1 py-0.5 text-xs text-destructive">
                        {t('imageFailed')}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      aria-label={t('imageRemove', { name: image.name })}
                      aria-disabled={idleSending}
                      className="absolute right-0.5 top-0.5 z-10 grid size-6 cursor-pointer place-items-center rounded-md bg-popover text-popover-foreground shadow-sm hover:bg-accent"
                      onClick={() => {
                        if (!idleSending) inputRuntime.removeImage(source, image.localId)
                      }}
                    >
                      <XIcon className="size-3" />
                    </button>
                  </div>
                ))}
                <span className="self-end whitespace-nowrap text-xs text-muted-foreground">
                  {composerImages.length}/10 · {formatBytes(composerImageBytes)}
                </span>
              </InputGroupAddon>
            ) : null}

            <InputGroupTextarea
              value={composerText}
              disabled={!inputState.loaded || inputState.loading}
              readOnly={idleSending}
              aria-disabled={idleSending}
              aria-autocomplete="list"
              aria-controls={slashCommands.open ? L2_WORKBENCH_SLASH_COMMAND_MENU_ID : undefined}
              aria-expanded={slashCommands.open}
              aria-activedescendant={
                slashCommands.open && slashCommands.commands.length > 0
                  ? getL2WorkbenchSlashCommandOptionId(slashCommands.activeIndex)
                  : undefined
              }
              placeholder={
                inputState.loading
                  ? t('draftLoading')
                  : !inputState.loaded && inputState.error
                    ? t('draftFailed')
                    : t('inputPlaceholder')
              }
              className={cn(
                styles.inputText,
                'pi-desk-chat-scrollbar max-h-48 min-h-9 overflow-y-auto px-3 pt-3 pb-1'
              )}
              onChange={(event) => inputRuntime.setText(source, event.currentTarget.value)}
              onClick={slashCommands.reopen}
              onBlur={slashCommands.dismiss}
              onCompositionStart={slashCommands.handleCompositionStart}
              onCompositionEnd={slashCommands.handleCompositionEnd}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />

            <PromptInputFooter ref={footerRef} className={styles.footer}>
              <PromptInputTools data-composer-tools="primary" className={styles.primaryTools}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={<PromptInputButton tooltip={t('more')} aria-label={t('moreActions')} />}
                  >
                    <EllipsisIcon className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" side="top" className="w-52">
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('session')}</DropdownMenuLabel>
                      <DropdownMenuItem
                        aria-label={t('switchBranch')}
                        disabled={!chatReady || !inputState.loaded || inputState.loading}
                        onClick={() => onOpenBranchPicker(workSession.workId)}
                      >
                        <GitBranchIcon className="size-4" />
                        {t('sessionBranch')}
                        <span className="ml-auto text-xs text-muted-foreground">
                          {t('escapeTwice')}
                        </span>
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={t('clone')}
                        disabled={!chatReady || cloneDisabled || clonePending}
                        title={
                          workSession.messageCounts.total === 0 ? t('cloneEmpty') : t('cloneTip')
                        }
                        onClick={onCloneWorkSession}
                      >
                        {clonePending ? (
                          <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                          <CopyPlusIcon className="size-4" />
                        )}
                        {clonePending ? t('cloning') : t('clone')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={t('replaceSession')}
                        aria-busy={newSessionPending}
                        disabled={!chatReady || newSessionDisabled || newSessionPending}
                        onClick={onNewSession}
                      >
                        {newSessionPending ? (
                          <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                          <MessageSquarePlusIcon className="size-4" />
                        )}
                        {newSessionPending ? t('replacing') : t('replaceSession')}
                      </DropdownMenuItem>
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuLabel>{t('tools')}</DropdownMenuLabel>
                      {renderTaskMenu({
                        source,
                        cwd: workSession.cwd,
                        pluginState: taskCenterPluginState
                      })}
                      <DropdownMenuItem
                        aria-label={t('toolsAndContext', { defaultValue: '工具与上下文' })}
                        disabled={!chatReady || hasNativeQuestion}
                        onClick={() => setModelContextSourceKey(currentSourceKey)}
                      >
                        <FileTextIcon className="size-4" />
                        {t('toolsAndContext', { defaultValue: '工具与上下文' })}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={t('reloadPi')}
                        disabled={
                          !inputState.loaded ||
                          inputState.loading ||
                          !chatReady ||
                          workSessionRunning ||
                          actionPending ||
                          reloadPending
                        }
                        title={t('reloadPiTip')}
                        onClick={() => void reloadPi(false)}
                      >
                        {reloadPending ? (
                          <LoaderCircleIcon className="size-4 animate-spin" />
                        ) : (
                          <RefreshCwIcon className="size-4" />
                        )}
                        {reloadPending ? t('reloadingPi') : t('reloadPi')}
                      </DropdownMenuItem>
                      {basicPresentation && !basicChat ? (
                        <DropdownMenuItem
                          disabled={!chatReady || actionPending || reloadPending}
                          onClick={() =>
                            void runAction(() => chatRuntime.setPresentation(source, 'normal'))
                          }
                        >
                          <FileTextIcon className="size-4" />
                          {t('restorePluginPresentation')}
                        </DropdownMenuItem>
                      ) : null}
                    </DropdownMenuGroup>
                    {pluginPanels.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>{t('plugins')}</DropdownMenuLabel>
                          {pluginPanels.map((panel) => (
                            <DropdownMenuItem
                              key={`${panel.pluginName}:${panel.descriptor.contributionName}`}
                              onClick={() =>
                                setActivePluginPanel({
                                  pluginName: panel.pluginName,
                                  contributionName: panel.descriptor.contributionName,
                                  sourceKey: currentSourceKey
                                })
                              }
                            >
                              <L4PluginIcon icon={panel.descriptor.icon} className="size-4" />
                              <span className="truncate">{panel.descriptor.label}</span>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuGroup>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>

                <PromptInputButton
                  tooltip={t('addImage')}
                  aria-label={t('addImage')}
                  disabled={inputState.images.length >= 10}
                  aria-disabled={idleSending || inputState.images.length >= 10}
                  onClick={() => {
                    if (!idleSending) fileInputRef.current?.click()
                  }}
                >
                  <PaperclipIcon className="size-4" />
                </PromptInputButton>

                {contextUsage && currentModelOption?.contextWindow !== null ? (
                  <L2WorkbenchContextUsage
                    sessionId={workSession.sessionId}
                    cwd={workSession.cwd}
                    tokens={contextUsage.tokens}
                    contextWindow={contextUsage.contextWindow}
                    contextIgnorePlugin={chatRuntimeState.plugins['context-ignore']}
                    ignoreDisabled={!chatReady || mainRunning || actionPending}
                    ignorePending={contextIgnorePending}
                    compactDisabled={!chatReady || mainRunning || actionPending}
                    compactPending={contextCompactPending}
                    onIgnoreContext={ignoreContext}
                    onCompactContext={compactContext}
                  />
                ) : currentModelOption?.contextWindow === null ? (
                  <span className="px-1 text-xs text-muted-foreground">
                    {t('modelContextUnknown', { defaultValue: '上下文未知' })}
                  </span>
                ) : null}
              </PromptInputTools>

              <PromptInputTools data-composer-tools="metadata" className={styles.metadataTools}>
                <L2GitBranchButton
                  workSession={workSession}
                  runtime={gitRuntime}
                  active={active}
                  chatReady={chatReady}
                  onOpen={onOpenGitBranchPicker}
                />

                <L2WorkbenchCapabilityModePicker
                  modes={capabilityModes}
                  value={chatRuntimeState.capabilityMode}
                  disabled={!chatReady}
                  onChange={changeCapabilityMode}
                />

                <L2WorkbenchModelPicker
                  key={currentSourceKey}
                  source={source}
                  runtime={inputRuntime}
                  catalog={inputState.models}
                  current={currentModel}
                  label={modelLabel}
                  title={modelTooltip}
                  disabled={!chatReady || workSessionRunning || idleSending || actionPending}
                  triggerClassName={styles.modelTrigger}
                  detailsClassName={styles.modelTriggerDetails}
                  onOpenSettings={onOpenSettings}
                />
              </PromptInputTools>

              {mainRunning && idleSending ? (
                <span
                  ref={statusRef}
                  className="min-w-0 truncate px-2 text-xs text-muted-foreground"
                >
                  {t('preparingContext')}
                </span>
              ) : null}

              <div ref={submitToolsRef} className={styles.submitTools}>
                <L2WorkbenchQueuePreview
                  queues={queues}
                  disabled={!chatReady || actionPending}
                  onRestore={() =>
                    void runAction(() => inputRuntime.restoreQueue(source), t('queuesRestored'))
                  }
                />

                {showRunningActions ? (
                  <>
                    <PromptInputButton
                      tooltip={t('steerNow')}
                      aria-label={t('steerNow')}
                      variant="secondary"
                      disabled={!canSend || sendActionPending}
                      onClick={() => void send('auto')}
                    >
                      <ArrowRightIcon className="size-3.5" />
                    </PromptInputButton>
                    <PromptInputButton
                      tooltip={t('sendFollowUp')}
                      aria-label={t('sendFollowUp')}
                      variant="outline"
                      disabled={!canSend || sendActionPending}
                      onClick={() => void send('follow_up')}
                    >
                      <ArrowUpToLineIcon className="size-3.5" />
                    </PromptInputButton>
                    <PromptInputButton
                      tooltip={t('stopResponse')}
                      aria-label={t('stopResponse')}
                      variant="destructive"
                      disabled={!chatReady || actionPending}
                      onClick={() => void runAction(() => inputRuntime.interrupt(source))}
                    >
                      <SquareIcon className="size-3.5 fill-current" />
                    </PromptInputButton>
                  </>
                ) : (
                  <Button
                    type={idleSending ? 'button' : 'submit'}
                    size="icon"
                    disabled={!idleSending && (!canSend || sendActionPending)}
                    aria-disabled={idleSending || !canSend || sendActionPending}
                    aria-busy={idleSending}
                    aria-label={
                      idleSending ? t('sending') : chatReady ? t('send') : t('synchronizing')
                    }
                  >
                    {idleSending ? (
                      <SendIcon
                        className={cn('size-4', !powerSaving && 'pi-desk-chat-send-icon')}
                      />
                    ) : !chatReady ? (
                      <LoaderCircleIcon className="size-4 animate-spin" />
                    ) : (
                      <CornerDownLeftIcon />
                    )}
                  </Button>
                )}
              </div>
            </PromptInputFooter>
          </InputGroup>
          <L3WorkSessionStatusBorder state={visualState} powerSaving={powerSaving} />
        </div>
      </form>
      <L2NativeUiExtras snapshot={nativeUi.state.snapshot} placement="belowEditor" />

      {activePluginPanel &&
      activePluginPanel.sourceKey === currentSourceKey &&
      activePluginPanelDescriptor
        ? renderPluginComposerPanel({
            pluginName: activePluginPanel.pluginName,
            descriptor: activePluginPanelDescriptor.descriptor,
            source,
            onClose: closePluginPanel
          })
        : null}

      {modelContextSourceKey === currentSourceKey && chatReady ? (
        <L2WorkbenchModelContextDialog
          key={currentSourceKey}
          open
          source={source}
          runtime={inputRuntime}
          getContext={getChatModelContext}
          listCommands={listPiCommands}
          nativeUi={nativeUi}
          nativeBiz={chatRuntime.nativeUi}
          commandsDisabled={workSessionRunning || idleSending || actionPending}
          onOpenChange={(open) => setModelContextSourceKey(open ? currentSourceKey : null)}
          onOpenSettings={onOpenSettings}
        />
      ) : null}

      {imagePreview ? (
        <L4ImageViewer
          mode="modal"
          open
          slides={imagePreview.slides}
          index={imagePreview.index}
          ariaLabel={t('imagePreviewPending')}
          onClose={() => setImagePreview(null)}
          onIndexChange={(index) =>
            setImagePreview((current) => (current ? { ...current, index } : current))
          }
        />
      ) : null}

      {inputState.images.length > 10 ? (
        <p className="mt-1 px-1 text-sm text-destructive">{t('tooManyImages')}</p>
      ) : imageModelUnsupported ? (
        <p className="mt-1 px-1 text-sm text-destructive">{t('imageUnsupported')}</p>
      ) : imageBytes > 20 * 1024 * 1024 ? (
        <p className="mt-1 px-1 text-sm text-destructive">{t('imagesTooLarge')}</p>
      ) : null}
    </div>
  )
}

export const L2WorkbenchChatComposer = memo(L2WorkbenchChatComposerComponent)

L2WorkbenchChatComposer.displayName = 'L2WorkbenchChatComposer'
