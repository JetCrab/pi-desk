'use client'

import { useSyncExternalStore, type ReactElement } from 'react'
import { CopyCommandButton } from '@client/l4_foundation/ui/l4-command'

function subscribeLanguage(onChange: () => void): () => void {
  window.addEventListener('languagechange', onChange)
  return () => window.removeEventListener('languagechange', onChange)
}

function prefersChinese(): boolean {
  return navigator.language.toLowerCase().startsWith('zh')
}

function serverPrefersChinese(): boolean {
  return false
}

export function CliInstall({ command }: { command: string }): ReactElement {
  const chinese = useSyncExternalStore(subscribeLanguage, prefersChinese, serverPrefersChinese)
  const steps = [
    {
      label: 'Pi',
      command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent'
    },
    { label: 'Pi Desk', command }
  ]
  const choices = [
    { label: '默认复制', command: steps.map((step) => step.command).join('\n') },
    {
      label: '加速源复制',
      command: steps
        .map((step) => `${step.command} --registry=https://mirrors.cloud.tencent.com/npm`)
        .join('\n'),
      description:
        '使用腾讯云 npm 镜像，适合中国大陆网络。镜像同步可能延迟，遇到版本滞后时可使用默认源。',
      className:
        'border-amber-600/25 bg-amber-500/10 text-amber-800 hover:bg-amber-500/20 active:bg-amber-500/25 dark:border-amber-400/25 dark:text-amber-300'
    }
  ]
  if (chinese) choices.reverse()

  return (
    <section aria-label="安装 Pi 与 Pi Desk" className="space-y-3">
      <dl className="space-y-5 rounded-xl bg-muted p-4">
        {steps.map((step) => (
          <div key={step.label} className="space-y-1.5">
            <dt className="text-xs font-medium text-muted-foreground">{step.label}</dt>
            <dd>
              <code className="block overflow-x-auto font-mono text-sm leading-6 whitespace-nowrap">
                {step.command}
              </code>
            </dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap justify-end gap-2">
        {choices.map((choice, index) => (
          <CopyCommandButton
            key={choice.label}
            {...choice}
            variant={index === 0 ? 'default' : 'secondary'}
          />
        ))}
      </div>
    </section>
  )
}
