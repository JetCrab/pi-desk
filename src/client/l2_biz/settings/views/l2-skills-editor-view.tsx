import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CheckIcon,
  CopyIcon,
  FileCodeIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  SaveIcon,
  WrapTextIcon
} from 'lucide-react'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type {
  L2SkillFileGetResponse,
  L2SkillItem
} from '@common/l2_biz/settings/l2-skills-contract'
import { L4CodeEditor } from '@client/l4_foundation/ui/code/l4-code-editor'
import { L4ImageViewer } from '@client/l4_foundation/ui/l4-image-viewer'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import type { L2SkillDocument } from '../hooks/l2-use-skills-editor'

interface EditorViewProps {
  document: L2SkillDocument | null
  skill: L2SkillItem | null
  dirty: boolean
  loading: boolean
  saving: boolean
  opening: boolean
  wrapLines: boolean
  onWrapLines: () => void
  onChange: (content: string) => void
  onSave: () => void
  onReload: () => void
  onCopy: () => void
}

function SkillImage({
  file,
  path
}: {
  file: Extract<L2SkillFileGetResponse, { kind: 'image' }>
  path: string
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const slides = useMemo(
    () => [{ src: `data:${file.mimeType};base64,${file.data}`, alt: path }],
    [file, path]
  )
  return (
    <L4ImageViewer
      mode="inline"
      slides={slides}
      className="h-full w-full"
      ariaLabel={t('imagePreview')}
    />
  )
}

export function L2SkillsEditorView(props: EditorViewProps): React.JSX.Element {
  const { document, skill, dirty, loading, saving, opening } = props
  const { t } = useTranslation('skills')
  const { locale } = useL4Region()
  if (!document)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileCodeIcon className="size-6 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t('chooseFile')}</h3>
        <p className="max-w-xs text-sm leading-6 text-muted-foreground">
          {t('chooseFileDescription')}
        </p>
      </div>
    )
  const file = document.file
  const readOnly = file?.kind === 'text' ? file.readOnlyReason : null
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-muted-foreground" title={skill?.description}>
            {skill?.name ?? document.target.skillPath.split('/').at(-2)}
            <span className="mx-1.5">/</span>
            {t(document.target.cwd === null ? 'global' : 'project')}
            {` · ${t(skill?.packageSource ? 'package' : 'local')}`}
          </p>
          <p className="mt-1 truncate font-mono text-sm" title={document.target.path}>
            {document.target.path}
          </p>
        </div>
        {file?.kind === 'text' && (
          <span
            role="status"
            aria-label={
              saving
                ? t('saving')
                : opening
                  ? t('switchingFile')
                  : dirty
                    ? t('unsavedChanges')
                    : readOnly
                      ? t('readOnlyFile')
                      : t('fileSaved')
            }
            className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:flex"
          >
            {saving || opening ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : dirty ? (
              <span className="size-1.5 rounded-full bg-status-warning" />
            ) : readOnly ? (
              <LockKeyholeIcon className="size-3.5" />
            ) : (
              <CheckIcon className="size-3.5" />
            )}
            {saving
              ? t('saving')
              : opening
                ? t('switchingFile')
                : dirty
                  ? t('unsaved')
                  : readOnly
                    ? t('readOnly')
                    : t('saved')}
          </span>
        )}
        {dirty && (
          <span
            aria-label={t('unsavedChanges')}
            className="size-2 shrink-0 rounded-full bg-status-warning sm:hidden"
          />
        )}
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('copySkillPath')}
          title={t('copyPath')}
          onClick={props.onCopy}
        >
          <CopyIcon className="size-4" />
        </Button>
        <Button
          aria-label={t('saveSkill')}
          disabled={!dirty || Boolean(readOnly) || loading || saving}
          onClick={props.onSave}
        >
          {saving ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <SaveIcon className="size-4" />
          )}
          {t('save')}
        </Button>
      </div>
      {readOnly && (
        <div
          role="note"
          className="flex shrink-0 items-start gap-2 border-b bg-muted px-4 py-2 text-sm leading-5 text-muted-foreground"
        >
          <LockKeyholeIcon className="mt-0.5 size-3.5 shrink-0" />
          <p>{selectL4LocalizedText(readOnly, locale)}</p>
        </div>
      )}
      {document.error && (
        <div role="alert" className="shrink-0 border-b bg-muted px-4 py-2 text-sm text-destructive">
          {document.error}
          {!file && (
            <Button variant="ghost" size="sm" onClick={props.onReload}>
              {t('reload')}
            </Button>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading && !file ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
          >
            <LoaderCircleIcon className="size-4 animate-spin" />
            {t('loadingFile')}
          </div>
        ) : file?.kind === 'text' ? (
          <L4CodeEditor
            path={
              document.target.skillPath.slice(0, document.target.skillPath.lastIndexOf('/') + 1) +
              document.target.path
            }
            content={document.draft}
            size={file.size}
            readOnly={Boolean(readOnly) || saving || opening}
            onChange={props.onChange}
            onSave={props.onSave}
          />
        ) : file?.kind === 'image' ? (
          <SkillImage file={file} path={document.target.path} />
        ) : file?.kind === 'unsupported' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <FileCodeIcon className="mb-2 size-8" />
            <p>{file.reason}</p>
            <p>
              {t('fileSize', {
                size: file.size.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN')
              })}
            </p>
          </div>
        ) : null}
      </div>
      {file?.kind === 'text' && (
        <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-t px-3 py-1 text-xs text-muted-foreground">
          <span className="truncate">UTF-8 · {readOnly ? t('readOnly') : t('saveShortcut')}</span>
          <Button
            variant="ghost"
            size="sm"
            aria-label={t('wrapLines')}
            aria-pressed={props.wrapLines}
            onClick={props.onWrapLines}
          >
            <WrapTextIcon className="size-3.5" />
            {t('wrapLines')}
          </Button>
        </div>
      )}
    </div>
  )
}
