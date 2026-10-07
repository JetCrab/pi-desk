'use strict'

const MIN_NODE_VERSION = '22.19.0'
const { cliText } = require('./l4-pi-desk-locale.js')

function parseNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

function isNodeVersionSupported(version) {
  const current = parseNodeVersion(version)
  const minimum = parseNodeVersion(MIN_NODE_VERSION)
  if (!current || !minimum) return false

  for (let index = 0; index < minimum.length; index += 1) {
    if (current[index] > minimum[index]) return true
    if (current[index] < minimum[index]) return false
  }
  return true
}

function getUnsupportedNodeVersionMessage(version) {
  return [
    cliText('nodeRequired', { minimum: MIN_NODE_VERSION }),
    cliText('nodeCurrent', { version })
  ].join('\n')
}

module.exports = {
  MIN_NODE_VERSION,
  getUnsupportedNodeVersionMessage,
  isNodeVersionSupported
}
