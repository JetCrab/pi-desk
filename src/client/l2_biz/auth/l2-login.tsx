'use client'

import { ArrowRightIcon, LanguagesIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useL4AppSocket } from '@client/l4_foundation/realtime/app-socket/l4-app-socket'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { setL4RegionDisplayLocale } from '@client/l4_foundation/locale/l4-region-store'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { resolveL4Locale } from '@common/l4_foundation/locale/l4-locale'
import { L4PasswordInput } from '@client/l4_foundation/ui/l4-password-input'
import { L4BrandIcon } from '@client/l4_foundation/ui/l4-brand-icon'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'
import { loginL2Auth } from './l2-login-biz'
import styles from './l2-login.module.css'

export function L2Login(): React.JSX.Element {
  const { t } = useTranslation('auth')
  const region = useL4Region()
  const { clientId } = useL4AppSocket()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  useEffect(() => {
    setL4RegionDisplayLocale(
      resolveL4Locale(navigator.languages.length ? navigator.languages : [navigator.language])
    )
  }, [])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (submittingRef.current) return
    submittingRef.current = true
    setError(null)
    setSubmitting(true)
    try {
      await loginL2Auth(clientId, { password })
      window.location.replace('/')
    } catch (cause) {
      submittingRef.current = false
      setError(cause instanceof Error ? cause.message : t('loginFailed'))
      setSubmitting(false)
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <L4BrandIcon className="shrink-0" />
          <span>Pi Desk</span>
        </div>
        <Select
          value={region.locale}
          onValueChange={(value) => {
            if (value === 'en' || value === 'zh-CN') setL4RegionDisplayLocale(value)
          }}
        >
          <SelectTrigger
            aria-label={t('settings:language')}
            className="w-fit border-transparent bg-transparent shadow-none"
          >
            <LanguagesIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            <SelectValue>{region.locale === 'zh-CN' ? t('common:chinese') : 'English'}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">简体中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </header>

      <div className={styles.content}>
        <section className={styles.panel} aria-labelledby="login-title">
          <div className={styles.heading}>
            <h1 id="login-title">{t('title')}</h1>
            <p>{t('subtitle')}</p>
          </div>
          <form
            className={styles.form}
            onSubmit={(event) => void handleSubmit(event)}
            aria-busy={submitting}
          >
            <div className={styles.field}>
              <label htmlFor="password">{t('password')}</label>
              <L4PasswordInput
                id="password"
                name="password"
                value={password}
                autoComplete="current-password"
                maxLength={256}
                disabled={submitting}
                aria-describedby={error ? 'login-error' : undefined}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
            </div>
            {error ? (
              <p id="login-error" className={styles.error} role="alert">
                {error}
              </p>
            ) : null}
            <Button className={styles.submit} type="submit" disabled={submitting}>
              {submitting ? (
                <LoaderCircleIcon className="motion-safe:animate-spin" aria-hidden="true" />
              ) : null}
              {submitting ? t('submitting') : t('submit')}
              {!submitting ? <ArrowRightIcon aria-hidden="true" /> : null}
            </Button>
          </form>
        </section>
      </div>
    </main>
  )
}
