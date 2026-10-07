import { parentPort, workerData } from 'node:worker_threads'
import { scanUsageFiles, type UsageFileDescriptor } from './usage-scan.js'

interface UsageWorkerInput {
  files: UsageFileDescriptor[]
}

const input = workerData as UsageWorkerInput

if (!parentPort) throw new Error('用量 Worker 缺少 parentPort')

try {
  parentPort.postMessage({ results: await scanUsageFiles(input.files, 2) })
} catch (error) {
  parentPort.postMessage({
    error: error instanceof Error ? error.message : String(error)
  })
}
