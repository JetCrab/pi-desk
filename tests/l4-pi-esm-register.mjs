import Module from 'node:module'
import * as pi from '@earendil-works/pi-coding-agent'

// 根目录 TS 测试以 CommonJS 加载，Pi 仅提供 ESM 入口；仍使用真实模块而非 Mock。
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === '@earendil-works/pi-coding-agent') return pi
  return originalLoad.call(this, request, parent, isMain)
}
