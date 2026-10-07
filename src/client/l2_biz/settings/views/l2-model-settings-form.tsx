'use client'

import { L2ModelKnownApis } from '@common/l2_biz/model-settings/l2-model-settings-contract'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Textarea } from '@client/l4_foundation/ui/shadcn/textarea'

const MODEL_API_LABELS = [
  'OpenAI Chat Completions',
  'OpenAI Responses',
  'Anthropic Messages',
  'Google Generative AI',
  'Mistral Conversations',
  'Azure OpenAI Responses',
  'OpenAI Codex Responses',
  'Amazon Bedrock',
  'Google Vertex AI',
  'Pi Messages'
]

export const MODEL_APIS = L2ModelKnownApis.map((value, index) => ({
  value,
  label: MODEL_API_LABELS[index]
}))

export const THINKING_FORMATS = [
  'openai',
  'openrouter',
  'together',
  'deepseek',
  'zai',
  'qwen',
  'chat-template',
  'qwen-chat-template',
  'string-thinking',
  'ant-ling',
  'baseten'
] as const

export function headersText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

export function parseHeaders(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf(':')
        return separator > 0
          ? [line.slice(0, separator).trim(), line.slice(separator + 1).trim()]
          : [line, '']
      })
  )
}

export function HeaderTextarea({
  headers,
  onChange,
  placeholder
}: {
  headers: Record<string, string>
  onChange: (headers: Record<string, string>) => void
  placeholder: string
}): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Textarea
      value={draft ?? headersText(headers)}
      onFocus={() => setDraft(headersText(headers))}
      onChange={(event) => {
        const text = event.target.value
        setDraft(text)
        onChange(parseHeaders(text))
      }}
      onBlur={() => setDraft(null)}
      rows={4}
      placeholder={placeholder}
      className="font-mono"
    />
  )
}

export function tokensToK(tokens: number): string {
  const whole = Math.floor(tokens / 1000)
  const fraction = tokens % 1000
  return fraction
    ? `${whole}.${String(fraction).padStart(3, '0').replace(/0+$/, '')}`
    : String(whole)
}

export function kToTokens(value: string): number | null {
  if (!/^\d+(?:\.\d{0,3})?$/.test(value)) return null
  const [whole, fraction = ''] = value.split('.')
  const tokens = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'))
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : null
}

export function Field({
  label,
  children,
  className
}: {
  label: string
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={cn('grid gap-1 text-sm text-foreground', className)}>
      <span className="font-medium">{label}</span>
      {children}
    </label>
  )
}

const EMPTY_SELECT_VALUE = '__pi-desk_empty__'

export function FixedSelect({
  value,
  options,
  onChange,
  ariaLabel,
  placeholder,
  allowEmpty = true,
  className
}: {
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
  ariaLabel: string
  placeholder?: string
  allowEmpty?: boolean
  className?: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const label = placeholder ?? t('useDefault')
  const effectiveValue = value || (allowEmpty ? EMPTY_SELECT_VALUE : (options[0]?.value ?? null))
  const unknownValue = Boolean(value) && !options.some((option) => option.value === value)
  return (
    <Select
      value={effectiveValue}
      onValueChange={(nextValue) =>
        onChange(nextValue === EMPTY_SELECT_VALUE || nextValue === null ? '' : nextValue)
      }
    >
      <SelectTrigger aria-label={ariaLabel} className={cn('w-full', className)}>
        <SelectValue>
          {options.find((option) => option.value === value)?.label ?? (value || label)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent positionerClassName="z-[120]">
        {allowEmpty ? <SelectItem value={EMPTY_SELECT_VALUE}>{label}</SelectItem> : null}
        {unknownValue ? <SelectItem value={value}>{value}</SelectItem> : null}
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function TriStateSelect({
  value,
  onChange,
  ariaLabel
}: {
  value: boolean | null
  onChange: (value: boolean | null) => void
  ariaLabel: string
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <FixedSelect
      value={value === null ? '' : String(value)}
      ariaLabel={ariaLabel}
      options={[
        { value: 'true', label: t('yes') },
        { value: 'false', label: t('no') }
      ]}
      onChange={(nextValue) => onChange(nextValue === '' ? null : nextValue === 'true')}
    />
  )
}
