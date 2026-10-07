'use client'

import type { L2ChatSource, L2ChatSourceState } from '@common/l2_biz/chat/l2-chat-contract'
import type { L2ChatSourceEventPush } from '@common/l2_biz/chat/l2-chat-websocket-contract'
import type { L3PiNativeToolsListResponse } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import type { L2PiModelOption, L2PiModelPreset } from '@common/l2_biz/pi-model/l2-pi-model-contract'
import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import { l2WorkbenchText as workbenchText } from './l2-workbench-text'
import type { L2WorkbenchBiz } from './l2-workbench-biz'
import type { L2WorkbenchChatRuntime } from './l2-workbench-chat'
import {
  createL2WorkbenchChatInputRepository,
  type L2WorkbenchChatInputRepository,
  type L2WorkbenchStoredImage,
  type L2WorkbenchStoredInput
} from './l2-workbench-chat-input-repository'
import {
  createL2WorkbenchImageAttachment,
  fromL2ChatImageResponse,
  inspectL2WorkbenchImage,
  optimizeL2WorkbenchImage,
  revokeL2WorkbenchImageAttachment,
  toL2ChatInputImage,
  type L2WorkbenchImageAttachment
} from './l2-workbench-chat-image'

const MAX_IMAGE_COUNT = 10
const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_APPLICATION_JSON_BYTES = 31 * 1024 * 1024
const MAX_CACHED_MESSAGE_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_CACHED_MESSAGE_IMAGES = 64

export interface L2WorkbenchOutboxState {
  status: 'sending' | 'failed' | 'unknown'
  text: string
  images: L2WorkbenchImageAttachment[]
  error: string | null
}

export interface L2WorkbenchModelCatalogState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  models: L2PiModelOption[]
  presets: L2PiModelPreset[]
  error: string | null
}

export interface L2WorkbenchChatInputState {
  loaded: boolean
  loading: boolean
  text: string
  images: L2WorkbenchImageAttachment[]
  outbox: L2WorkbenchOutboxState | null
  notice: string | null
  error: string | null
  models: L2WorkbenchModelCatalogState
}

export interface L2WorkbenchAcquiredImage {
  url: string
  release: () => void
}

export interface L2WorkbenchChatInputRuntime {
  subscribe: (listener: () => void) => () => void
  getState: (source: L2ChatSource) => L2WorkbenchChatInputState
  loadSource: (source: L2ChatSource) => Promise<void>
  setText: (source: L2ChatSource, text: string) => void
  dismissFeedback: (source: L2ChatSource) => void
  addFiles: (source: L2ChatSource, files: readonly File[]) => Promise<void>
  removeImage: (source: L2ChatSource, localId: string) => void
  send: (source: L2ChatSource, mode: 'auto' | 'follow_up') => Promise<void>
  restoreOutbox: (source: L2ChatSource) => Promise<void>
  deleteOutbox: (source: L2ChatSource) => Promise<void>
  interrupt: (source: L2ChatSource) => Promise<void>
  restoreQueue: (source: L2ChatSource) => Promise<void>
  listTools: (source: L2ChatSource) => Promise<L3PiNativeToolsListResponse>
  loadModels: (source: L2ChatSource, forceRefresh?: boolean) => Promise<void>
  setModel: (
    source: L2ChatSource,
    model: {
      provider: string
      modelId: string
      thinkingLevel: L2PiModelOption['thinkingLevels'][number]
    }
  ) => Promise<void>
  acquireMessageImage: (input: {
    source: L2ChatSource
    tempId: string | null
    entryId: string | null
    imageIndex: number
  }) => L2WorkbenchAcquiredImage | Promise<L2WorkbenchAcquiredImage>
  reconcileWorkSessions: (workSessions: readonly L2WorkSessionListItem[]) => void
  prepareForPageReload: () => Promise<boolean>
  dispose: () => void
}

interface CachedMessageImage {
  url: string
  size: number
  references: number
}

function sourceKey(source: L2ChatSource): string {
  return JSON.stringify([source.workId, source.sessionId, source.branchId])
}

function emptyState(): L2WorkbenchChatInputState {
  return {
    loaded: false,
    loading: false,
    text: '',
    images: [],
    outbox: null,
    notice: null,
    error: null,
    models: { status: 'idle', models: [], presets: [], error: null }
  }
}

function storedImages(images: readonly L2WorkbenchImageAttachment[]): L2WorkbenchStoredImage[] {
  return images.map(({ blob, mimeType, width, height, optimized }) => ({
    blob,
    mimeType,
    width,
    height,
    optimized
  }))
}

function storedInput(
  state: Pick<L2WorkbenchChatInputState, 'text' | 'images'>
): L2WorkbenchStoredInput {
  return { text: state.text, images: storedImages(state.images) }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

function uncertainSendError(cause: unknown): boolean {
  const raw = cause instanceof Error && 'rawMessage' in cause ? cause.rawMessage : null
  const message = typeof raw === 'string' ? raw : errorMessage(cause, '')
  return /WebSocket.*(?:断开|连接|替换)|请求超时|尚未连接/.test(message)
}

function inputText(left: string, right: string): string {
  return [left, right].filter((value) => value.trim()).join('\n\n')
}

function tempImageKey(source: L2ChatSource, tempId: string, imageIndex: number): string {
  return `${sourceKey(source)}\u0000temp\u0000${tempId}\u0000${imageIndex}`
}

function durableImageKey(source: L2ChatSource, entryId: string, imageIndex: number): string {
  return `${sourceKey(source)}\u0000entry\u0000${entryId}\u0000${imageIndex}`
}

function releaseAttachments(images: readonly L2WorkbenchImageAttachment[]): void {
  for (const image of images) revokeL2WorkbenchImageAttachment(image)
}

export function createL2WorkbenchChatInputRuntime(
  biz: L2WorkbenchBiz,
  chatRuntime: L2WorkbenchChatRuntime,
  repository: L2WorkbenchChatInputRepository = createL2WorkbenchChatInputRepository()
): L2WorkbenchChatInputRuntime {
  const statesBySource = new Map<string, L2WorkbenchChatInputState>()
  const sourcesByKey = new Map<string, L2ChatSource>()
  const listeners = new Set<() => void>()
  const persistenceTails = new Map<string, Promise<void>>()
  const persistenceFailures = new Set<string>()
  let draftWriteRevision = 0
  const loadPromises = new Map<string, Promise<void>>()
  const optimizeQueue: Array<() => Promise<void>> = []
  const messageImages = new Map<string, CachedMessageImage>()
  const imageLoads = new Map<string, Promise<CachedMessageImage>>()
  let activeOptimizations = 0
  let disposed = false

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[Pi Desk][WorkbenchChatInput] 状态监听器执行失败', {
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
      }
    }
  }

  const requireSynchronizedSource = (source: L2ChatSource): void => {
    if (chatRuntime.getSourceState(source).syncStatus !== 'ready') {
      throw new Error(workbenchText('sourceSyncing'))
    }
  }

  const ensureState = (source: L2ChatSource): L2WorkbenchChatInputState => {
    const key = sourceKey(source)
    sourcesByKey.set(key, source)
    let state = statesBySource.get(key)
    if (!state) {
      state = emptyState()
      statesBySource.set(key, state)
    }
    return state
  }

  const replaceState = (
    source: L2ChatSource,
    update: (current: L2WorkbenchChatInputState) => L2WorkbenchChatInputState
  ): L2WorkbenchChatInputState => {
    const next = update(ensureState(source))
    statesBySource.set(sourceKey(source), next)
    notify()
    return next
  }

  const enqueueDraftWrite = (source: L2ChatSource, input: L2WorkbenchStoredInput): void => {
    const key = sourceKey(source)
    draftWriteRevision += 1
    const previous = persistenceTails.get(key) ?? Promise.resolve()
    const next = previous
      .then(() => repository.writeDraft(source, input))
      .then(() => {
        persistenceFailures.delete(key)
      })
      .catch((error: unknown) => {
        persistenceFailures.add(key)
        console.error('[Pi Desk][WorkbenchChatInput] Draft 写入失败', {
          workId: source.workId,
          errorName: error instanceof Error ? error.name : 'UnknownError'
        })
        if (sourcesByKey.has(key)) {
          replaceState(source, (current) => ({
            ...current,
            error: workbenchText('draftSaveFailed')
          }))
        }
      })
      .finally(() => {
        if (persistenceTails.get(key) === next) persistenceTails.delete(key)
      })
    persistenceTails.set(key, next)
  }

  const persistCurrentDraft = (source: L2ChatSource): void => {
    enqueueDraftWrite(source, storedInput(ensureState(source)))
  }

  const pumpOptimizations = (): void => {
    while (!disposed && activeOptimizations < 2 && optimizeQueue.length > 0) {
      const job = optimizeQueue.shift()!
      activeOptimizations += 1
      void job().finally(() => {
        activeOptimizations -= 1
        pumpOptimizations()
      })
    }
  }

  const enqueueOptimization = (source: L2ChatSource, localId: string): void => {
    optimizeQueue.push(async () => {
      const state = statesBySource.get(sourceKey(source))
      const attachment = state?.images.find((image) => image.localId === localId)
      if (!attachment || attachment.status !== 'optimizing') return

      try {
        const optimized = await optimizeL2WorkbenchImage(attachment)
        const latest = statesBySource.get(sourceKey(source))
        const index = latest?.images.findIndex((image) => image.localId === localId) ?? -1
        if (!latest || index < 0) return

        const objectUrl = URL.createObjectURL(optimized.blob)
        URL.revokeObjectURL(latest.images[index]!.objectUrl)
        const images = [...latest.images]
        images[index] = {
          ...images[index]!,
          ...optimized,
          objectUrl,
          status: 'ready',
          error: null
        }
        statesBySource.set(sourceKey(source), { ...latest, images, error: null })
        persistCurrentDraft(source)
        notify()
      } catch (cause) {
        const latest = statesBySource.get(sourceKey(source))
        const index = latest?.images.findIndex((image) => image.localId === localId) ?? -1
        if (!latest || index < 0) return
        const images = [...latest.images]
        images[index] = {
          ...images[index]!,
          status: 'error',
          error: errorMessage(cause, workbenchText('imageProcessFailed'))
        }
        statesBySource.set(sourceKey(source), { ...latest, images })
        persistCurrentDraft(source)
        notify()
      }
    })
    pumpOptimizations()
  }

  const hydrateImages = (
    images: readonly L2WorkbenchStoredImage[],
    namePrefix: string
  ): L2WorkbenchImageAttachment[] =>
    images.map((image, index) =>
      createL2WorkbenchImageAttachment(image, `${namePrefix} ${index + 1}`)
    )

  const trimMessageImages = (): void => {
    let bytes = [...messageImages.values()].reduce((total, image) => total + image.size, 0)
    for (const [key, image] of messageImages) {
      if (
        bytes <= MAX_CACHED_MESSAGE_IMAGE_BYTES &&
        messageImages.size <= MAX_CACHED_MESSAGE_IMAGES
      ) {
        break
      }
      if (image.references > 0) continue
      URL.revokeObjectURL(image.url)
      messageImages.delete(key)
      bytes -= image.size
    }
  }

  const releaseSourceMemory = (source: L2ChatSource): void => {
    const key = sourceKey(source)
    const state = statesBySource.get(key)
    if (state) {
      releaseAttachments(state.images)
      if (state.outbox) releaseAttachments(state.outbox.images)
    }
    statesBySource.delete(key)
    sourcesByKey.delete(key)
    persistenceTails.delete(key)
    persistenceFailures.delete(key)
    loadPromises.delete(key)
    for (const imageKey of imageLoads.keys()) {
      if (imageKey.startsWith(`${key}\u0000`)) imageLoads.delete(imageKey)
    }
    for (const [imageKey, image] of [...messageImages]) {
      if (!imageKey.startsWith(`${key}\u0000`)) continue
      URL.revokeObjectURL(image.url)
      messageImages.delete(imageKey)
    }
  }

  const handleSourceEvent = (push: L2ChatSourceEventPush, state: L2ChatSourceState): void => {
    const { source, event } = push
    if (event.type === 'message_commit') {
      const prefix = `${sourceKey(source)}\u0000temp\u0000${event.location.tempId}\u0000`
      for (const [key, image] of [...messageImages]) {
        if (!key.startsWith(prefix)) continue
        const imageIndex = Number.parseInt(key.slice(prefix.length), 10)
        messageImages.delete(key)
        messageImages.set(durableImageKey(source, event.durable.entryId, imageIndex), image)
      }
      notify()
      return
    }
    if (event.type === 'message_discard') {
      const prefix = `${sourceKey(source)}\u0000temp\u0000${event.location.tempId}\u0000`
      for (const [key, image] of [...messageImages]) {
        if (!key.startsWith(prefix)) continue
        URL.revokeObjectURL(image.url)
        messageImages.delete(key)
      }
      notify()
      return
    }

    if (event.type === 'session_sync' || event.type === 'runtime_update') {
      const validTempIds = new Set([
        ...state.temporaryMessages.map((message) => message.location.tempId),
        ...state.runtime.queues.steering.map((input) => input.tempId),
        ...state.runtime.queues.followUp.map((input) => input.tempId)
      ])
      const prefix = `${sourceKey(source)}\u0000temp\u0000`
      for (const [key, image] of [...messageImages]) {
        if (!key.startsWith(prefix)) continue
        const tempId = key.slice(prefix.length).split('\u0000')[0]
        if (tempId && validTempIds.has(tempId)) continue
        URL.revokeObjectURL(image.url)
        messageImages.delete(key)
      }
    }
  }

  const unsubscribeSourceEvents = chatRuntime.subscribeSourceEvents(handleSourceEvent)

  const runtime: L2WorkbenchChatInputRuntime = {
    subscribe(listener): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getState(source): L2WorkbenchChatInputState {
      return ensureState(source)
    },

    async loadSource(source): Promise<void> {
      const key = sourceKey(source)
      const current = ensureState(source)
      if (current.loaded) return
      const existing = loadPromises.get(key)
      if (existing) return existing

      const load = (async () => {
        replaceState(source, (state) => ({ ...state, loading: true, error: null }))
        try {
          const recovered = await repository.recoverOutbox(source)
          if (disposed || !sourcesByKey.has(key)) return
          const images = hydrateImages(recovered.input.images, workbenchText('draftImage'))
          statesBySource.set(key, {
            ...ensureState(source),
            loaded: true,
            loading: false,
            text: recovered.input.text,
            images,
            notice: recovered.recovered ? workbenchText('uncertainRecovered') : null,
            error: null
          })
          for (const image of images) {
            if (!image.optimized) enqueueOptimization(source, image.localId)
          }
          notify()
        } catch (cause) {
          replaceState(source, (state) => ({
            ...state,
            loaded: false,
            loading: false,
            error: errorMessage(cause, workbenchText('draftLoadFailed'))
          }))
        }
      })().finally(() => loadPromises.delete(key))
      loadPromises.set(key, load)
      return load
    },

    dismissFeedback(source): void {
      replaceState(source, (state) => ({ ...state, notice: null, error: null }))
    },

    setText(source, text): void {
      const next = replaceState(source, (state) => ({ ...state, text, notice: null, error: null }))
      enqueueDraftWrite(source, storedInput(next))
    },

    async addFiles(source, files): Promise<void> {
      const current = ensureState(source)
      const available = MAX_IMAGE_COUNT - current.images.length
      if (available <= 0) {
        replaceState(source, (state) => ({ ...state, error: workbenchText('imageAddLimit') }))
        return
      }
      const selected = [...files].slice(0, available)
      const inspected: L2WorkbenchImageAttachment[] = []
      for (const file of selected) {
        try {
          const image = await inspectL2WorkbenchImage(file)
          inspected.push(createL2WorkbenchImageAttachment(image, file.name))
        } catch (cause) {
          replaceState(source, (state) => ({
            ...state,
            error: workbenchText('imageFileFailed', {
              name: file.name,
              error: errorMessage(cause, workbenchText('imageUnavailable'))
            })
          }))
        }
      }
      if (inspected.length === 0) return

      const next = replaceState(source, (state) => ({
        ...state,
        images: [...state.images, ...inspected],
        notice: null,
        error: files.length > available ? workbenchText('imageAddOverflow') : null
      }))
      enqueueDraftWrite(source, storedInput(next))
      for (const image of inspected) {
        if (!image.optimized) enqueueOptimization(source, image.localId)
      }
    },

    removeImage(source, localId): void {
      const current = ensureState(source)
      const image = current.images.find((candidate) => candidate.localId === localId)
      if (!image) return
      revokeL2WorkbenchImageAttachment(image)
      const next = replaceState(source, (state) => ({
        ...state,
        images: state.images.filter((candidate) => candidate.localId !== localId),
        error: null
      }))
      enqueueDraftWrite(source, storedInput(next))
    },

    async send(source, mode): Promise<void> {
      requireSynchronizedSource(source)
      const key = sourceKey(source)
      const current = ensureState(source)
      if (current.outbox) throw new Error(workbenchText('resolveOutboxFirst'))
      if (!current.text.trim() && current.images.length === 0)
        throw new Error(workbenchText('emptyInput'))
      if (current.images.length > MAX_IMAGE_COUNT) {
        throw new Error(workbenchText('imageSendLimit'))
      }
      if (current.images.some((image) => image.status === 'optimizing')) {
        throw new Error(workbenchText('imagesPending'))
      }
      const failedImage = current.images.find((image) => image.status === 'error')
      if (failedImage) throw new Error(failedImage.error ?? workbenchText('imageProcessingFailed'))
      if (
        current.images.reduce((total, image) => total + image.blob.size, 0) > MAX_TOTAL_IMAGE_BYTES
      ) {
        throw new Error(workbenchText('imageBytesLimit'))
      }

      await (persistenceTails.get(key) ?? Promise.resolve())
      // 等待草稿落盘期间也可能断线，已知未同步时不把草稿移入 Outbox。
      requireSynchronizedSource(source)
      const input = storedInput(current)
      await repository.moveDraftToOutbox(source, input)
      statesBySource.set(key, {
        ...current,
        text: '',
        images: [],
        outbox: {
          status: 'sending',
          text: current.text,
          images: current.images,
          error: null
        },
        notice: null,
        error: null
      })
      notify()

      try {
        const images = await Promise.all(current.images.map(toL2ChatInputImage))
        const request = { source, mode, text: current.text, images }
        const requestBytes = new TextEncoder().encode(
          JSON.stringify({
            head: {
              op: 'req',
              path: 'chat/send',
              requestId: '00000000-0000-4000-8000-000000000000'
            },
            body: request
          })
        ).byteLength
        if (requestBytes > MAX_APPLICATION_JSON_BYTES) {
          throw new Error(workbenchText('messageBytesLimit'))
        }
        const response = await biz.sendChat(request)
        if (disposed || statesBySource.get(key)?.outbox?.images !== current.images) return
        // 后续消息推送可紧随发送确认到达，必须在等待本地存储前接好图片缓存。
        // 消息与 Outbox 分别持有地址，清理或丢弃任一方都不撤销另一方的图片。
        current.images.forEach((image, imageIndex) => {
          messageImages.set(tempImageKey(source, response.tempId, imageIndex), {
            url: URL.createObjectURL(image.blob),
            size: image.blob.size,
            references: 0
          })
        })
        trimMessageImages()
        await repository.clearOutbox(source)
        const latest = statesBySource.get(key)
        if (latest?.outbox?.images === current.images) {
          releaseAttachments(current.images)
          statesBySource.set(key, { ...latest, outbox: null, error: null })
        }
        notify()
      } catch (cause) {
        const latest = statesBySource.get(key)
        if (latest?.outbox?.images === current.images) {
          statesBySource.set(key, {
            ...latest,
            outbox: {
              ...latest.outbox,
              status: uncertainSendError(cause) ? 'unknown' : 'failed',
              error: errorMessage(cause, workbenchText('sendFailed'))
            }
          })
        }
        notify()
        throw cause
      }
    },

    async prepareForPageReload(): Promise<boolean> {
      const revision = draftWriteRevision
      await Promise.all([...persistenceTails.values()])
      if (draftWriteRevision !== revision || persistenceFailures.size > 0) return false
      return [...statesBySource.values()].every(
        (state) => state.outbox?.status !== 'sending' && state.outbox?.status !== 'unknown'
      )
    },
    async restoreOutbox(source): Promise<void> {
      const key = sourceKey(source)
      await (persistenceTails.get(key) ?? Promise.resolve())
      const current = ensureState(source)
      if (!current.outbox) return
      await repository.restoreOutboxToDraft(source)
      statesBySource.set(key, {
        ...current,
        text: inputText(current.outbox.text, current.text),
        images: [...current.outbox.images, ...current.images],
        outbox: null,
        notice: null,
        error: null
      })
      notify()
    },

    async deleteOutbox(source): Promise<void> {
      const current = ensureState(source)
      if (!current.outbox) return
      await repository.deleteOutbox(source)
      releaseAttachments(current.outbox.images)
      statesBySource.set(sourceKey(source), {
        ...current,
        outbox: null,
        notice: null,
        error: null
      })
      notify()
    },

    async interrupt(source): Promise<void> {
      requireSynchronizedSource(source)
      try {
        await biz.interruptChat({ source })
        replaceState(source, (state) => ({ ...state, error: null }))
      } catch (cause) {
        replaceState(source, (state) => ({
          ...state,
          error: errorMessage(cause, workbenchText('interruptFailed'))
        }))
        throw cause
      }
    },

    async restoreQueue(source): Promise<void> {
      requireSynchronizedSource(source)
      try {
        const restored = await biz.restoreChatQueue({ source })
        const restoredImages = restored.images.map((image, index) =>
          createL2WorkbenchImageAttachment(
            {
              blob: fromL2ChatImageResponse(image),
              mimeType: image.mimeType,
              width: image.width,
              height: image.height,
              optimized: true
            },
            workbenchText('restoredImage', { count: index + 1 })
          )
        )
        const next = replaceState(source, (state) => ({
          ...state,
          text: inputText(restored.text, state.text),
          images: [...restoredImages, ...state.images],
          notice: null,
          error: null
        }))
        enqueueDraftWrite(source, storedInput(next))
      } catch (cause) {
        replaceState(source, (state) => ({
          ...state,
          error: errorMessage(cause, workbenchText('queueRestoreFailed'))
        }))
        throw cause
      }
    },

    async listTools(source): Promise<L3PiNativeToolsListResponse> {
      requireSynchronizedSource(source)
      return biz.listPiTools({ source })
    },

    async loadModels(source, forceRefresh = false): Promise<void> {
      const current = ensureState(source)
      if (
        current.models.status === 'loading' ||
        (!forceRefresh && current.models.status === 'ready')
      )
        return
      const loading = replaceState(source, (state) => ({
        ...state,
        models: { ...state.models, status: 'loading', error: null }
      })).models
      const key = sourceKey(source)
      try {
        const catalog = await biz.listModels({ workId: source.workId })
        if (disposed || statesBySource.get(key)?.models !== loading) return
        replaceState(source, (state) => ({
          ...state,
          models: { status: 'ready', models: catalog.models, presets: catalog.presets, error: null }
        }))
      } catch (cause) {
        if (disposed || statesBySource.get(key)?.models !== loading) return
        replaceState(source, (state) => ({
          ...state,
          models: {
            ...state.models,
            status: 'error',
            error: errorMessage(cause, workbenchText('modelCatalogFailed'))
          }
        }))
      }
    },

    async setModel(source, model): Promise<void> {
      requireSynchronizedSource(source)
      const key = sourceKey(source)
      ensureState(source)
      try {
        await biz.setChatModel({ source, model })
        if (!disposed && sourcesByKey.has(key)) {
          replaceState(source, (state) => ({ ...state, error: null }))
        }
      } catch (cause) {
        if (!disposed && sourcesByKey.has(key)) {
          replaceState(source, (state) => ({
            ...state,
            error: errorMessage(cause, workbenchText('setModelFailed'))
          }))
        }
        throw cause
      }
    },

    acquireMessageImage(input): L2WorkbenchAcquiredImage | Promise<L2WorkbenchAcquiredImage> {
      if (disposed) throw new Error(workbenchText('imageUnavailable'))
      const key = input.entryId
        ? durableImageKey(input.source, input.entryId, input.imageIndex)
        : input.tempId
          ? tempImageKey(input.source, input.tempId, input.imageIndex)
          : null
      if (!key) throw new Error(workbenchText('imageIdentityInvalid'))
      sourcesByKey.set(sourceKey(input.source), input.source)

      const acquire = (image: CachedMessageImage): L2WorkbenchAcquiredImage => {
        if (disposed || messageImages.get(key) !== image) {
          throw new Error(workbenchText('imageUnavailable'))
        }
        image.references += 1
        messageImages.delete(key)
        messageImages.set(key, image)
        trimMessageImages()
        let released = false
        return {
          url: image.url,
          release: () => {
            if (released) return
            released = true
            image.references -= 1
            trimMessageImages()
          }
        }
      }

      const cached = messageImages.get(key)
      if (cached) return acquire(cached)
      let load = imageLoads.get(key)
      if (!load) {
        if (!input.entryId) throw new Error(workbenchText('localImagePending'))
        load = biz
          .getChatImage({
            sessionId: input.source.sessionId,
            branchId: input.source.branchId,
            entryId: input.entryId,
            imageIndex: input.imageIndex
          })
          .then((response) => {
            if (disposed || imageLoads.get(key) !== load) {
              throw new Error(workbenchText('imageUnavailable'))
            }
            const blob = fromL2ChatImageResponse(response)
            const image = { url: URL.createObjectURL(blob), size: blob.size, references: 0 }
            messageImages.set(key, image)
            return image
          })
          .catch((cause: unknown) => {
            console.warn('[Pi Desk][WorkbenchChatInput] 读取聊天图片失败', {
              entryId: input.entryId,
              error: errorMessage(cause, workbenchText('imageUnavailable'))
            })
            throw cause
          })
          .finally(() => {
            if (imageLoads.get(key) === load) imageLoads.delete(key)
          })
        imageLoads.set(key, load)
      }
      return load.then(acquire)
    },

    reconcileWorkSessions(workSessions): void {
      const valid = new Set(
        workSessions.map((workSession) =>
          sourceKey({
            workId: workSession.workId,
            sessionId: workSession.sessionId,
            branchId: workSession.branchId
          })
        )
      )
      for (const [key, source] of [...sourcesByKey]) {
        if (valid.has(key)) continue
        const persistenceTail = persistenceTails.get(key) ?? Promise.resolve()
        releaseSourceMemory(source)
        void persistenceTail
          .then(
            () => repository.clearSource(source),
            () => repository.clearSource(source)
          )
          .catch((error: unknown) => {
            console.error('[Pi Desk][WorkbenchChatInput] 清理失效 Source 输入失败', {
              workId: source.workId,
              errorName: error instanceof Error ? error.name : 'UnknownError'
            })
          })
      }
      notify()
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      unsubscribeSourceEvents()
      optimizeQueue.length = 0
      for (const source of [...sourcesByKey.values()]) releaseSourceMemory(source)
      for (const image of messageImages.values()) URL.revokeObjectURL(image.url)
      messageImages.clear()
      imageLoads.clear()
      persistenceFailures.clear()
      listeners.clear()
    }
  }

  return runtime
}
