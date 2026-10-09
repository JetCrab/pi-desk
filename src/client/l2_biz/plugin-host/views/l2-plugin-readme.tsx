'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  selectL4LocalizedText,
  type L4LocalizedText
} from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { MessageResponse } from '@client/l4_foundation/ui/ai-elements/message'

export function L2PluginReadme({ readme }: { readme: L4LocalizedText | null }): React.JSX.Element {
  const { t } = useTranslation('pluginManagement')
  const { locale } = useL4Region()
  const [language, setLanguage] = useState<string | null>(null)
  const translations = readme && typeof readme !== 'string' ? readme.translations : {}
  const languages = Object.keys(translations).filter((key) => /^(zh(?:-|$)|en(?:-|$))/.test(key))
  const selected = language && translations[language] !== undefined ? language : null
  const content = readme
    ? selected
      ? translations[selected]!
      : selectL4LocalizedText(readme, locale)
    : null
  return (
    <section className="min-w-0 space-y-3" aria-label={t('readme')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{t('readme')}</h3>
        {languages.length > 0 ? (
          <label className="flex items-center gap-2 text-sm">
            {t('readmeLanguage')}
            <select
              value={selected ?? ''}
              onChange={(event) => setLanguage(event.target.value || null)}
              className="min-h-8 rounded-lg border border-input bg-background px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">{t('defaultLanguage')}</option>
              {languages.map((key) => (
                <option key={key} value={key}>
                  {key.startsWith('zh') ? '中文' : 'English'}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      {content ? (
        <div className="min-w-0 overflow-x-auto text-base leading-relaxed [overflow-wrap:anywhere]">
          <MessageResponse
            mode="static"
            isAnimating={false}
            skipHtml
            controls={false}
            className="min-w-0 [&_img]:max-w-full [&_pre]:overflow-x-auto"
          >
            {content}
          </MessageResponse>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t('noReadme')}</p>
      )}
    </section>
  )
}
