import 'server-only'

import { getL4PiDeskDataDir } from '@server/l4_foundation/pi/l4-pi-desk-data-dir'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const LOGIN_RECORD_FILE_NAME = 'login-records.json'
const LOGIN_RECORD_LIMIT = 100

const L4LoginRecordSchema = z.object({
  loggedInAt: z.number().int().nonnegative()
})

const L4LoginRecordsSchema = z.array(L4LoginRecordSchema)

export type L4LoginRecord = z.infer<typeof L4LoginRecordSchema>

function storePath(): string {
  return join(getL4PiDeskDataDir(), LOGIN_RECORD_FILE_NAME)
}

function readRecords(path: string): L4LoginRecord[] {
  if (!existsSync(path)) return []

  try {
    return L4LoginRecordsSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
  } catch (error) {
    console.warn('[Pi Desk][LoginRecordStore] 登录记录文件无效，将重新创建', {
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return []
  }
}

export function appendL4LoginRecord(input: L4LoginRecord): void {
  const record = L4LoginRecordSchema.parse(input)
  const path = storePath()
  const records = [...readRecords(path), record].slice(-LOGIN_RECORD_LIMIT)
  mkdirSync(dirname(path), { recursive: true })

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(records, null, 2)}\n`, 'utf8')
    renameSync(temporaryPath, path)
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}
