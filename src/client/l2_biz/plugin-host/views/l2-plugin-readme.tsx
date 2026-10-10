'use client'

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  selectL4LocalizedText,
  type L4LocalizedText
} from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import { MessageResponse } from '@client/l4_foundation/ui/ai-elements/message'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@client/l4_foundation/ui/shadcn/select'

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
          <div className="flex items-center gap-2 text-sm">
            <span>{t('readmeLanguage')}</span>
            <Select value={selected ?? ''} onValueChange={(value) => setLanguage(value || null)}>
              <SelectTrigger aria-label={t('readmeLanguage')}>
                <SelectValue>
                  {selected
                    ? selected.startsWith('zh')
                      ? '中文'
                      : 'English'
                    : t('defaultLanguage')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent positionerClassName="z-[160]">
                <SelectItem value="">{t('defaultLanguage')}</SelectItem>
                {languages.map((key) => (
                  <SelectItem key={key} value={key}>
                    {key.startsWith('zh') ? '中文' : 'English'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
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
