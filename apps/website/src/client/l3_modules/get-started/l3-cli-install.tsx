'use client'

import { Fragment, useSyncExternalStore, type ReactElement } from 'react'
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
      command: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.0.1'
    },
    { label: 'Pi Desk', command }
  ]
  const choices = [
    { label: '默认复制', command: steps.map((step) => step.command).join('\n') },
    {
      label: '加速源复制',
      command: steps
        .map((step) => `${step.command} --registry=https://mirrors.cloud.tencent.com/npm`)
        .join('\n')
    }
  ]
  if (chinese) choices.reverse()

  return (
    <section aria-label="安装 Pi 与 Pi Desk" className="space-y-3">
      <h2 className="text-sm font-medium">安装 Pi 与 Pi Desk</h2>
      <div className="flex flex-wrap gap-2">
        {choices.map((choice, index) => (
          <CopyCommandButton
            key={choice.label}
            label={choice.label}
            command={choice.command}
            variant={index === 0 ? 'default' : 'secondary'}
          />
        ))}
      </div>
      <dl className="space-y-5 rounded-xl bg-muted p-4">
        {steps.map((step) => (
          <div key={step.label} className="space-y-1.5">
            <dt className="text-xs font-medium text-muted-foreground">{step.label}</dt>
            <dd>
              <code className="block overflow-x-auto font-mono text-sm leading-6">
                {step.command.split(' ').map((word, index) => (
                  <Fragment key={index}>
                    {index > 0 && ' '}
                    <span className="whitespace-nowrap">{word}</span>
                  </Fragment>
                ))}
              </code>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
