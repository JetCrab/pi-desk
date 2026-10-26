import { L1HomePage } from '@client/l1_entry/pages/l1-home-page'
import { L1AppRuntimeProvider } from '@client/l1_entry/providers/l1-app-runtime-provider'

export default function Home(): React.JSX.Element {
  return (
    <L1AppRuntimeProvider>
      <L1HomePage />
    </L1AppRuntimeProvider>
  )
}
