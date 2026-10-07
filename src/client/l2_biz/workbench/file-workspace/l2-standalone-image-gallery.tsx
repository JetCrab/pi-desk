'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { readL3ImagePreviewMode } from '@client/l3_modules/preferences/l3-work-session-file-preferences'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
import { L4ImageViewer } from '@client/l4_foundation/ui/l4-image-viewer'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import type { L2WorkSessionFilesBiz } from './l2-work-session-files-biz'
import type { L2PluginStandaloneFilePreviewTarget } from './l2-plugin-standalone-file-preview'
import type { L2StandaloneImageCache, L2StandaloneImageLease } from './l2-standalone-image-cache'

// 保留未读取图片的位置，让查看器的切图、计数和手势始终使用同一份顺序。
const EMPTY_IMAGE =
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/%3E'

type ImageDocument = { status: 'ready'; objectUrl: string } | { status: 'error'; message: string }

export function L2StandaloneImageGallery({
  target,
  paths,
  index,
  onIndexChange,
  biz,
  images
}: {
  target: L2PluginStandaloneFilePreviewTarget
  paths: readonly string[]
  index: number
  onIndexChange: (index: number) => void
  biz: L2WorkSessionFilesBiz
  images: L2StandaloneImageCache
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [documents, setDocuments] = useState<Record<string, ImageDocument>>({})
  const leasesRef = useRef(new Map<string, L2StandaloneImageLease>())
  const path = paths[index]
  const current = documents[path]
  const mode = readL3ImagePreviewMode()
  const cachedUrl = images.peek(target, path, mode)
  const currentReady = current?.status === 'ready' || (!current && cachedUrl !== null)

  useLayoutEffect(() => {
    const leases = leasesRef.current
    return () => {
      for (const image of leases.values()) image.release()
      leases.clear()
    }
  }, [])

  useLayoutEffect(() => {
    const leases = leasesRef.current
    if (current?.status === 'error' || leases.has(path)) return
    const cached = images.get(target, path, mode)
    if (cached) {
      leases.set(path, cached)
      return
    }
    const controller = new AbortController()
    let lease: L2StandaloneImageLease | undefined
    void (async (): Promise<void> => {
      try {
        const result = await biz.get(
          {
            workId: target.source.workId,
            cwd: target.cwd,
            path,
            imagePreviewMode: mode
          },
          controller.signal
        )
        if (controller.signal.aborted) return
        if (result.kind !== 'image') throw new Error(t('standaloneReadFailed'))
        lease = images.store(target, path, mode, createL4Base64ImageBlob(result))
        const image = new Image()
        image.src = lease.url
        await image.decode()
        if (controller.signal.aborted) return
        const readyUrl = lease.url
        leases.set(path, lease)
        setDocuments((previous) => ({
          ...previous,
          [path]: { status: 'ready', objectUrl: readyUrl }
        }))
      } catch (cause) {
        if (lease) {
          lease.release()
          images.invalidate(target, path, mode)
        }
        if (controller.signal.aborted) return
        const message = cause instanceof Error ? cause.message : t('standaloneReadFailed')
        console.warn('[Pi Desk][StandaloneImageGallery] 读取图片失败', {
          workId: target.source.workId,
          path,
          error: message
        })
        setDocuments((previous) => ({ ...previous, [path]: { status: 'error', message } }))
      }
    })()
    return () => {
      controller.abort()
      if (leases.get(path) !== lease) lease?.release()
    }
  }, [biz, current, images, mode, path, t, target])

  return (
    <div className="relative size-full" data-testid="standalone-image-gallery">
      <L4ImageViewer
        mode="inline"
        thumbnails={false}
        slides={paths.map((imagePath) => {
          const document = documents[imagePath]
          return {
            src:
              document?.status === 'ready'
                ? document.objectUrl
                : imagePath === path
                  ? (cachedUrl ?? EMPTY_IMAGE)
                  : EMPTY_IMAGE,
            alt: imagePath
          }
        })}
        index={index}
        onIndexChange={onIndexChange}
      />
      {!currentReady ? (
        <div className="pointer-events-none absolute inset-0 z-[2] flex items-center justify-center p-6 pb-20">
          {current?.status === 'error' ? (
            <div className="flex max-w-full flex-col items-center gap-3 rounded-lg bg-background/95 p-4 text-center">
              <p role="alert" className="text-sm text-destructive">
                {current.message}
              </p>
              <Button
                className="pointer-events-auto"
                variant="outline"
                onClick={() => {
                  images.invalidate(target, path, readL3ImagePreviewMode())
                  setDocuments((previous) => {
                    const next = { ...previous }
                    delete next[path]
                    return next
                  })
                }}
              >
                {t('reloadFile')}
              </Button>
            </div>
          ) : (
            <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {t('loadingFile')}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
