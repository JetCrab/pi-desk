'use client'

import { CheckIcon, CopyIcon, FileTextIcon, RefreshCwIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L2ChatSource } from '@common/l2_biz/chat/l2-chat-contract'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import { L4ChoiceGroup } from '@client/l4_foundation/ui/l4-choice-group'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  L4AppDialogBody,
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import type { L2WorkbenchBiz } from './l2-workbench-biz'
import type { L2WorkbenchChatInputRuntime } from './l2-workbench-chat-input-runtime'
import {
  useL2WorkbenchModelContext,
  type L2WorkbenchContextTab
} from './hooks/l2-workbench-model-context'
import { L2WorkbenchContextTools } from './views/l2-workbench-context-tools'
import type { L2NativeUiModel } from './native-ui/l2-native-ui'
import type { L2NativeUiBiz } from './native-ui/l2-native-ui-biz'
import { L2NativeUiMcp } from './native-ui/l2-native-ui-mcp'

interface L2WorkbenchModelContextDialogProps {
  open: boolean
  source: L2ChatSource
  runtime: L2WorkbenchChatInputRuntime
  getContext: L2WorkbenchBiz['getChatModelContext']
  listCommands: L2WorkbenchBiz['listPiCommands']
  nativeUi: L2NativeUiModel
  nativeBiz: L2NativeUiBiz
  commandsDisabled: boolean
  onOpenChange: (open: boolean) => void
  onOpenSettings?: () => void
}

export function L2WorkbenchModelContextDialog({
  open,
  source,
  runtime,
  getContext,
  listCommands,
  nativeUi,
  nativeBiz,
  commandsDisabled,
  onOpenChange,
  onOpenSettings
}: L2WorkbenchModelContextDialogProps): React.JSX.Element {
  const { t, i18n } = useTranslation('workbench')
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<L2WorkbenchContextTab>('tools')
  const toast = useL4AppToast()
  const { context, tools, commands } = useL2WorkbenchModelContext({
    source,
    open,
    tab: view,
    runtime,
    getContext,
    listCommands
  })
  const data = view === 'system' ? context : view === 'tools' ? tools : commands
  const question = nativeUi.state.snapshot.requests[0]?.id
  useEffect(() => {
    if (!open || !question) return
    nativeUi.setCollapsed(false)
    onOpenChange(false)
  }, [open, question, nativeUi, onOpenChange])

  const copyPrompt = async (): Promise<void> => {
    if (!context.value) return
    if (await copyL4BrowserText(context.value.systemPrompt)) setCopied(true)
    else toast.error(t('contextCopyFailed'))
  }

  return (
    <L4AppDialogRoot open={open} onOpenChange={onOpenChange}>
      <L4AppDialogContent className="h-[min(42rem,calc(100dvh-2rem))] max-w-[45rem]">
        <L4AppDialogHeader className="border-b p-4 pr-12">
          <div className="flex min-w-0 items-center gap-2">
            <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
            <L4AppDialogTitle>
              {t('toolsAndContext', { defaultValue: '工具与上下文' })}
            </L4AppDialogTitle>
          </div>
          <L4AppDialogDescription className="sr-only">
            {t('sessionContextDescription', {
              defaultValue: '当前会话的登记工具、系统提示词和 MCP 原生命令'
            })}
          </L4AppDialogDescription>
        </L4AppDialogHeader>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <L4ChoiceGroup<L2WorkbenchContextTab>
            label={t('contextContents')}
            layout="segmented"
            value={view}
            onChange={setView}
            options={[
              { value: 'tools', label: t('tools') },
              { value: 'system', label: t('systemPrompt') },
              { value: 'mcp', label: t('mcpSession', { defaultValue: '会话 MCP' }) }
            ]}
          />
          <div className="flex items-center gap-2">
            {view === 'system' ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={!context.value || context.loading}
                onClick={() => void copyPrompt()}
              >
                {copied ? <CheckIcon /> : <CopyIcon />}
                {copied ? t('copied') : t('copy')}
              </Button>
            ) : null}
            {onOpenSettings ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  onOpenChange(false)
                  onOpenSettings()
                }}
              >
                {t('openSettings', {
                  defaultValue: (i18n.resolvedLanguage ?? i18n.language).startsWith('en')
                    ? 'Open settings'
                    : '打开设置'
                })}
              </Button>
            ) : null}
          </div>
        </div>
        <L4AppDialogBody>
          <div className="p-4">
            {data.loading || (!data.value && !data.error) ? (
              <div
                role="status"
                className="flex items-center gap-2 py-6 text-sm text-muted-foreground"
              >
                <RefreshCwIcon className="size-4 animate-spin" />
                {t('contextLoading')}
              </div>
            ) : data.error ? (
              <div className="space-y-3 py-6">
                <p role="alert" className="text-sm text-destructive">
                  {data.error}
                </p>
                <Button variant="outline" size="sm" onClick={data.retry}>
                  <RefreshCwIcon />
                  {t('contextRetry')}
                </Button>
              </div>
            ) : view === 'tools' && tools.value ? (
              <L2WorkbenchContextTools tools={tools.value.tools} />
            ) : view === 'system' && context.value ? (
              <section aria-label={t('systemPrompt')}>
                <pre className="whitespace-pre-wrap wrap-anywhere font-mono text-sm leading-[1.6]">
                  {context.value.systemPrompt || t('emptyContent')}
                </pre>
              </section>
            ) : view === 'mcp' && commands.value ? (
              <L2NativeUiMcp
                available={commands.value.commands.some(
                  (command) => command.name === 'mcp' && command.source === 'extension'
                )}
                state={nativeUi.state}
                disabled={commandsDisabled}
                onExecute={(args, login) => {
                  void nativeBiz.executeCommand(source, 'mcp', args)
                  if (login) {
                    nativeUi.setCollapsed(false)
                    onOpenChange(false)
                  }
                }}
              />
            ) : null}
          </div>
        </L4AppDialogBody>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
