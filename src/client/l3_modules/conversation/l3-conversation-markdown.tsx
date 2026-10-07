'use client'

import { Maximize2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { L3_STREAMDOWN_ZH_TRANSLATIONS } from '@common/l3_modules/conversation/l3-conversation-locale-messages'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { useMemo, useState, type ComponentProps, type MouseEvent } from 'react'
import type { MessageResponseProps } from '@client/l4_foundation/ui/ai-elements/message'
import { MessageResponse } from '@client/l4_foundation/ui/ai-elements/message'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { L4ImageViewer } from '@client/l4_foundation/ui/l4-image-viewer'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import styles from './l3-conversation-markdown.module.css'

const COMPACT_CODE_CONTROLS = {
  code: {
    copy: true,
    download: false
  }
} as const

type L3ConversationMarkdownProps = Omit<MessageResponseProps, 'controls' | 'lineNumbers'>
type L3ConversationMarkdownImageProps = ComponentProps<'img'> & { node?: unknown }
type L3ConversationMarkdownLinkProps = ComponentProps<'a'> & { node?: unknown }

function getCodeCopyText(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null

  const copyButton = target.closest<HTMLButtonElement>('[data-streamdown="code-block-copy-button"]')
  if (!copyButton) return null

  return (
    copyButton
      .closest<HTMLElement>('[data-streamdown="code-block"]')
      ?.querySelector<HTMLElement>('[data-streamdown="code-block-body"]')?.textContent ?? null
  )
}

function L3ConversationMarkdownLink({
  href,
  children,
  ...linkProps
}: L3ConversationMarkdownLinkProps): React.JSX.Element {
  delete linkProps.node

  return (
    <a {...linkProps} href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  )
}

function L3ConversationMarkdownImage({
  src,
  alt,
  className,
  onError,
  ...imageProps
}: L3ConversationMarkdownImageProps): React.JSX.Element | null {
  const { t } = useTranslation('conversation')
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const imageAlt = alt || t('image')
  const slides = useMemo(
    () => (typeof src === 'string' && src ? [{ src, alt: imageAlt }] : []),
    [imageAlt, src]
  )
  delete imageProps.node

  if (slides.length === 0) return null
  if (failed) {
    return <span className={styles.imageFallback}>{t('imageUnavailable')}</span>
  }

  const imageSrc = slides[0]!.src

  return (
    <>
      <button
        type="button"
        className={styles.imageTrigger}
        aria-label={t('previewImage', { name: imageAlt })}
        onClick={() => setOpen(true)}
      >
        {/* Markdown 图片可能来自远端或 Blob URL，加载和释放仍由原始来源负责。 */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          {...imageProps}
          src={imageSrc}
          alt={imageAlt}
          data-streamdown="image"
          className={cn(styles.image, className)}
          onError={(event) => {
            setFailed(true)
            onError?.(event)
          }}
        />
        <span className={styles.imageAction} aria-hidden="true">
          <Maximize2Icon className="size-4" />
        </span>
      </button>
      {open ? (
        <L4ImageViewer
          mode="modal"
          open
          slides={slides}
          ariaLabel={t('imagePreview')}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

export function L3ConversationMarkdown({
  className,
  isAnimating,
  components,
  ...props
}: L3ConversationMarkdownProps): React.JSX.Element {
  const toast = useL4AppToast()
  const { t } = useTranslation('conversation')
  const { locale } = useL4Region()

  const handleCodeCopyFallback = (event: MouseEvent<HTMLDivElement>): void => {
    if (typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function')
      return

    const text = getCodeCopyText(event.target)
    if (text === null) return

    event.preventDefault()
    event.stopPropagation()
    void copyL4BrowserText(text).then((copied) => {
      if (!copied) toast.error(t('codeCopyFailed'))
    })
  }

  return (
    <div className="contents" onClickCapture={handleCodeCopyFallback}>
      <MessageResponse
        className={cn('space-y-0', styles.markdown, className)}
        controls={COMPACT_CODE_CONTROLS}
        isAnimating={isAnimating}
        lineNumbers={false}
        components={{
          ...components,
          a: L3ConversationMarkdownLink,
          img: L3ConversationMarkdownImage
        }}
        {...props}
        translations={locale === 'zh-CN' ? L3_STREAMDOWN_ZH_TRANSLATIONS : undefined}
      />
    </div>
  )
}
