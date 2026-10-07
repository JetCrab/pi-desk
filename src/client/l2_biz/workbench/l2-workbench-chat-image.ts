'use client'

import { createL4BrowserUuid } from '@client/l4_foundation/lib/l4-browser-uuid'
import { createL4Base64ImageBlob } from '@client/l4_foundation/media/l4-base64-image'
import type {
  L2ChatImageGetResponse,
  L2ChatInputImage,
  L2ChatImageMimeType
} from '@common/l2_biz/chat/l2-chat-contract'
import type { L2WorkbenchStoredImage } from './l2-workbench-chat-input-repository'
import { l2WorkbenchText } from './l2-workbench-text'

const MAX_LONG_EDGE = 2560
const RETRY_LONG_EDGE = 2048
const LARGE_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const PRESERVE_RATIO = 0.9

const SUPPORTED_INPUT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/bmp'
])
const SENDABLE_TYPES = new Set<L2ChatImageMimeType>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif'
])
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

export interface L2WorkbenchImageAttachment extends L2WorkbenchStoredImage {
  localId: string
  objectUrl: string
  name: string
  status: 'optimizing' | 'ready' | 'error'
  error: string | null
}

function normalizedMimeType(blob: Blob): string {
  return blob.type.toLowerCase().split(';')[0] ?? ''
}

async function decodeDimensions(blob: Blob): Promise<{
  bitmap: ImageBitmap
  width: number
  height: number
}> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    throw new Error(l2WorkbenchText('imageDecodeFailed'))
  }
  if (!Number.isSafeInteger(bitmap.width) || bitmap.width <= 0 || bitmap.height <= 0) {
    bitmap.close()
    throw new Error(l2WorkbenchText('imageInvalidDimensions'))
  }
  return { bitmap, width: bitmap.width, height: bitmap.height }
}

function scaledDimensions(width: number, height: number, maxLongEdge: number) {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) return { width, height }
  const scale = maxLongEdge / longEdge
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

function canvasBlob(
  bitmap: ImageBitmap,
  width: number,
  height: number,
  mimeType: 'image/jpeg' | 'image/webp',
  quality: number
): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error(l2WorkbenchText('canvasUnavailable'))
  context.drawImage(bitmap, 0, 0, width, height)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error(l2WorkbenchText('imageCompressFailed')))),
      mimeType,
      quality
    )
  })
}

function outputMimeType(inputMimeType: string): 'image/jpeg' | 'image/webp' {
  return inputMimeType === 'image/jpeg' ? 'image/jpeg' : 'image/webp'
}

async function readJpegStoredDimensions(
  blob: Blob
): Promise<{ width: number; height: number } | null> {
  const bytes = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer())
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null

  let offset = 2
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) return null
    const marker = bytes[offset]!
    offset += 1
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) return null
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null
    if (JPEG_START_OF_FRAME_MARKERS.has(marker) && segmentLength >= 7) {
      return {
        width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!
      }
    }
    offset += segmentLength
  }
  return null
}

export async function inspectL2WorkbenchImage(file: File): Promise<L2WorkbenchStoredImage> {
  const mimeType = normalizedMimeType(file)
  if (!SUPPORTED_INPUT_TYPES.has(mimeType)) {
    throw new Error(l2WorkbenchText('imageTypeUnsupported'))
  }
  const decoded = await decodeDimensions(file)
  decoded.bitmap.close()
  return {
    blob: file,
    mimeType,
    width: decoded.width,
    height: decoded.height,
    optimized: mimeType === 'image/gif'
  }
}

export async function optimizeL2WorkbenchImage(
  image: L2WorkbenchStoredImage
): Promise<L2WorkbenchStoredImage> {
  if (image.optimized) {
    if (image.blob.size > MAX_IMAGE_BYTES) throw new Error(l2WorkbenchText('singleImageLimit'))
    return image
  }

  const decoded = await decodeDimensions(image.blob)
  try {
    const firstSize = scaledDimensions(decoded.width, decoded.height, MAX_LONG_EDGE)
    const outputType = outputMimeType(image.mimeType)
    const quality =
      image.blob.size > LARGE_IMAGE_BYTES ? 0.85 : outputType === 'image/jpeg' ? 0.9 : 0.92
    let encoded = await canvasBlob(
      decoded.bitmap,
      firstSize.width,
      firstSize.height,
      outputType,
      quality
    )
    let width = firstSize.width
    let height = firstSize.height
    const resized = width !== decoded.width || height !== decoded.height
    const jpegStoredDimensions =
      image.mimeType === 'image/jpeg' ? await readJpegStoredDimensions(image.blob) : null
    const jpegOrientationChangesDimensions =
      image.mimeType === 'image/jpeg' &&
      (jpegStoredDimensions === null ||
        jpegStoredDimensions.width !== decoded.width ||
        jpegStoredDimensions.height !== decoded.height)
    const canPreserveOriginal =
      SENDABLE_TYPES.has(image.mimeType as L2ChatImageMimeType) && !jpegOrientationChangesDimensions

    if (!resized && canPreserveOriginal && encoded.size >= image.blob.size * PRESERVE_RATIO) {
      encoded = image.blob
      width = decoded.width
      height = decoded.height
    }

    if (encoded.size > MAX_IMAGE_BYTES) {
      const retrySize = scaledDimensions(decoded.width, decoded.height, RETRY_LONG_EDGE)
      encoded = await canvasBlob(
        decoded.bitmap,
        retrySize.width,
        retrySize.height,
        outputType,
        0.82
      )
      width = retrySize.width
      height = retrySize.height
    }
    if (encoded.size > MAX_IMAGE_BYTES) throw new Error(l2WorkbenchText('compressedImageTooLarge'))

    const encodedType = normalizedMimeType(encoded)
    if (!SENDABLE_TYPES.has(encodedType as L2ChatImageMimeType)) {
      throw new Error(l2WorkbenchText('compressedTypeUnsupported'))
    }
    return {
      blob: encoded,
      mimeType: encodedType,
      width,
      height,
      optimized: true
    }
  } finally {
    decoded.bitmap.close()
  }
}

export async function toL2ChatInputImage(image: L2WorkbenchStoredImage): Promise<L2ChatInputImage> {
  if (!image.optimized) throw new Error(l2WorkbenchText('imagesPending'))
  const bytes = new Uint8Array(await image.blob.arrayBuffer())
  let binary = ''
  const chunkSize = 32 * 1024
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return {
    mimeType: image.mimeType as L2ChatImageMimeType,
    width: image.width,
    height: image.height,
    data: btoa(binary)
  }
}

export function fromL2ChatImageResponse(image: L2ChatImageGetResponse): Blob {
  return createL4Base64ImageBlob(image)
}

export function createL2WorkbenchImageAttachment(
  image: L2WorkbenchStoredImage,
  name: string,
  status: L2WorkbenchImageAttachment['status'] = image.optimized ? 'ready' : 'optimizing'
): L2WorkbenchImageAttachment {
  return {
    ...image,
    localId: createL4BrowserUuid(),
    objectUrl: URL.createObjectURL(image.blob),
    name,
    status,
    error: null
  }
}

export function revokeL2WorkbenchImageAttachment(image: L2WorkbenchImageAttachment): void {
  URL.revokeObjectURL(image.objectUrl)
}
