'use client'

import {
  L4ProjectFileImagePreviewModeSchema,
  type L4ProjectFileImagePreviewMode
} from '@common/l4_foundation/file/l4-project-file-contract'

const IMAGE_PREVIEW_MODE_STORAGE_KEY = 'pi-super:image-preview-mode'
const DEFAULT_IMAGE_PREVIEW_MODE: L4ProjectFileImagePreviewMode = 'compressed'

const imagePreviewListeners = new Set<() => void>()
let imagePreviewMode: L4ProjectFileImagePreviewMode = DEFAULT_IMAGE_PREVIEW_MODE
let initialized = false

function initialize(): void {
  if (initialized || typeof window === 'undefined') return
  initialized = true
  try {
    const savedImageMode = L4ProjectFileImagePreviewModeSchema.safeParse(
      window.localStorage.getItem(IMAGE_PREVIEW_MODE_STORAGE_KEY)
    )
    imagePreviewMode = savedImageMode.success ? savedImageMode.data : DEFAULT_IMAGE_PREVIEW_MODE
  } catch {
    imagePreviewMode = DEFAULT_IMAGE_PREVIEW_MODE
  }
}

function publish(listeners: Set<() => void>): void {
  for (const listener of [...listeners]) listener()
}

export function readL3ImagePreviewMode(): L4ProjectFileImagePreviewMode {
  initialize()
  return imagePreviewMode
}

export function saveL3ImagePreviewMode(mode: L4ProjectFileImagePreviewMode): void {
  initialize()
  if (imagePreviewMode === mode) return
  imagePreviewMode = mode
  try {
    window.localStorage.setItem(IMAGE_PREVIEW_MODE_STORAGE_KEY, mode)
  } catch {
    // 存储不可用时仍在当前页面应用设置。
  }
  publish(imagePreviewListeners)
}

export function subscribeL3ImagePreviewMode(listener: () => void): () => void {
  imagePreviewListeners.add(listener)
  return () => imagePreviewListeners.delete(listener)
}
