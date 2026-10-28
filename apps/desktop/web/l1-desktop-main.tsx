import { createRoot } from 'react-dom/client'
import { DesktopApp } from './l1-desktop-app'
import { L4DesktopTitlebar } from '@client/l4_foundation/desktop-window/l4-desktop-titlebar'

createRoot(document.getElementById('root')!).render(
  <>
    <L4DesktopTitlebar />
    <DesktopApp />
  </>
)
