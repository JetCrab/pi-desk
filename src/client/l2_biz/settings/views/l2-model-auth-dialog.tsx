'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  L2ModelAuthNotice,
  L2ModelAuthPrompt,
  L2ModelAuthProvider,
  L2ModelAuthState
} from '@common/l2_biz/model-auth/l2-model-auth-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { L4SecretInput } from '@client/l4_foundation/ui/l4-secret-input'
import {
  L4AppDialogRoot,
  L4AppDialogContent,
  L4AppDialogHeader,
  L4AppDialogTitle,
  L4AppDialogBody,
  L4AppDialogFooter
} from '@client/l4_foundation/ui/l4-app-dialog'
import { safeL2ModelAuthUrl } from '../l2-model-auth-biz'
import { Field, FixedSelect } from './l2-model-settings-form'

function AuthPrompt({
  prompt,
  submitting,
  onRespond
}: {
  prompt: L2ModelAuthPrompt
  submitting: boolean
  onRespond: (promptId: string, value: string) => Promise<void>
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [value, setValue] = useState('')
  const canSubmit = prompt.type !== 'select' || value.length > 0
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit && !submitting) void onRespond(prompt.id, value)
      }}
    >
      <Field label={prompt.message}>
        {prompt.type === 'select' ? (
          <FixedSelect
            value={value}
            ariaLabel={prompt.message}
            placeholder={prompt.placeholder ?? t('accountChooseOption')}
            options={(prompt.options ?? []).map((option) => ({
              value: option.id,
              label: option.description ? `${option.label} — ${option.description}` : option.label
            }))}
            onChange={setValue}
          />
        ) : prompt.type === 'secret' ? (
          <L4SecretInput
            value={value}
            placeholder={prompt.placeholder}
            disabled={submitting}
            onChange={(event) => setValue(event.target.value)}
          />
        ) : (
          <Input
            value={value}
            placeholder={prompt.placeholder}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            disabled={submitting}
            onChange={(event) => setValue(event.target.value)}
          />
        )}
      </Field>
      <Button type="submit" disabled={!canSubmit || submitting} className="justify-self-end">
        {t('accountContinue')}
      </Button>
    </form>
  )
}

function AuthNotice({
  notice,
  onCopy,
  onOpenUrl
}: {
  notice: L2ModelAuthNotice
  onCopy: (value: string) => Promise<void>
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const links: Array<{ url: string; label?: string }> =
    notice.type === 'auth_url'
      ? [{ url: notice.url }]
      : notice.type === 'device_code'
        ? [{ url: notice.verificationUri }]
        : notice.type === 'info'
          ? (notice.links ?? [])
          : []
  return (
    <div className="space-y-3">
      {notice.type === 'auth_url' && notice.instructions ? (
        <p className="whitespace-pre-wrap text-sm">{notice.instructions}</p>
      ) : null}
      {notice.type === 'info' || notice.type === 'progress' ? (
        <p className="whitespace-pre-wrap text-sm" role="status">
          {notice.message}
        </p>
      ) : null}
      {notice.type === 'device_code' ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
          <span className="text-sm">{t('accountDeviceCode')}</span>
          <code className="select-all break-all text-lg font-semibold">{notice.userCode}</code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void onCopy(notice.userCode)}
          >
            {t('accountCopyCode')}
          </Button>
        </div>
      ) : null}
      {links.map((link, index) =>
        safeL2ModelAuthUrl(link.url) ? (
          <div key={`${index}:${link.url}`} className="space-y-2">
            <p className="break-all text-sm text-muted-foreground">{link.url}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => onOpenUrl(link.url)}>
                {link.label ?? t('accountOpenLink')}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => void onCopy(link.url)}>
                {t('accountCopyLink')}
              </Button>
            </div>
          </div>
        ) : (
          <p key={index} role="alert" className="text-sm text-destructive">
            {t('accountInvalidLink')}
          </p>
        )
      )}
    </div>
  )
}

export function L2ModelAuthDialog({
  open,
  connected,
  providers,
  state,
  loading,
  submitting,
  error,
  onClose,
  onStart,
  onRespond,
  onCopy,
  onOpenUrl,
  onRetry
}: {
  open: boolean
  connected: boolean
  providers: L2ModelAuthProvider[]
  state: L2ModelAuthState | null
  loading: boolean
  submitting: boolean
  error: string | null
  onClose: () => void
  onStart: (provider: string) => Promise<void>
  onRetry: () => void
  onRespond: (promptId: string, value: string) => Promise<void>
  onCopy: (value: string) => Promise<void>
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const running = state?.status === 'running'
  return (
    <L4AppDialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <L4AppDialogContent className="max-w-lg">
        <L4AppDialogHeader className="border-b p-4 pr-12">
          <L4AppDialogTitle>
            {state
              ? (providers.find((item) => item.provider === state.provider)?.name ?? state.provider)
              : t('accountLogin')}
          </L4AppDialogTitle>
        </L4AppDialogHeader>
        <L4AppDialogBody className="max-h-[65dvh]">
          <div className="space-y-4 p-4">
            {error ? (
              <p role="alert" className="whitespace-pre-wrap text-sm text-destructive">
                {error}
              </p>
            ) : null}
            {state?.message ? (
              <p
                role={state.status === 'error' ? 'alert' : 'status'}
                className="whitespace-pre-wrap text-sm"
              >
                {state.message}
              </p>
            ) : null}
            {!state || state.status === 'cancelled' || state.status === 'error' ? (
              loading ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {t('accountLoadingProviders')}
                </p>
              ) : (
                <div className="grid gap-2">
                  <h3 className="text-sm font-semibold">{t('accountChooseProvider')}</h3>
                  {!providers.length ? (
                    <p className="text-sm text-muted-foreground">{t('accountNoProviders')}</p>
                  ) : null}
                  {providers.map((provider) => (
                    <div key={provider.provider} className="grid gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-auto min-h-10 justify-between whitespace-normal text-left"
                        disabled={!connected || Boolean(provider.conflict)}
                        onClick={() => void onStart(provider.provider)}
                      >
                        <span>{provider.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {provider.loggedIn ? t('accountRelogin') : t('accountLogin')}
                        </span>
                      </Button>
                      {provider.conflict ? (
                        <p className="text-sm text-destructive">{provider.conflict}</p>
                      ) : null}
                    </div>
                  ))}
                </div>
              )
            ) : null}
            {running && state.notice ? (
              <AuthNotice notice={state.notice} onCopy={onCopy} onOpenUrl={onOpenUrl} />
            ) : null}
            {running && state.prompt ? (
              <AuthPrompt
                key={state.prompt.id}
                prompt={state.prompt}
                submitting={submitting || !connected}
                onRespond={onRespond}
              />
            ) : null}
            {running && !state.prompt ? (
              <p role="status" className="text-sm text-muted-foreground">
                {t('accountWaiting')}
              </p>
            ) : null}
            {state?.status === 'completed' ? (
              <p role="status" className="text-sm">
                {t('accountLoggedIn')}
              </p>
            ) : null}
          </div>
        </L4AppDialogBody>
        <L4AppDialogFooter>
          {error && !running ? (
            <Button type="button" variant="outline" disabled={loading} onClick={onRetry}>
              {t('retry', { ns: 'common' })}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            {t(running ? 'cancel' : 'close', { ns: 'common' })}
          </Button>
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
