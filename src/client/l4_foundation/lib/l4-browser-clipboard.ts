import { copyBrowserText } from '@jetcrab/pi-desk-sdk/browser'

export function copyL4BrowserText(text: string): Promise<boolean> {
  return copyBrowserText(text)
}
