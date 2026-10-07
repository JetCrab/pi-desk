'use client'

import {
  ChevronRightIcon,
  LoaderCircleIcon,
  LogOutIcon,
  ShieldCheckIcon,
  ShieldOffIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { L4PasswordInput } from '@client/l4_foundation/ui/l4-password-input'
import { useL2AuthSettings } from './hooks/l2-use-auth-settings'

export function L2AuthSettings(): React.JSX.Element {
  const { t } = useTranslation('auth')
  const state = useL2AuthSettings()
  const enabled = state.settings?.enabled ?? false
  const busy = state.saving || state.signingOut
  const StatusIcon = enabled ? ShieldCheckIcon : ShieldOffIcon

  return (
    <section aria-labelledby="auth-settings-title" className="@container min-w-0 space-y-6">
      <h2 id="auth-settings-title" className="text-xl font-semibold">
        {t('settings:loginProtection')}
      </h2>
      {state.loading ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t('common:loading')}
        </p>
      ) : state.settings ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-muted p-4">
            <div className="flex min-w-0 items-center gap-3">
              <StatusIcon className="size-5 shrink-0" aria-hidden="true" />
              <div className="space-y-1">
                <p className="text-sm font-semibold">{t('protection')}</p>
                <p className="text-sm text-muted-foreground">
                  {t(enabled ? 'enabled' : 'disabled')}
                </p>
              </div>
            </div>
            {enabled ? (
              <Button
                type="button"
                variant="outline"
                className="border-destructive/50 text-destructive hover:bg-destructive/10 hover:text-destructive"
                disabled={busy}
                aria-busy={state.signingOut}
                onClick={() => void state.logout()}
              >
                {state.signingOut ? (
                  <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />
                ) : (
                  <LogOutIcon aria-hidden="true" />
                )}
                {t(state.signingOut ? 'signingOut' : 'logout')}
              </Button>
            ) : null}
          </div>
          <form
            className="grid gap-4 @min-[36rem]:grid-cols-[10rem_minmax(0,1fr)] @min-[36rem]:gap-6"
            aria-busy={busy}
            onSubmit={(event) => {
              event.preventDefault()
              void state.save()
            }}
          >
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">
                {t(enabled ? 'changePassword' : 'setPassword')}
              </h3>
              {!enabled ? (
                <p className="text-sm text-muted-foreground">{t('publicAccess')}</p>
              ) : null}
            </div>
            <div className="min-w-0 max-w-[40rem] space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-medium" htmlFor="auth-password">
                  {t(enabled ? 'newPassword' : 'password')}
                </label>
                <L4PasswordInput
                  id="auth-password"
                  name="password"
                  className="[&::-ms-reveal]:hidden"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={256}
                  required
                  disabled={busy}
                  value={state.password}
                  aria-describedby={`auth-password-hint${state.error ? ' auth-settings-error' : ''}`}
                  onChange={(event) => state.setPassword(event.target.value)}
                />
                <p id="auth-password-hint" className="text-xs text-muted-foreground">
                  {t('passwordHint')}
                </p>
              </div>
              {state.error ? (
                <p id="auth-settings-error" className="text-sm text-destructive" role="alert">
                  {state.error}
                </p>
              ) : null}
              <p className="text-sm text-muted-foreground">{t('saveEffect')}</p>
              <Button type="submit" disabled={busy}>
                {state.saving ? (
                  <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />
                ) : null}
                {t(state.saving ? 'saving' : enabled ? 'saveAndSignIn' : 'enable')}
              </Button>
            </div>
          </form>
          {enabled ? (
            <div className="flex flex-wrap items-start justify-between gap-4 border-t pt-4">
              <details className="group min-w-0 flex-1 text-sm">
                <summary className="flex min-h-8 w-fit cursor-pointer items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  <ChevronRightIcon
                    className="size-4 shrink-0 transition-transform group-open:rotate-90"
                    aria-hidden="true"
                  />
                  {t('recovery')}
                </summary>
                <div className="mt-2 space-y-2">
                  <p className="text-muted-foreground">{t('recoveryDescription')}</p>
                  <code className="block break-all text-xs">{state.settings.configPath}</code>
                </div>
              </details>
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground"
                disabled={busy}
                onClick={() => void state.disable()}
              >
                {t('disable')}
              </Button>
            </div>
          ) : null}
        </>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-destructive" role="alert">
            {state.error}
          </p>
          <Button variant="outline" onClick={state.retry}>
            {t('common:retry')}
          </Button>
        </div>
      )}
      {state.dialog}
    </section>
  )
}
