import type { Metadata, Viewport } from 'next'
import { getL4HostSettingsStore } from '@server/l4_foundation/l4-host-settings-store'
import Script from 'next/script'
import type { ReactNode } from 'react'
import { L3_PLUGIN_HOST_BROWSER_RUNTIME_IMPORT_MAP } from '@common/l3_modules/plugin-host/l3-plugin-browser-contract'
import { L4_DEFAULT_THEME, L4_THEME_STORAGE_KEY } from '@common/l4_foundation/theme/l4-theme'
import {
  L4_DEFAULT_DISPLAY_SIZE,
  L4_DISPLAY_SIZES,
  L4_DISPLAY_SIZE_STORAGE_KEY,
  L4_LEGACY_CHAT_SIZE_STORAGE_KEY
} from '@common/l4_foundation/l4-display-size'
import '@client/l4_foundation/styles/l4-globals.css'
import { L1AppProviders } from '@client/l1_entry/providers/l1-app-providers'

const pluginHostRuntimeImportMap = JSON.stringify(L3_PLUGIN_HOST_BROWSER_RUNTIME_IMPORT_MAP)

const themeBootstrapScript = `(() => {
  const root = document.documentElement;
  try {
    const saved = window.localStorage.getItem(${JSON.stringify(L4_THEME_STORAGE_KEY)});
    const theme = saved === 'system' || saved === 'light' || saved === 'dark'
      ? saved
      : ${JSON.stringify(L4_DEFAULT_THEME)};
    const dark = theme === 'dark'
      || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    root.classList.toggle('dark', dark);
    root.style.colorScheme = dark ? 'dark' : 'light';
  } catch {
    root.classList.add('dark');
    root.style.colorScheme = 'dark';
  }
})()`

const displaySizeBootstrapScript = `(() => {
  const root = document.documentElement;
  try {
    const saved = window.localStorage.getItem(${JSON.stringify(L4_DISPLAY_SIZE_STORAGE_KEY)});
    const legacy = saved === null
      ? JSON.parse(window.localStorage.getItem(${JSON.stringify(L4_LEGACY_CHAT_SIZE_STORAGE_KEY)}) ?? 'null')
      : null;
    root.dataset.piDeskDisplaySize = ${JSON.stringify(L4_DISPLAY_SIZES)}.includes(saved)
      ? saved
      : legacy?.chatSize === 'large' ? 'standard' : ${JSON.stringify(L4_DEFAULT_DISPLAY_SIZE)};
  } catch {
    root.dataset.piDeskDisplaySize = ${JSON.stringify(L4_DEFAULT_DISPLAY_SIZE)};
  }
})()`

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Pi Desk',
  description: 'Pi Desk web workspace'
}

export const viewport: Viewport = {
  interactiveWidget: 'resizes-content'
}

export default function RootLayout({
  children
}: Readonly<{ children: ReactNode }>): React.JSX.Element {
  const settings = getL4HostSettingsStore().getSnapshot()
  return (
    <html
      lang={settings.region.locale}
      className="dark"
      data-pi-desk-display-size={L4_DEFAULT_DISPLAY_SIZE}
      suppressHydrationWarning
    >
      <head>
        <script type="importmap" dangerouslySetInnerHTML={{ __html: pluginHostRuntimeImportMap }} />
        <Script id="pi-desk-theme" strategy="beforeInteractive">
          {themeBootstrapScript}
        </Script>
        <Script id="pi-desk-display-size" strategy="beforeInteractive">
          {displaySizeBootstrapScript}
        </Script>
      </head>
      <body>
        <L1AppProviders initialSettings={settings}>{children}</L1AppProviders>
      </body>
    </html>
  )
}
