'use client'

import Link from 'next/link'
import { useTranslation } from 'react-i18next'
import { Button } from '@client/l4_foundation/ui/shadcn/button'

export function L1ErrorPage({
  retry,
  notFound = false
}: {
  retry?: () => void
  notFound?: boolean
}): React.JSX.Element {
  const { t } = useTranslation('common')
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <div className="w-full max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">{t(notFound ? 'notFound' : 'pageError')}</h1>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {retry ? (
            <Button type="button" onClick={retry}>
              {t('recover')}
            </Button>
          ) : null}
          <Button variant="outline" render={<Link href="/" />}>
            {t('backHome')}
          </Button>
        </div>
      </div>
    </main>
  )
}
