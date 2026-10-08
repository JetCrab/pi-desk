import 'server-only'

import QRCode from 'qrcode'

export async function createQrCodeDataUrl(sourceUrl: string): Promise<string> {
  return QRCode.toDataURL(sourceUrl, {
    width: 160,
    margin: 4,
    color: { dark: '#000000', light: '#ffffff' }
  })
}
