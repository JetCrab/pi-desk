'use client'

import { SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { L3PiNativeToolInfo } from '@common/l3_modules/plugin-host/l3-plugin-native-pi-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem
} from '@client/l4_foundation/ui/shadcn/select'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@client/l4_foundation/ui/shadcn/input-group'

const EXPOSURE_LABELS = {
  direct: ['toolExposureDirect', '直接使用'],
  'model-only': ['toolExposureModelOnly', '仅模型调用'],
  codemode: ['toolExposureCodemode', '通过脚本调用'],
  deferred: ['toolExposureDeferred', '按需发现'],
  hidden: ['toolExposureHidden', '不可调用']
} as const

export function L2WorkbenchContextTools({
  tools
}: {
  tools: L3PiNativeToolInfo[]
}): React.JSX.Element {
  const { t } = useTranslation('workbench')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  const search = query.trim().toLocaleLowerCase()
  const matches = tools.filter(
    (tool) =>
      (!search ||
        `${tool.name} ${tool.source ?? ''} ${tool.description}`
          .toLocaleLowerCase()
          .includes(search)) &&
      (filter === 'all' || (filter === 'blocked' ? tool.blockedByMode : tool.exposure === filter))
  )
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <InputGroup className="min-w-0 flex-1 basis-56">
          <InputGroupAddon>
            <SearchIcon className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t('searchTools')}
            placeholder={t('searchToolsSources', { defaultValue: '搜索名称、来源或描述' })}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </InputGroup>
        <Select
          value={filter}
          onValueChange={(value) => {
            if (typeof value === 'string') setFilter(value)
          }}
        >
          <SelectTrigger aria-label={t('toolFilter')} className="max-w-full">
            <SelectValue>
              {filter === 'all'
                ? t('allTools')
                : filter === 'blocked'
                  ? t('toolBlockedByMode')
                  : t(
                      EXPOSURE_LABELS[filter as keyof typeof EXPOSURE_LABELS]?.[0] ?? 'toolUnknown'
                    )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent positionerClassName="z-[120]">
            <SelectItem value="all">{t('allTools')}</SelectItem>
            {Object.entries(EXPOSURE_LABELS).map(([value, [key, label]]) => (
              <SelectItem key={value} value={value}>
                {t(key, { defaultValue: label })}
              </SelectItem>
            ))}
            <SelectItem value="blocked">{t('toolBlockedByMode')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="divide-y">
        {matches.map((tool) => {
          const exposure = tool.exposure ? EXPOSURE_LABELS[tool.exposure] : null
          return (
            <article key={tool.name} className="space-y-2 py-3">
              <h3 className="wrap-anywhere font-mono text-sm font-medium">{tool.name}</h3>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>
                  {t('toolSource', { defaultValue: '来源' })}:{' '}
                  {tool.source ?? t('toolUnknown', { defaultValue: '未知' })}
                </span>
                <span>
                  {exposure
                    ? t(exposure[0], { defaultValue: exposure[1] })
                    : t('toolUnknown', { defaultValue: '未知' })}
                </span>
                <span>
                  {tool.active === undefined
                    ? t('toolUnknown', { defaultValue: '未知' })
                    : tool.active
                      ? t('toolActive', { defaultValue: '当前已选用' })
                      : t('toolInactive', { defaultValue: '当前未选用' })}
                </span>
                <span>
                  {tool.blockedByMode === undefined
                    ? t('toolModeUnknown', { defaultValue: '模式限制未知' })
                    : tool.blockedByMode
                      ? t('toolBlockedByMode', { defaultValue: '受模式限制' })
                      : t('toolNotBlocked', { defaultValue: '未受模式限制' })}
                </span>
              </div>
              <p className="whitespace-pre-wrap wrap-anywhere text-sm text-muted-foreground">
                {tool.description}
              </p>
              <details>
                <summary className="min-h-7 cursor-pointer text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t('parameterSchema')}
                </summary>
                <pre className="mt-2 whitespace-pre-wrap wrap-anywhere rounded-lg bg-muted p-3 font-mono text-sm leading-[1.6]">
                  {JSON.stringify(tool.parameters, null, 2)}
                </pre>
              </details>
            </article>
          )
        })}
        {!matches.length ? (
          <div className="space-y-3 py-6 text-sm text-muted-foreground">
            <p>
              {search || filter !== 'all'
                ? t('noMatchingTools')
                : t('noRegisteredTools', { defaultValue: '当前会话没有登记工具' })}
            </p>
            {search || filter !== 'all' ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQuery('')
                  setFilter('all')
                }}
              >
                {t('clearSearch')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
