#!/usr/bin/env node
'use strict'

const {
  PI_RUNTIME_EXIT_CODE,
  checkGlobalPi,
  formatPiRuntimeError
} = require('../src/server/l4_foundation/pi/l4-pi-global-runtime.js')

if (process.argv.length !== 3 || process.argv[2] !== '--check') {
  console.error('使用 --check 检查全局 Pi；此命令不会安装或更新 Pi。')
  process.exitCode = PI_RUNTIME_EXIT_CODE
} else {
  void checkGlobalPi().then(
    (result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`)
    },
    (error) => {
      console.error(`[Pi Desk][PiRuntime] ${formatPiRuntimeError(error)}`)
      process.exitCode = PI_RUNTIME_EXIT_CODE
    }
  )
}
