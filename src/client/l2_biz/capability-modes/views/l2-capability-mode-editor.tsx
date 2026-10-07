import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityRule } from '@jetcrab/pi-desk-sdk/capabilities'
import type {
  L3CapabilityCatalog,
  L3CapabilityMode
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import {
  l2CapabilityGroups,
  l2CapabilityRule,
  l2ReplaceCapabilityRule
} from '../l2-capability-modes-model'
import { L2CapabilityRulePicker } from './l2-capability-rule-picker'

export function L2CapabilityModeEditor({
  modeKey,
  mode,
  catalog,
  disabled,
  onChange
}: {
  modeKey: string
  mode: L3CapabilityMode
  catalog: L3CapabilityCatalog | null
  disabled: boolean
  onChange: (mode: L3CapabilityMode) => void
}): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const groups = useMemo(
    () => l2CapabilityGroups(catalog, mode, t('groupTools')),
    [catalog, mode, t]
  )
  const [groupKey, setGroupKey] = useState('tools')
  const group = groups.find((item) => item.key === groupKey) ?? groups[0]!
  const changeRule = (rule: CapabilityRule): void =>
    onChange(l2ReplaceCapabilityRule(mode, group.target, rule))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b px-4 py-3">
        <label className="flex max-w-xl flex-wrap items-center gap-2 text-sm font-medium">
          <span>{t('modeName')}</span>
          <Input
            aria-label={t('modeName')}
            value={mode.name}
            maxLength={64}
            disabled={disabled}
            className="min-w-40 flex-1"
            onChange={(event) => onChange({ ...mode, name: event.target.value })}
          />
        </label>
      </div>
      <div
        className="flex shrink-0 flex-wrap gap-1 border-b px-4 py-2"
        role="tablist"
        aria-label={t('category')}
      >
        {groups.map((item) => (
          <Button
            key={item.key}
            variant={item.key === group.key ? 'secondary' : 'ghost'}
            size="sm"
            role="tab"
            aria-selected={item.key === group.key}
            onClick={() => setGroupKey(item.key)}
          >
            {item.label}
          </Button>
        ))}
      </div>
      <L2CapabilityRulePicker
        key={`${modeKey}:${group.key}`}
        label={group.label}
        rule={l2CapabilityRule(mode, group.target)}
        options={group.options}
        disabled={disabled}
        onChange={changeRule}
      />
    </div>
  )
}
