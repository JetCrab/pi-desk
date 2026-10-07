'use strict'

const { parseArgs } = require('node:util')
const { cliText } = require('../../l4_foundation/process/l4-pi-desk-locale.js')

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on'])

function isEnabled(value) {
  return typeof value === 'string' && TRUE_VALUES.has(value.trim().toLowerCase())
}

function parsePort(value) {
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(cliText('port', { value }))
  }
  return String(port)
}

function parseLaunchOptions(args = process.argv.slice(2), env = process.env) {
  const normalizedArgs = args[0] === 'start' ? args.slice(1) : args
  const { values } = parseArgs({
    args: normalizedArgs,
    options: {
      port: { type: 'string', short: 'p' },
      hostname: { type: 'string', short: 'H' },
      'no-open': { type: 'boolean' },
      'safe-mode': { type: 'boolean' },
      'standby-ready-file': { type: 'string' },
      'standby-activate-file': { type: 'string' }
    },
    strict: false
  })
  const hostname = values.hostname ?? env.PI_DESK_HOSTNAME ?? '127.0.0.1'
  if (!hostname || /\s/.test(hostname)) {
    throw new Error(cliText('hostname', { value: hostname }))
  }

  const standbyReadyFile = values['standby-ready-file']?.trim() || null
  const standbyActivateFile = values['standby-activate-file']?.trim() || null
  if (Boolean(standbyReadyFile) !== Boolean(standbyActivateFile)) {
    throw new Error(cliText('standby'))
  }

  return {
    port: parsePort(values.port ?? env.PORT ?? '6233'),
    hostname,
    openBrowser: !values['no-open'] && !isEnabled(env.PI_DESK_NO_OPEN),
    safeMode: Boolean(values['safe-mode']) || isEnabled(env.PI_DESK_SAFE_MODE),
    ...(standbyReadyFile
      ? {
          standbyReadyFile,
          standbyActivateFile
        }
      : {})
  }
}

module.exports = { parseLaunchOptions }
