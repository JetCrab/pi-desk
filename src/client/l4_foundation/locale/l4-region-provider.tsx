'use client'

import { createInstance, type i18n, type Resource } from 'i18next'
import { I18nextProvider } from 'react-i18next'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { HostSettingsSnapshot } from '@jetcrab/pi-desk-sdk/settings'
import type { L4Locale } from '@common/l4_foundation/locale/l4-locale'
import { registerL4ErrorTranslator } from './l4-localized-error'
import {
  readL4Region,
  replaceL4HostSettings,
  startL4Region,
  subscribeL4Region,
  type L4RegionSnapshot
} from './l4-region-store'

const serverSnapshot = (): null => null

export function useL4Region(): L4RegionSnapshot {
  const region = useSyncExternalStore(subscribeL4Region, readL4Region, serverSnapshot)
  if (!region) throw new Error('区域设置尚未就绪')
  return region
}

function createL4TranslationInstance(locale: L4Locale, resources: Resource): i18n {
  const instance = createInstance()
  void instance.init({
    lng: locale,
    fallbackLng: 'en',
    resources,
    defaultNS: 'common',
    ns: Object.keys(resources.en ?? {}),
    initAsync: false,
    interpolation: { escapeValue: false }
  })
  return instance
}

function L4ReadyRegion({
  children,
  locale,
  resources
}: {
  children: ReactNode
  locale: L4Locale
  resources: Resource
}): React.JSX.Element {
  const [instance] = useState(() => createL4TranslationInstance(locale, resources))
  useEffect(() => {
    document.documentElement.lang = locale
    void instance.changeLanguage(locale)
    registerL4ErrorTranslator((key, params) =>
      instance.exists(key) ? instance.t(key, params) : null
    )
    return () => registerL4ErrorTranslator(null)
  }, [instance, locale])
  return <I18nextProvider i18n={instance}>{children}</I18nextProvider>
}

export function L4RegionProvider({
  children,
  resources,
  initialSettings
}: {
  children: ReactNode
  resources: Resource
  initialSettings: HostSettingsSnapshot
}): React.JSX.Element | null {
  const region = useSyncExternalStore(subscribeL4Region, readL4Region, serverSnapshot)
  useEffect(() => {
    replaceL4HostSettings(initialSettings)
    return startL4Region()
  }, [initialSettings])
  return region ? (
    <L4ReadyRegion locale={region.locale} resources={resources}>
      {children}
    </L4ReadyRegion>
  ) : null
}
