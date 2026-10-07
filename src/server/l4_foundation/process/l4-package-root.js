'use strict'

const { join } = require('node:path')

// 原生启动早于 Next 和 TS 路径别名，以安装位置而非调用者 cwd 定位。
const packageRoot = join(__dirname, '..', '..', '..', '..')

module.exports = { packageRoot }
