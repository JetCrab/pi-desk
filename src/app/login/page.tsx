import type { Metadata } from 'next'
import { L1LoginPage } from '@client/l1_entry/pages/l1-login-page'

export const metadata: Metadata = {
  title: '登录 · Pi Desk'
}

export default function LoginPage(): React.JSX.Element {
  return <L1LoginPage />
}
