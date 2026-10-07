import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeL4PiImage,
  L4PiImageValidationError,
  validateL4PiInputImage
} from '../src/server/l4_foundation/pi/l4-pi-image'

const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function toBase64(bytes: readonly number[]): string {
  return Buffer.from(bytes).toString('base64')
}

test('从真实字节识别 PNG/GIF/JPEG 和尺寸', () => {
  assert.deepEqual(decodeL4PiImage(PNG_1X1).metadata, {
    mimeType: 'image/png',
    width: 1,
    height: 1
  })
  assert.deepEqual(
    decodeL4PiImage(toBase64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x03, 0x00, 0x02, 0x00]))
      .metadata,
    { mimeType: 'image/gif', width: 3, height: 2 }
  )
  assert.deepEqual(
    decodeL4PiImage(
      toBase64([
        0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x02, 0x00, 0x03, 0x03, 0x01, 0x11, 0x00,
        0x02, 0x11, 0x00, 0x03, 0x11, 0x00, 0xff, 0xd9
      ])
    ).metadata,
    { mimeType: 'image/jpeg', width: 3, height: 2 }
  )
})

test('拒绝 data URL、伪造 MIME 与伪 GIF 魔数', () => {
  assert.throws(() => decodeL4PiImage(`data:image/png;base64,${PNG_1X1}`), L4PiImageValidationError)
  assert.throws(
    () =>
      validateL4PiInputImage({
        mimeType: 'image/jpeg',
        width: 1,
        height: 1,
        data: PNG_1X1
      }),
    /MIME/
  )
  assert.throws(
    () => decodeL4PiImage(toBase64([0x47, 0x49, 0x46, 0x38, 0x30, 0x61, 0x01, 0x00, 0x01, 0x00])),
    /格式不受支持/
  )
})
