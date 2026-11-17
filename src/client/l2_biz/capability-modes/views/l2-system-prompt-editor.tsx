import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EyeIcon } from 'lucide-react'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Textarea } from '@client/l4_foundation/ui/shadcn/textarea'
import { L4LoadingState } from '@client/l4_foundation/ui/loading/l4-loading-state'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import {
  L4AppDialogBody,
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogHeader,
  L4AppDialogFooter,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import type { L2CapabilityModesBiz } from '../l2-capability-modes-biz'
import { useL2SystemPromptPreview } from '../hooks/l2-use-system-prompt-preview'

type PromptSource = 'global' | 'none' | 'custom'

export function L2SystemPromptEditor({
  global,
  builtin,
  promptSource,
  content,
  globalDirty,
  error,
  disabled,
  source,
  biz,
  onSourceChange,
  onChange,
  onRetry,
  onReset,
  onEditGlobal
}: {
  global: boolean
  builtin: boolean
  promptSource: PromptSource
  content: string | null
  globalDirty: boolean
  error: string | null
  disabled: boolean
  source: L2ChatSource | null
  biz: L2CapabilityModesBiz
  onSourceChange: (value: PromptSource) => void
  onChange: (content: string) => void
  onRetry: () => void
  onReset: () => void
  onEditGlobal: () => void
}): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [repairOpen, setRepairOpen] = useState(false)
  const base = useL2SystemPromptPreview(biz, source, t('previewFailed'))
  const preview = useL2SystemPromptPreview(biz, source, t('previewFailed'))
  const editable = global || promptSource === 'custom'
  const emptyAppend = !global && promptSource === 'none'
  const append = emptyAppend ? '' : content
  const heading = global || promptSource === 'global' ? t('globalAppend') : t('modeAppend')
  const displayStatus = (data: typeof base, original: boolean): React.JSX.Element =>
    !source ? (
      <p className="text-sm text-muted-foreground">{t('previewUnavailable')}</p>
    ) : data.loading ? (
      <L4LoadingState compact={original} className={original ? 'justify-start' : 'min-h-72'}>
        {t('previewLoading')}
      </L4LoadingState>
    ) : data.error ? (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {data.error}
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void data.request(original ? '' : (append ?? ''))}
        >
          {t('retryRead')}
        </Button>
      </div>
    ) : data.value ? (
      <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed">
        {(original ? data.value.baseSystemPrompt : data.value.systemPrompt) ?? t('baseUnavailable')}
      </pre>
    ) : (
      <Button
        size="sm"
        variant="outline"
        onClick={() => void data.request(original ? '' : (append ?? ''))}
      >
        {t('retryRead')}
      </Button>
    )

  return (
    <div className="space-y-6 p-4">
      {!global && !builtin && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{t('promptSource')}</h3>
          <L4ChoiceGroup<PromptSource>
            label={t('promptSource')}
            layout="segmented"
            value={promptSource}
            disabled={disabled}
            options={[
              { value: 'global', label: t('sourceGlobal') },
              { value: 'none', label: t('sourceNone') },
              { value: 'custom', label: t('sourceCustom') }
            ]}
            onChange={onSourceChange}
          />
        </div>
      )}
      {!global && promptSource === 'global' && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted p-3">
          <div className="min-w-0 flex-1 text-sm">
            <p>{t('inheritedPrompt')}</p>
            {globalDirty && (
              <p className="mt-1 text-sm text-muted-foreground">{t('globalDraftNotApplied')}</p>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={disabled} onClick={onEditGlobal}>
            {t('editGlobal')}
          </Button>
        </div>
      )}
      <details
        className="rounded-lg border"
        onToggle={(event) => {
          if (event.currentTarget.open && !base.value && !base.loading) void base.request('')
        }}
      >
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
          {t('originalPrompt')}{' '}
          <span className="ml-2 text-xs font-normal text-muted-foreground">{t('readOnly')}</span>
        </summary>
        <div className="max-h-72 overflow-y-auto border-t p-3">{displayStatus(base, true)}</div>
      </details>
      <section aria-label={heading} className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{heading}</h3>
          <Button
            size="sm"
            variant="ghost"
            disabled={!source || append === null || disabled}
            onClick={() => {
              setPreviewOpen(true)
              void preview.request(append ?? '')
            }}
          >
            <EyeIcon className="size-4" />
            {t('fullPreview')}
          </Button>
        </div>
        {emptyAppend ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            {t('nonePromptHint')}
          </p>
        ) : error ? (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={disabled} onClick={onRetry}>
                {t('retryRead')}
              </Button>
              {editable && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => setRepairOpen(true)}
                >
                  {t('rewritePrompt')}
                </Button>
              )}
            </div>
          </div>
        ) : content === null ? (
          <L4LoadingState className="min-h-72">{t('promptLoading')}</L4LoadingState>
        ) : (
          <>
            <Textarea
              aria-label={global ? t('globalPrompt') : t('modePrompt')}
              placeholder={t('promptPlaceholder')}
              className="min-h-72 resize-y font-mono text-sm leading-relaxed"
              value={content}
              readOnly={!editable}
              disabled={disabled}
              spellCheck={false}
              onChange={(event) => onChange(event.target.value)}
            />
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>{editable ? 'Markdown' : t('readOnlyGlobal')}</span>
              <span>{t('characterCount', { count: content.length })}</span>
            </div>
          </>
        )}
        <p className="text-sm text-muted-foreground">
          {global
            ? t('globalPromptScope')
            : promptSource === 'custom'
              ? t('customPromptScope')
              : t('modePromptScope')}
        </p>
        {!source && <p className="text-sm text-muted-foreground">{t('previewUnavailable')}</p>}
      </section>
      <L4AppDialogRoot open={repairOpen} onOpenChange={setRepairOpen}>
        <L4AppDialogContent className="z-[150]" backdropClassName="z-[140]">
          <L4AppDialogHeader className="p-4 pr-12">
            <L4AppDialogTitle>{t('rewritePrompt')}</L4AppDialogTitle>
            <L4AppDialogDescription>{t('rewriteDescription')}</L4AppDialogDescription>
          </L4AppDialogHeader>
          <L4AppDialogFooter>
            <Button variant="outline" onClick={() => setRepairOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                onReset()
                setRepairOpen(false)
              }}
            >
              {t('rewritePrompt')}
            </Button>
          </L4AppDialogFooter>
        </L4AppDialogContent>
      </L4AppDialogRoot>
      <L4AppDialogRoot open={previewOpen} onOpenChange={setPreviewOpen}>
        <L4AppDialogContent
          className="z-[150] h-[min(42rem,calc(100dvh-2rem))] max-w-[48rem]"
          backdropClassName="z-[140]"
        >
          <L4AppDialogHeader className="border-b p-4 pr-12">
            <L4AppDialogTitle>{t('fullPreview')}</L4AppDialogTitle>
            <L4AppDialogDescription>{t('previewDescription')}</L4AppDialogDescription>
          </L4AppDialogHeader>
          <L4AppDialogBody>
            <div className="p-4">{displayStatus(preview, false)}</div>
          </L4AppDialogBody>
        </L4AppDialogContent>
      </L4AppDialogRoot>
    </div>
  )
}
