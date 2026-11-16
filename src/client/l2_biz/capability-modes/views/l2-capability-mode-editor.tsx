import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CapabilityRule } from '@jetcrab/pi-desk-sdk/capabilities'
import type {
  L3CapabilityCatalog,
  L3CapabilityMode
} from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  l2CapabilityGroups,
  l2CapabilityRule,
  l2ReplaceCapabilityRule,
  type L2CapabilityModeView
} from '../l2-capability-modes-model'
import { L2CapabilityRulePicker } from './l2-capability-rule-picker'

export function L2CapabilityModeEditor({
  modeKey,
  mode,
  catalog,
  disabled,
  readOnly,
  view,
  onViewChange,
  onChange
}: {
  modeKey: string
  mode: L3CapabilityMode
  catalog: L3CapabilityCatalog | null
  disabled: boolean
  readOnly: boolean
  view: L2CapabilityModeView
  onViewChange: (view: L2CapabilityModeView) => void
  onChange: (mode: L3CapabilityMode) => void
}): React.JSX.Element {
  const { t } = useTranslation('capabilityModes')
  const groups = useMemo(
    () => l2CapabilityGroups(catalog, mode, t('groupTools')),
    [catalog, mode, t]
  )
  const group = groups.find((item) => item.key === view.groupKey) ?? groups[0]!
  const changeRule = (rule: CapabilityRule): void =>
    onChange(l2ReplaceCapabilityRule(mode, group.target, rule))
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
            onClick={() => onViewChange({ ...view, groupKey: item.key })}
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
        readOnly={readOnly}
        query={view.queries[group.key] ?? ''}
        rulesOpen={view.rulesOpen[group.key] ?? false}
        onQueryChange={(query) =>
          onViewChange({ ...view, queries: { ...view.queries, [group.key]: query } })
        }
        onRulesOpenChange={(open) =>
          onViewChange({ ...view, rulesOpen: { ...view.rulesOpen, [group.key]: open } })
        }
        onChange={changeRule}
      />
    </div>
  )
}
