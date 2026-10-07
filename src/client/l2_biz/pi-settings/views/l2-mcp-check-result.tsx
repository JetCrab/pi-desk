import { CircleCheckIcon, CircleAlertIcon, LoaderCircleIcon } from 'lucide-react'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import type { L2PiSettingsController } from '../hooks/l2-use-pi-settings'
import { useL2PiSettingsText } from '../l2-pi-settings-locale'
import { L2PiSettingsError } from './l2-pi-settings-fields'

export function L2McpCheckResult({
  check,
  onRetry,
  onDismiss
}: {
  check: NonNullable<L2PiSettingsController['check']>
  onRetry: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useL2PiSettingsText()
  const Icon = check.loading ? LoaderCircleIcon : check.error ? CircleAlertIcon : CircleCheckIcon
  return (
    <section
      aria-label={t('连接测试结果')}
      aria-busy={check.loading}
      className="space-y-2 border-b pb-4"
    >
      <p role="status" className="flex items-center gap-2 text-sm font-medium">
        <Icon
          aria-hidden="true"
          className={`size-4 shrink-0 ${check.loading ? 'motion-safe:animate-spin' : check.error ? 'text-destructive' : ''}`}
        />
        {t(
          check.loading
            ? '已保存，正在测试连接…'
            : check.error
              ? '已保存，连接测试失败。'
              : '已保存，连接测试通过。'
        )}
      </p>
      <L2PiSettingsError message={check.error} />
      {check.loading ? (
        <p className="text-xs text-muted-foreground">
          {t('连接请求最多等待 10 秒；凭据命令可能延长检查时间。')}
        </p>
      ) : (
        <>
          {check.output && (
            <details className="text-sm">
              <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {t('查看详细输出')}
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-3 font-mono text-sm">
                {check.output}
              </pre>
            </details>
          )}
          <p className="text-xs text-muted-foreground">
            {t('检查连接已关闭，当前聊天会话状态未改变。')}
          </p>
          <div className="flex gap-2">
            {check.error && (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {t('重试')}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
              {t('关闭结果')}
            </Button>
          </div>
        </>
      )}
    </section>
  )
}
