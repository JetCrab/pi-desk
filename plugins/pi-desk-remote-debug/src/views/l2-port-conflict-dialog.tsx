import {
  PluginAlert,
  PluginConfirmDialog,
  PluginList,
  PluginListItem
} from '@jetcrab/pi-desk-sdk/react/base'
import type { RemoteDebugPortConflict } from '../l4-remote-debug-contract.js'

export function PortConflictDialog({
  confirmation,
  pending,
  error,
  onConfirm,
  onCancel
}: {
  confirmation: { cwd: string; profile: string; conflicts: RemoteDebugPortConflict[] } | null
  pending: boolean
  error: string | null
  onConfirm(): Promise<void>
  onCancel(): void
}): React.JSX.Element {
  return (
    <PluginConfirmDialog
      open={confirmation !== null}
      title="端口被占用，强制结束进程？"
      description="将强制结束以下占用进程，对应服务会中断，未保存的数据可能丢失。端口释放后继续启动远程调试。"
      confirmLabel="强制结束并启动"
      tone="danger"
      pending={pending}
      onConfirm={onConfirm}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {confirmation ? (
        <div className="remote-debug-stack">
          <div className="remote-debug-path">
            <strong>{confirmation.profile}</strong>
            <div className="remote-debug-muted">{confirmation.cwd}</div>
          </div>
          <PluginList aria-label="占用端口的进程">
            {confirmation.conflicts.map(({ port, pid, processName }) => (
              <PluginListItem key={`${port}:${pid}`}>
                <div className="remote-debug-path">
                  <strong>端口 {port}</strong>
                  <div>
                    {processName} · PID {pid}
                  </div>
                </div>
              </PluginListItem>
            ))}
          </PluginList>
          {error ? <PluginAlert tone="error">{error}</PluginAlert> : null}
        </div>
      ) : null}
    </PluginConfirmDialog>
  )
}
