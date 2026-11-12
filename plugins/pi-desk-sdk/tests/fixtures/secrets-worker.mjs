import { Buffer } from 'node:buffer'

process.once('message', async ({ agentDir, key, index }) => {
  try {
    const { createSecretStore } = await import('../../dist/secrets.js')
    const store = createSecretStore({ agentDir, keyProvider: async () => Buffer.from(key) })
    const references = []
    for (let offset = 0; offset < 3; offset++) {
      references.push(await store.put(`worker-${index}-${offset}`))
    }
    process.send({ references }, () => process.disconnect())
  } catch (error) {
    process.send({ error: error.message }, () => {
      process.disconnect()
      process.exitCode = 1
    })
  }
})
