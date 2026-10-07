'use strict'

const {
  getUnsupportedNodeVersionMessage,
  isNodeVersionSupported
} = require('../../l4_foundation/process/l4-node-version.js')
const { parseLaunchOptions } = require('./l1-launch-options.js')
const { runServiceProcess } = require('../../l2_biz/service-process/l2-service-process.js')

if (!isNodeVersionSupported(process.versions.node)) {
  console.error(getUnsupportedNodeVersionMessage(process.versions.node))
  process.exit(1)
}

let options
try {
  options = parseLaunchOptions()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}

runServiceProcess(options)
