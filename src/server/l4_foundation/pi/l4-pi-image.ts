import 'server-only'

export type L4PiImageMimeType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'

export interface L4PiImageMetadata {
  mimeType: L4PiImageMimeType
  width: number
  height: number
}

export interface L4PiInputImage extends L4PiImageMetadata {
  data: string
}

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

export class L4PiImageValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L4PiImageValidationError'
  }
}

export interface L4DecodedPiImage {
  bytes: Buffer
  metadata: L4PiImageMetadata
}

function readPositiveDimension(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new L4PiImageValidationError(`图片 ${name} 无效`)
  }
  return value
}

function detectMimeType(bytes: Buffer): L4PiImageMimeType {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) {
    return 'image/gif'
  }
  if (
    bytes.length >= 16 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  throw new L4PiImageValidationError('图片格式不受支持')
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new L4PiImageValidationError('PNG 图片头无效')
  }
  return {
    width: readPositiveDimension(bytes.readUInt32BE(16), '宽度'),
    height: readPositiveDimension(bytes.readUInt32BE(20), '高度')
  }
}

function readGifDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 10) throw new L4PiImageValidationError('GIF 图片头无效')
  return {
    width: readPositiveDimension(bytes.readUInt16LE(6), '宽度'),
    height: readPositiveDimension(bytes.readUInt16LE(8), '高度')
  }
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
])

function readJpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.length) break

    const marker = bytes[offset]!
    offset += 1
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0xd9 || marker === 0xda || offset + 1 >= bytes.length) break

    const segmentLength = bytes.readUInt16BE(offset)
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (segmentLength < 7) break
      return {
        width: readPositiveDimension(bytes.readUInt16BE(offset + 5), '宽度'),
        height: readPositiveDimension(bytes.readUInt16BE(offset + 3), '高度')
      }
    }
    offset += segmentLength
  }
  throw new L4PiImageValidationError('JPEG 图片尺寸无效')
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
}

function readWebpDimensions(bytes: Buffer): { width: number; height: number } {
  const chunkType = bytes.toString('ascii', 12, 16)
  if (chunkType === 'VP8X') {
    if (bytes.length < 30) throw new L4PiImageValidationError('WebP VP8X 图片头无效')
    return {
      width: readPositiveDimension(readUInt24LE(bytes, 24) + 1, '宽度'),
      height: readPositiveDimension(readUInt24LE(bytes, 27) + 1, '高度')
    }
  }

  if (chunkType === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      throw new L4PiImageValidationError('WebP VP8L 图片头无效')
    }
    const b1 = bytes[21]!
    const b2 = bytes[22]!
    const b3 = bytes[23]!
    const b4 = bytes[24]!
    return {
      width: readPositiveDimension(1 + (((b2 & 0x3f) << 8) | b1), '宽度'),
      height: readPositiveDimension(
        1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)),
        '高度'
      )
    }
  }

  if (chunkType === 'VP8 ') {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      throw new L4PiImageValidationError('WebP VP8 图片头无效')
    }
    return {
      width: readPositiveDimension(bytes.readUInt16LE(26) & 0x3fff, '宽度'),
      height: readPositiveDimension(bytes.readUInt16LE(28) & 0x3fff, '高度')
    }
  }

  throw new L4PiImageValidationError('WebP 图片编码无效')
}

function readDimensions(
  bytes: Buffer,
  mimeType: L4PiImageMimeType
): { width: number; height: number } {
  switch (mimeType) {
    case 'image/png':
      return readPngDimensions(bytes)
    case 'image/jpeg':
      return readJpegDimensions(bytes)
    case 'image/gif':
      return readGifDimensions(bytes)
    case 'image/webp':
      return readWebpDimensions(bytes)
  }
}

export function decodeL4PiImage(data: string): L4DecodedPiImage {
  if (!data || data.startsWith('data:') || !BASE64_PATTERN.test(data)) {
    throw new L4PiImageValidationError('图片 Base64 无效')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length === 0) throw new L4PiImageValidationError('图片内容为空')
  const mimeType = detectMimeType(bytes)
  return {
    bytes,
    metadata: { mimeType, ...readDimensions(bytes, mimeType) }
  }
}

export function validateL4PiInputImage(image: L4PiInputImage): L4DecodedPiImage {
  const decoded = decodeL4PiImage(image.data)
  if (decoded.metadata.mimeType !== image.mimeType) {
    throw new L4PiImageValidationError('图片 MIME 与实际内容不一致')
  }
  if (decoded.metadata.width !== image.width || decoded.metadata.height !== image.height) {
    throw new L4PiImageValidationError('图片尺寸与实际内容不一致')
  }
  return decoded
}
