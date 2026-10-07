'use client'

export function createL4Base64ImageBlob(image: { mimeType: string; data: string }): Blob {
  const binary = atob(image.data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new Blob([bytes], { type: image.mimeType })
}
