import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectL2WorkbenchImage } from '../src/client/l2_biz/workbench/l2-workbench-chat-image'

test('截图源文件变化后，附件仍保留接收时的完整字节和图片类型', async (t) => {
  const originalDecoder = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  Object.defineProperty(globalThis, 'createImageBitmap', {
    configurable: true,
    value: async (): Promise<ImageBitmap> => ({
      width: 480,
      height: 300,
      close(): void {}
    })
  })
  t.after(() => {
    if (originalDecoder) Object.defineProperty(globalThis, 'createImageBitmap', originalDecoder)
    else Reflect.deleteProperty(globalThis, 'createImageBitmap')
  })

  for (const mimeType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    await t.test(mimeType, async () => {
      let sourceBytes = Uint8Array.of(1, 2, 3)
      const file = new File([sourceBytes], 'capture', { type: mimeType })
      // 模拟截图工具复用临时文件：File 对象不变，后续读取的底层内容已变化。
      Object.defineProperty(file, 'arrayBuffer', {
        value: async (): Promise<ArrayBuffer> => sourceBytes.slice().buffer
      })

      const image = await inspectL2WorkbenchImage(file)
      sourceBytes = Uint8Array.of(4, 5, 6)

      assert.deepEqual(new Uint8Array(await image.blob.arrayBuffer()), Uint8Array.of(1, 2, 3))
      assert.equal(image.blob.type, mimeType)
      assert.equal(image.mimeType, mimeType)
      assert.equal(image.width, 480)
      assert.equal(image.height, 300)
      assert.equal(image.optimized, mimeType === 'image/gif')
    })
  }
})
