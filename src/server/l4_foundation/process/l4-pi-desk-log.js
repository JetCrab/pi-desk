'use strict'

const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_BACKUP_COUNT = 3

function createRollingLogWriter(
  filePath,
  { maxBytes = DEFAULT_MAX_BYTES, backupCount = DEFAULT_BACKUP_COUNT } = {}
) {
  if (!filePath) return null
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error('日志文件大小上限必须是正整数。')
  }
  if (!Number.isInteger(backupCount) || backupCount < 0) {
    throw new Error('日志备份数量必须是非负整数。')
  }

  const target = path.resolve(filePath)
  fs.mkdirSync(path.dirname(target), { recursive: true })

  return {
    write(chunk) {
      let content = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      if (content.length > maxBytes) {
        content = content.subarray(content.length - maxBytes)
      }

      const currentSize = fs.existsSync(target) ? fs.statSync(target).size : 0
      if (currentSize + content.length > maxBytes) {
        rotateLog(target, backupCount)
      }
      fs.appendFileSync(target, content)
    }
  }
}

function rotateLog(target, backupCount) {
  if (backupCount === 0) {
    fs.rmSync(target, { force: true })
    return
  }

  fs.rmSync(`${target}.${backupCount}`, { force: true })
  for (let index = backupCount - 1; index >= 1; index -= 1) {
    const source = `${target}.${index}`
    if (fs.existsSync(source)) {
      fs.renameSync(source, `${target}.${index + 1}`)
    }
  }
  if (fs.existsSync(target)) {
    fs.renameSync(target, `${target}.1`)
  }
}

module.exports = {
  createRollingLogWriter
}
