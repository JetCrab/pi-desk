'use client'

import { LoaderCircleIcon } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PluginSource } from '@jetcrab/pi-desk-sdk/browser'
import type { L2WorkSessionFileGetResponse } from '@common/l2_biz/work-session/l2-work-session-file-contract'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
import { readL3ImagePreviewMode } from '@client/l3_modules/preferences/l3-work-session-file-preferences'
import { L4CodePreview } from '@client/l4_foundation/ui/code/l4-code-preview'
import {
  L4AppDialogContent,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { L4ImageViewer } from '@client/l4_foundation/ui/l4-image-viewer'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { buildL2FilePreviewHtml } from './l2-file-preview-html'
import { L2StandaloneImageGallery } from './l2-standalone-image-gallery'
import type { L2WorkSessionFilesBiz } from './l2-work-session-files-biz'
import type { L2StandaloneImageCache } from './l2-standalone-image-cache'

export interface L2PluginStandaloneFilePreviewTarget {
  source: PluginSource
  cwd: string
  projectName: string
  path: string
  imagePaths?: readonly string[]
}

type StandaloneFileDocument =
  | { status: 'loading' }
  | { status: 'text'; content: string; size: number }
  | { status: 'image'; objectUrl: string }
  | { status: 'error'; message: string }

function fileName(path: string): string {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}

export function L2PluginStandaloneFilePreview({
  target,
  biz,
  images,
  mobile,
  onClose
}: {
  target: L2PluginStandaloneFilePreviewTarget | null
  biz: L2WorkSessionFilesBiz
  images: L2StandaloneImageCache
  mobile: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation('workbench')
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [retry, setRetry] = useState(0)
  const [document, setDocument] = useState<StandaloneFileDocument>(() => {
    const url =
      target && !target.imagePaths
        ? images.peek(target, target.path, readL3ImagePreviewMode())
        : null
    return url ? { status: 'image', objectUrl: url } : { status: 'loading' }
  })
  const [imageIndex, setImageIndex] = useState(() =>
    target?.imagePaths ? target.imagePaths.indexOf(target.path) : 0
  )

  useLayoutEffect(() => {
    if (!target || target.imagePaths) return
    const controller = new AbortController()
    let active = true
    let release: (() => void) | undefined
    const mode = readL3ImagePreviewMode()
    const cached = images.get(target, target.path, mode)
    if (cached) return cached.release
    void biz
      .get(
        {
          workId: target.source.workId,
          cwd: target.cwd,
          path: target.path,
          imagePreviewMode: mode
        },
        controller.signal
      )
      .then((result: L2WorkSessionFileGetResponse) => {
        if (!active) return
        if (result.kind === 'text') {
          setDocument({ status: 'text', content: result.content, size: result.size })
          return
        }
        const image = images.store(target, target.path, mode, createL4Base64ImageBlob(result))
        release = image.release
        setDocument({ status: 'image', objectUrl: image.url })
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) return
        console.warn('[Pi Desk][PluginStandaloneFilePreview] 读取文件失败', {
          workId: target.source.workId,
          path: target.path,
          error: errorMessage(cause, t('standaloneReadFailed'))
        })
        setDocument({ status: 'error', message: errorMessage(cause, t('standaloneReadFailed')) })
      })
    return () => {
      active = false
      controller.abort()
      release?.()
    }
  }, [biz, images, retry, target, t])

  useEffect(() => {
    if (!target) return
    const handleMessage = (event: MessageEvent): void => {
      if (
        event.source === iframeRef.current?.contentWindow &&
        event.data === 'pi-desk:file-escape'
      ) {
        onClose()
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [onClose, target])

  if (!target) return null
  const path = target.imagePaths?.[imageIndex] ?? target.path
  const isHtml = /\.html?$/i.test(path)
  return (
    <L4AppDialogRoot
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <L4AppDialogContent
        className={
          mobile
            ? 'inset-0 h-dvh max-h-none w-dvw max-w-none translate-x-0 translate-y-0 rounded-none border-0 ring-0'
            : 'h-[min(94dvh,1080px)] w-[min(96dvw,1600px)] max-w-none'
        }
      >
        <L4AppDialogTitle className="sr-only">{fileName(path)}</L4AppDialogTitle>
        <section
          data-testid="plugin-standalone-file-preview"
          className="flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"
          aria-label={t('standaloneViewer', { name: target.projectName })}
        >
          <header className="flex min-h-14 shrink-0 items-center border-b pl-3 pr-14 pt-[env(safe-area-inset-top)]">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold" title={fileName(path)}>
                {fileName(path)}
              </p>
              <p
                className="truncate text-xs text-muted-foreground"
                title={`${target.projectName} · ${path}`}
              >
                {target.projectName} · {path}
              </p>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-hidden pb-[env(safe-area-inset-bottom)]">
            {target.imagePaths ? (
              <L2StandaloneImageGallery
                target={target}
                paths={target.imagePaths}
                index={imageIndex}
                onIndexChange={setImageIndex}
                biz={biz}
                images={images}
              />
            ) : document.status === 'loading' ? (
              <Loading />
            ) : document.status === 'error' ? (
              <div className="flex size-full flex-col items-center justify-center gap-3 p-6 text-center">
                <p role="alert" className="text-sm text-destructive">
                  {document.message}
                </p>
                <Button
                  variant="outline"
                  onClick={() => {
                    images.invalidate(target, target.path, readL3ImagePreviewMode())
                    setDocument({ status: 'loading' })
                    setRetry((value) => value + 1)
                  }}
                >
                  {t('reloadFile')}
                </Button>
              </div>
            ) : document.status === 'image' ? (
              <L4ImageViewer
                mode="inline"
                slides={[{ src: document.objectUrl, alt: target.path }]}
                ariaLabel={t('standaloneImage', { name: fileName(target.path) })}
              />
            ) : isHtml ? (
              <iframe
                ref={iframeRef}
                className="block size-full border-0 bg-white"
                sandbox="allow-scripts"
                srcDoc={buildL2FilePreviewHtml(document.content)}
                title={t('standaloneHtml', { name: target.path })}
              />
            ) : (
              <L4CodePreview
                path={target.path}
                content={document.content}
                size={document.size}
                savedState={null}
                onSaveState={() => undefined}
                onEscape={onClose}
              />
            )}
          </div>
        </section>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}

function Loading(): React.JSX.Element {
  const { t } = useTranslation('workbench')
  return (
    <div className="flex size-full items-center justify-center gap-2 text-sm text-muted-foreground">
      <LoaderCircleIcon className="size-4 animate-spin" />
      {t('loadingFile')}
    </div>
  )
}
