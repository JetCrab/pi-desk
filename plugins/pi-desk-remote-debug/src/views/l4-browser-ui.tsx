import { copyBrowserText, type BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import { PluginButton } from '@jetcrab/pi-desk-sdk/react/base'

export function CopyButton({
  host,
  value,
  label = '复制'
}: {
  host: BrowserPluginHost
  value: string
  label?: string
}): React.JSX.Element {
  return (
    <PluginButton
      size="sm"
      variant="ghost"
      onClick={() => {
        void copyBrowserText(value).then((copied) => {
          host.notify({
            level: copied ? 'success' : 'error',
            title: copied ? '已复制' : '复制失败'
          })
        })
      }}
    >
      {label}
    </PluginButton>
  )
}

export const REMOTE_DEBUG_LAYOUT = `
.remote-debug-application{width:min(960px,calc(100dvw - 2rem));height:min(480px,calc(100dvh - 8rem));padding:1rem;container-type:inline-size}
.remote-debug-split{height:100%;min-height:0;align-items:stretch}
.remote-debug-split>.pi-desk-ui-content{display:flex;min-height:0;flex-direction:column}
.remote-debug-split .pi-desk-ui-split-navigation-scroll{height:100%;max-height:none}
.remote-debug-settings{min-width:0;width:100%;padding:1rem;container-type:inline-size;font-size:.875rem}
.remote-debug-settings [hidden]{display:none}
.remote-debug-stack{display:grid;min-width:0;gap:.75rem}
.remote-debug-heading,.remote-debug-profile-head,.remote-debug-actions{display:flex;min-width:0;gap:.5rem;align-items:center;flex-wrap:wrap}
.remote-debug-heading{justify-content:space-between;margin-bottom:1rem}
.remote-debug-heading h2{font-size:1.25rem;line-height:1.4;font-weight:600;margin:0}
.remote-debug-name{min-width:0;flex:1;font-weight:600;overflow-wrap:anywhere}
.remote-debug-profile-card{display:grid;min-width:0;gap:.5rem}
.remote-debug-profile-head{flex-wrap:nowrap}
.remote-debug-profile-head>button,.remote-debug-profile-head>[role=status]{flex-shrink:0}
.remote-debug-profile-summary{display:flex;align-items:baseline;gap:.5rem;min-width:0;flex:1}
.remote-debug-profile-name{flex-shrink:0;font-weight:600;max-width:100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.remote-debug-profile-description{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--muted-foreground);font-size:.875rem}
.remote-debug-muted{font-size:.875rem;line-height:1.5;color:var(--muted-foreground);overflow-wrap:anywhere}
.remote-debug-path{overflow-wrap:anywhere;word-break:break-word;min-width:0;font-size:.875rem;line-height:1.5}
.remote-debug-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-size:.875rem;line-height:1.6}
.remote-debug-navigation{display:grid;gap:.5rem;min-width:0}
.remote-debug-mobile-project{display:none;min-width:0;flex:1}
.remote-debug-settings-tabs{margin-bottom:1rem}
.remote-debug-profile-list{min-height:0;flex:1}
.remote-debug-profile-viewport{display:grid;align-content:start;gap:.5rem;padding-right:.25rem}
.remote-debug-address-row{display:flex;min-width:0;align-items:center;gap:.5rem;flex-wrap:wrap}
.remote-debug-access-row{display:flex;min-width:0;align-items:center;gap:.5rem}
.remote-debug-access-row>.remote-debug-caption{flex:none}
.remote-debug-access-link{display:flex;min-width:0;flex:1;color:inherit;text-decoration:underline;text-underline-offset:.15rem;font:.875rem/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap}
.remote-debug-access-host{min-width:0;overflow:hidden;text-overflow:ellipsis}
.remote-debug-address-actions{display:flex;align-items:center;flex:none;gap:.5rem;margin-left:auto}
.remote-debug-navigation .remote-debug-stack{justify-items:start}
.remote-debug-caption{font-size:.75rem;color:var(--muted-foreground);line-height:1.5}
.remote-debug-details{display:grid;gap:.75rem;border-top:1px solid var(--border);padding-top:.75rem}
.remote-debug-log{height:16rem;max-height:45dvh}
.remote-debug-form{display:grid;min-width:0;gap:1rem}
.remote-debug-form-width{width:100%;max-width:40rem;min-width:0}
@container (max-width:40rem){.remote-debug-split>.pi-desk-ui-navigation,.remote-debug-profile-description,.remote-debug-navigation,.remote-debug-project-title{display:none}.remote-debug-mobile-project{display:grid;grid-template-columns:auto minmax(0,1fr);align-items:center;gap:.5rem}}
`
