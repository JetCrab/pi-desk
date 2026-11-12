import { Buffer } from 'node:buffer'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'

process.once('message', async ({ agentDir, key, index, targetPath, eventsPath }) => {
  try {
    const { withConfigTransaction, writeConfigTextAtomic } = await import('../../dist/config.js')
    const { createSecretStore } = await import('../../dist/secrets.js')
    const store = createSecretStore({ agentDir, keyProvider: async () => Buffer.from(key) })
    const references = []
    for (let offset = 0; offset < 3; offset++) {
      // 同一文件的相对/绝对路径必须使用同一跨进程锁。
      const lockPath = index % 2 ? relative(process.cwd(), targetPath) : targetPath
      const reference = await withConfigTransaction(lockPath, async () => {
        appendFileSync(eventsPath, JSON.stringify({ phase: 'enter', index, offset }) + '\n')
        const config = JSON.parse(readFileSync(targetPath, 'utf8'))
        const next = await store.put(`worker-${index}-${offset}`)
        config.items.push(next)
        writeConfigTextAtomic(targetPath, JSON.stringify(config))
        appendFileSync(eventsPath, JSON.stringify({ phase: 'exit', index, offset }) + '\n')
        return next
      })
      references.push(reference)
    }
    process.send({ references }, () => process.disconnect())
  } catch (error) {
    process.send({ error: error.message }, () => {
      process.disconnect()
      process.exitCode = 1
    })
  }
})
