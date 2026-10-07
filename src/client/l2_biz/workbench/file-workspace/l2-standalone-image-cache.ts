import type { L2WorkSessionListItem } from '@common/l2_biz/work-session/l2-work-session-contract'
import type { L4ProjectFileImagePreviewMode } from '@common/l4_foundation/file/l4-project-file-contract'
import type { L2PluginStandaloneFilePreviewTarget } from './l2-plugin-standalone-file-preview'

const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_IMAGES = 64
const IDLE_TTL_MS = 60_000

type ImageTarget = Pick<L2PluginStandaloneFilePreviewTarget, 'source' | 'cwd'>

interface CachedImage {
  url: string
  size: number
  references: number
  unusedAt: number
}

export interface L2StandaloneImageLease {
  url: string
  release(): void
}

function sourceKey(target: ImageTarget): string {
  const { workId, sessionId, branchId } = target.source
  return JSON.stringify([workId, sessionId, branchId, target.cwd])
}

function imageKey(target: ImageTarget, path: string, mode: L4ProjectFileImagePreviewMode): string {
  return `${sourceKey(target)}\u0000${mode}\u0000${path}`
}

// 窗口只持有展示引用；缓存由工作台文件 Runtime 释放，不影响会话文件 Tabs。
export class L2StandaloneImageCache {
  private readonly images = new Map<string, CachedImage>()
  private validSources = new Set<string>()
  private disposed = false

  peek(target: ImageTarget, path: string, mode: L4ProjectFileImagePreviewMode): string | null {
    const image = this.images.get(imageKey(target, path, mode))
    if (!image || (image.references === 0 && Date.now() - image.unusedAt >= IDLE_TTL_MS))
      return null
    return image.url
  }

  get(
    target: ImageTarget,
    path: string,
    mode: L4ProjectFileImagePreviewMode
  ): L2StandaloneImageLease | null {
    this.trim()
    const key = imageKey(target, path, mode)
    const image = this.images.get(key)
    return image ? this.acquire(key, image) : null
  }

  store(
    target: ImageTarget,
    path: string,
    mode: L4ProjectFileImagePreviewMode,
    blob: Blob
  ): L2StandaloneImageLease {
    if (this.disposed || !this.validSources.has(sourceKey(target))) {
      throw new Error('工作会话来源已变化')
    }
    const key = imageKey(target, path, mode)
    const cached = this.images.get(key)
    if (cached) return this.acquire(key, cached)
    const image: CachedImage = {
      url: URL.createObjectURL(blob),
      size: blob.size,
      references: 0,
      unusedAt: Date.now()
    }
    this.images.set(key, image)
    return this.acquire(key, image)
  }

  invalidate(target: ImageTarget, path: string, mode: L4ProjectFileImagePreviewMode): void {
    this.remove(imageKey(target, path, mode))
  }

  reconcileWorkSessions(sessions: readonly L2WorkSessionListItem[]): void {
    this.validSources = new Set(
      sessions.map((session) => sourceKey({ source: session, cwd: session.cwd }))
    )
    for (const key of this.images.keys()) {
      if (!this.validSources.has(key.split('\u0000')[0])) this.remove(key)
    }
    this.trim()
  }

  dispose(): void {
    this.disposed = true
    for (const key of this.images.keys()) this.remove(key)
    this.validSources.clear()
  }

  private acquire(key: string, image: CachedImage): L2StandaloneImageLease {
    image.references += 1
    this.images.delete(key)
    this.images.set(key, image)
    this.trim()
    let released = false
    return {
      url: image.url,
      release: () => {
        if (released) return
        released = true
        image.references -= 1
        if (image.references === 0) image.unusedAt = Date.now()
        this.trim()
      }
    }
  }

  private remove(key: string): void {
    const image = this.images.get(key)
    if (!image) return
    URL.revokeObjectURL(image.url)
    this.images.delete(key)
  }

  private trim(): void {
    const now = Date.now()
    let bytes = [...this.images.values()].reduce((total, image) => total + image.size, 0)
    for (const [key, image] of this.images) {
      if (image.references > 0) continue
      if (
        now - image.unusedAt < IDLE_TTL_MS &&
        bytes <= MAX_IMAGE_BYTES &&
        this.images.size <= MAX_IMAGES
      )
        continue
      this.remove(key)
      bytes -= image.size
    }
  }
}
