import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvironmentArchiveEntryHeader } from './l4-environment-archive'

export type L4EnvironmentEntryConsumer = (
  header: EnvironmentArchiveEntryHeader,
  content: AsyncIterable<Buffer>
) => Promise<void>
export type L4EnvironmentEntryReader = (consumer: L4EnvironmentEntryConsumer) => Promise<void>

/** 预览暂存仍加密；随机密钥仅存当前服务内存，重启后必须重新输入密码预览。 */
export class L4EnvironmentPreviewCache {
  private readonly key = randomBytes(32)
  private readonly entries: {
    header: EnvironmentArchiveEntryHeader
    file: string
    nonce: Buffer
    tag: Buffer
  }[] = []

  constructor(private readonly directory: string) {}

  async capture(
    header: EnvironmentArchiveEntryHeader,
    source: AsyncIterable<Buffer>,
    consume: L4EnvironmentEntryConsumer
  ): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = join(this.directory, `${this.entries.length}.enc`)
    const handle = await open(file, 'wx', 0o600)
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    async function* tee(): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        await handle.writeFile(cipher.update(chunk))
        yield chunk
      }
    }
    const content = tee()
    try {
      await consume(header, content)
      for await (const chunk of content) {
        void chunk
      }
      await handle.writeFile(cipher.final())
      this.entries.push({ header, file, nonce, tag: cipher.getAuthTag() })
    } finally {
      await handle.close()
    }
  }

  readonly read: L4EnvironmentEntryReader = async (consume): Promise<void> => {
    for (const entry of this.entries) {
      const input = createReadStream(entry.file)
      const decipher = createDecipheriv('aes-256-gcm', this.key, entry.nonce)
      decipher.setAuthTag(entry.tag)
      input.on('error', (error) => decipher.destroy(error))
      const content = input.pipe(decipher)
      try {
        await consume(entry.header, content)
        for await (const chunk of content) {
          void chunk
        }
      } finally {
        input.destroy()
        decipher.destroy()
      }
    }
  }

  async dispose(): Promise<void> {
    this.key.fill(0)
    await rm(this.directory, { recursive: true, force: true })
  }
}
