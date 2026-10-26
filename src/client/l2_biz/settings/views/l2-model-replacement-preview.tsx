import { useTranslation } from 'react-i18next'
import type { L2ModelSettingsPreviewResponse } from '@common/l2_biz/model-settings/l2-model-settings-contract'

const THINKING_LABELS = {
  off: 'thinkingOff',
  minimal: 'thinkingMinimal',
  low: 'thinkingLow',
  medium: 'thinkingMedium',
  high: 'thinkingHigh',
  xhigh: 'thinkingXhigh',
  max: 'thinkingMax'
} as const

export function L2ModelReplacementPreview({
  projectDefaults
}: L2ModelSettingsPreviewResponse): React.JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <ul className="space-y-3 px-4 pb-4">
      {projectDefaults.map(({ cwd, from, to }) => (
        <li key={cwd} className="space-y-1">
          <p className="break-all font-medium">{cwd}</p>
          <p className="break-all text-muted-foreground">
            {from.provider}/{from.modelId} · {t(THINKING_LABELS[from.thinkingLevel])}
            <span className="mx-1.5">→</span>
            <span className="text-foreground">
              {to ? (
                <>
                  {to.provider}/{to.modelId} · {t(THINKING_LABELS[to.thinkingLevel])}
                </>
              ) : (
                t('clearProjectDefault')
              )}
            </span>
          </p>
        </li>
      ))}
    </ul>
  )
}
