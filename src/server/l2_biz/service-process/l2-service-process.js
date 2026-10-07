'use strict'

const { spawn } = require('node:child_process')
const { performance } = require('node:perf_hooks')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createRollingLogWriter } = require('../../l4_foundation/process/l4-pi-desk-log.js')
const { cliText } = require('../../l4_foundation/process/l4-pi-desk-locale.js')
const { watchManagedChild } = require('../../l4_foundation/process/l4-pi-desk-supervisor.js')
const { terminateManagedTree } = require('../../l4_foundation/process/l4-process-tree.js')
const { packageRoot } = require('../../l4_foundation/process/l4-package-root.js')
const { PI_RUNTIME_EXIT_CODE } = require('../../l4_foundation/pi/l4-pi-global-runtime.js')

function runServiceProcess(options) {
  let managedLog
  try {
    managedLog = createRollingLogWriter(process.env.PI_DESK_LOG_FILE)
  } catch (error) {
    console.warn(cliText('logCreate', { message: error.message }))
  }

  function writeManagedLog(chunk) {
    if (!managedLog) return
    try {
      managedLog.write(chunk)
    } catch (error) {
      managedLog = null
      process.stderr.write(`[Pi Desk][CLI] ${cliText('logWrite', { message: error.message })}\n`)
    }
  }

  function reportDiagnostic(message, details) {
    const line = `[${new Date().toISOString()}] [Pi Desk][CLI] ${message}${details ? ` ${JSON.stringify(details)}` : ''}\n`
    process.stderr.write(line)
    writeManagedLog(line)
  }

  writeManagedLog(`[${new Date().toISOString()}] Pi Desk 托管进程启动。\n`)

  const serverEntry = path.join(packageRoot, 'src/server/l1_entry/node/l1-server.ts')
  const piRuntimeImport = pathToFileURL(
    path.join(packageRoot, 'src/server/l4_foundation/pi/l4-pi-runtime-register.mjs')
  ).href
  const packageMaintenanceEntry = path.join(
    packageRoot,
    'src',
    'server',
    'l4_foundation',
    'pi',
    'l4-pi-package-maintenance-runner.mts'
  )
  let tsxImport
  let tsconfigPathsRegister
  try {
    tsxImport = require.resolve('tsx', { paths: [packageRoot] })
    tsconfigPathsRegister = require.resolve('tsconfig-paths/register', {
      paths: [packageRoot]
    })
  } catch {
    reportDiagnostic(cliText('installIncomplete'))
    process.exit(1)
  }

  const MANAGED_RESTART_EXIT_CODE = 75
  const MANAGED_RESTART_DELAY_MS = 100
  const MAINTENANCE_ERROR_MAX_CHARS = 4000
  const MAINTENANCE_TIMEOUT_MS = 120_000
  let child = null
  let maintenanceChild = null
  let restartTimer = null
  let stopping = false
  let browserOpened = false
  let maintenanceError = null
  let standbyActivationTimer = null
  const isStandby = Boolean(options.standbyReadyFile)
  let standbyActivated = !isStandby
  let safeMode = options.safeMode
  let requestChildStop = null
  const development = process.env.PI_DESK_E2E === '1' && process.env.NODE_ENV === 'development'
  const url = `http://${options.hostname}:${options.port}`

  function openBrowser() {
    if (!options.openBrowser || browserOpened) return
    browserOpened = true
    const isWindows = process.platform === 'win32'
    const isMac = process.platform === 'darwin'
    const command = isWindows ? 'cmd.exe' : isMac ? 'open' : 'xdg-open'
    const args = isWindows ? ['/c', 'start', '', url] : [url]
    const opener = spawn(command, args, {
      detached: true,
      stdio: 'ignore'
    })
    opener.on('error', (error) => {
      reportDiagnostic(cliText('browserOpen', { message: error.message }))
    })
    opener.unref()
  }

  function readMaintenanceRequest(message) {
    if (!message || typeof message !== 'object' || message.type !== 'pi-desk.plugin-maintenance') {
      return null
    }
    const requests = Array.isArray(message.maintenance)
      ? message.maintenance
      : [message.maintenance]
    if (requests.length === 0 || requests.length > 32) return null
    const sources = new Set()
    for (const maintenance of requests) {
      if (
        !maintenance ||
        typeof maintenance !== 'object' ||
        !['install', 'update', 'remove', 'reinstall'].includes(maintenance.action)
      )
        return null
      if (
        typeof maintenance.source !== 'string' ||
        !maintenance.source.trim() ||
        maintenance.source.length > 2048 ||
        sources.has(maintenance.source)
      )
        return null
      sources.add(maintenance.source)
    }
    return requests.map(({ action, source }) => ({ action, source }))
  }

  function runPackageMaintenance(maintenance) {
    return new Promise((resolveMaintenance, rejectMaintenance) => {
      const nextMaintenanceChild = spawn(
        process.execPath,
        [
          '--import',
          piRuntimeImport,
          '--import',
          pathToFileURL(tsxImport).href,
          packageMaintenanceEntry,
          maintenance.action,
          maintenance.source
        ],
        {
          cwd: packageRoot,
          env: {
            ...process.env,
            TSX_TSCONFIG_PATH: path.join(packageRoot, 'tsconfig.json')
          },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32'
        }
      )
      maintenanceChild = nextMaintenanceChild
      let stdout = ''
      let stderr = ''
      let settled = false
      let timeout = null
      const append = (current, chunk) =>
        `${current}${chunk.toString()}`.slice(-MAINTENANCE_ERROR_MAX_CHARS)
      const finish = (callback) => {
        if (settled) return
        settled = true
        if (timeout) clearTimeout(timeout)
        void terminateManagedTree(nextMaintenanceChild).then(
          () => {
            if (maintenanceChild === nextMaintenanceChild) maintenanceChild = null
            callback()
          },
          (error) => {
            stopping = true
            reportDiagnostic(`维护进程树未确认释放，停止自动启动：${error.message}`)
            rejectMaintenance(error)
            finishProcess(1)
          }
        )
      }

      nextMaintenanceChild.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk)
        process.stdout.write(chunk)
        writeManagedLog(chunk)
      })
      nextMaintenanceChild.stderr.on('data', (chunk) => {
        stderr = append(stderr, chunk)
        process.stderr.write(chunk)
        writeManagedLog(chunk)
      })
      nextMaintenanceChild.once('error', (error) => finish(() => rejectMaintenance(error)))
      timeout = setTimeout(
        () =>
          finish(() =>
            rejectMaintenance(
              new Error('包维护超过120秒，已停止；结果未确认，请检查配置，后续命令不执行')
            )
          ),
        MAINTENANCE_TIMEOUT_MS
      )
      nextMaintenanceChild.once('close', (code) => {
        finish(() => {
          if (code === 0) {
            resolveMaintenance()
            return
          }
          rejectMaintenance(
            new Error((stderr || stdout).trim() || `Pi Package 命令退出码 ${code ?? 'null'}`)
          )
        })
      })
    })
  }

  async function applyMaintenanceAndRestart(batch) {
    maintenanceError = null
    for (const [index, maintenance] of (batch ?? []).entries()) {
      if (stopping) return
      writeManagedLog(
        `[${new Date().toISOString()}] Pi Desk 服务已退出，执行维护 ${index + 1}/${batch.length}：${maintenance.action} ${maintenance.source}。\n`
      )
      try {
        await runPackageMaintenance(maintenance)
        writeManagedLog(`[${new Date().toISOString()}] Pi Package 操作完成。\n`)
      } catch (error) {
        const reason =
          error instanceof Error && error.message ? error.message : 'Pi Package 操作失败'
        maintenanceError =
          `第 ${index + 1}/${batch.length} 项失败（${maintenance.action} ${maintenance.source}），后续未执行：${reason}`.slice(
            0,
            MAINTENANCE_ERROR_MAX_CHARS
          )
        reportDiagnostic(cliText('packageFailed', { message: maintenanceError }))
        safeMode = true
        break
      }
    }
    if (stopping) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      startChild()
    }, MANAGED_RESTART_DELAY_MS)
  }

  function finishProcess(code) {
    process.exitCode = code
    if (process.connected) process.disconnect()
  }

  function startChild() {
    if (stopping) return
    let pendingMaintenance = null
    let pendingMode = null
    let standbyReady = false
    let expectedShutdown = false
    let finalizing = false
    const nextChild = spawn(
      process.execPath,
      [
        '--import',
        piRuntimeImport,
        '--require',
        tsconfigPathsRegister,
        '--import',
        pathToFileURL(tsxImport).href,
        serverEntry,
        development ? '--dev' : '--start'
      ],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          NODE_ENV: development ? 'development' : 'production',
          HOST: options.hostname,
          PORT: options.port,
          PI_DESK_MANAGED_RESTART: '1',
          PI_DESK_SAFE_MODE: safeMode ? '1' : '',
          PI_DESK_STANDBY: isStandby && !standbyActivated ? '1' : '',
          PI_DESK_PLUGIN_MAINTENANCE_ERROR: maintenanceError ?? '',
          TSX_TSCONFIG_PATH: path.join(packageRoot, 'tsconfig.json')
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
        detached: process.platform !== 'win32'
      }
    )
    child = nextChild
    const diagnosticContext = {
      parentPid: process.pid,
      servicePid: nextChild.pid ?? null,
      mode: safeMode ? 'basic' : 'normal'
    }
    reportDiagnostic('托管服务已创建', diagnosticContext)
    const supervisor = watchManagedChild(
      (reason, details) => void finalize(null, reason, details),
      {
        onDiagnostic(message, details) {
          reportDiagnostic(message, { ...diagnosticContext, ...details })
        }
      }
    )

    async function finalize(code, failure, details) {
      if (finalizing || child !== nextChild) return
      finalizing = true
      supervisor.dispose()
      requestChildStop = null
      if (standbyActivationTimer) {
        clearInterval(standbyActivationTimer)
        standbyActivationTimer = null
      }
      if (failure) reportDiagnostic(failure, { ...diagnosticContext, ...details })
      const terminationStartedAt = performance.now()
      reportDiagnostic('开始终止托管服务进程树', diagnosticContext)
      try {
        await terminateManagedTree(nextChild)
      } catch (error) {
        reportDiagnostic(`无法确认服务进程树已释放，停止恢复：${error.message}`, {
          ...diagnosticContext,
          terminationMs: Math.round(performance.now() - terminationStartedAt)
        })
        stopping = true
        finishProcess(1)
        return
      }
      reportDiagnostic('托管服务进程树已释放', {
        ...diagnosticContext,
        terminationMs: Math.round(performance.now() - terminationStartedAt),
        exitCode: nextChild.exitCode,
        signal: nextChild.signalCode
      })
      if (child === nextChild) child = null
      if (stopping || (expectedShutdown && code === 0)) {
        reportDiagnostic('托管服务主动关闭，不执行恢复', diagnosticContext)
        stopping = true
        finishProcess(0)
        return
      }
      if (code === PI_RUNTIME_EXIT_CODE) {
        reportDiagnostic('Pi Runtime 检查未通过，不执行恢复', diagnosticContext)
        stopping = true
        finishProcess(PI_RUNTIME_EXIT_CODE)
        return
      }
      if (!failure && code === MANAGED_RESTART_EXIT_CODE) {
        if (pendingMode !== null) safeMode = pendingMode === 'basic'
        if (safeMode) pendingMaintenance = null
        reportDiagnostic('Pi Desk 正在应用插件变化并重新启动。', {
          ...diagnosticContext,
          nextMode: safeMode ? 'basic' : 'normal'
        })
        void applyMaintenanceAndRestart(pendingMaintenance)
        return
      }
      if (!safeMode && !expectedShutdown && standbyActivated) {
        safeMode = true
        pendingMaintenance = null
        reportDiagnostic('服务异常，正在以基础模式恢复；不重放消息、工具或插件维护操作。', {
          ...diagnosticContext,
          reason: failure ?? '服务未声明关闭却退出',
          exitCode: code,
          signal: nextChild.signalCode
        })
        startChild()
        return
      }
      reportDiagnostic(
        '服务已停止；基础模式或未激活候选不再自动重启，请查看日志。',
        diagnosticContext
      )
      stopping = true
      finishProcess(code || 1)
    }

    requestChildStop = () => {
      expectedShutdown = true
      supervisor.accept({ type: 'pi-desk.shutting-down' })
      if (nextChild.connected) {
        nextChild.send('pi-desk.shutdown', (error) => {
          if (error) void finalize(null, error.message)
        })
      } else {
        void finalize(null, null)
      }
    }

    nextChild.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      writeManagedLog(chunk)
      if (text.includes('服务已启动')) openBrowser()
    })
    nextChild.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
      writeManagedLog(chunk)
    })
    nextChild.on('message', (message) => {
      if (finalizing || child !== nextChild) return
      if (message?.type === 'pi-desk.shutting-down') {
        expectedShutdown = message.source !== 'RESTART'
      }
      if (supervisor.accept(message)) return
      if (message?.type === 'pi-desk.restart-mode') {
        if (message.mode === 'normal' || message.mode === 'basic') pendingMode = message.mode
        else reportDiagnostic('忽略无效的重启模式。')
        return
      }
      if (isStandby && !standbyActivated && message?.type === 'pi-desk.standby-ready') {
        if (standbyReady) return
        standbyReady = true
        try {
          fs.mkdirSync(path.dirname(options.standbyReadyFile), { recursive: true })
          fs.writeFileSync(options.standbyReadyFile, 'ready\n')
          writeManagedLog(`[${new Date().toISOString()}] Pi Desk 候选服务预热完成，等待激活。\n`)
        } catch (error) {
          void finalize(null, `无法写入候选服务就绪标记：${error.message}`)
          return
        }
        standbyActivationTimer = setInterval(() => {
          if (stopping || child !== nextChild) return
          if (!fs.existsSync(options.standbyActivateFile)) return
          clearInterval(standbyActivationTimer)
          standbyActivationTimer = null
          standbyActivated = true
          writeManagedLog(`[${new Date().toISOString()}] Pi Desk 候选服务开始激活。\n`)
          nextChild.send('pi-desk.activate', (error) => {
            if (error) void finalize(null, error.message)
          })
        }, 100)
        return
      }

      const maintenance = readMaintenanceRequest(message)
      if (!maintenance) {
        reportDiagnostic('忽略了无效的服务 IPC 消息。')
        return
      }
      if (pendingMaintenance) {
        reportDiagnostic('当前服务进程重复提交插件维护请求，已保留第一条。')
        return
      }
      pendingMaintenance = maintenance
    })
    nextChild.on('error', (error) => void finalize(1, `无法启动 Pi Desk：${error.message}`))
    nextChild.on('exit', (code, signal) => {
      reportDiagnostic('Pi Desk 服务进程退出', {
        ...diagnosticContext,
        exitCode: code,
        signal
      })
      void finalize(code, signal ? `服务被信号 ${signal} 终止` : null)
    })
  }

  function stop() {
    if (stopping) return
    stopping = true
    if (restartTimer) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
    if (standbyActivationTimer) {
      clearInterval(standbyActivationTimer)
      standbyActivationTimer = null
    }
    requestChildStop?.()
    if (maintenanceChild) {
      void terminateManagedTree(maintenanceChild).then(
        () => {
          if (!child) finishProcess(0)
        },
        (error) => {
          reportDiagnostic(`维护进程清理失败：${error.message}`)
          finishProcess(1)
        }
      )
    } else if (!child) {
      finishProcess(0)
    }
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  if (process.channel) {
    process.on('message', (message) => {
      if (message === 'pi-desk.shutdown') stop()
      if (message === 'pi-desk.restart' && !stopping && child?.connected) {
        child.send(message, (error) => {
          if (error) reportDiagnostic(error.message)
        })
      }
    })
    process.on('disconnect', stop)
  }
  startChild()
}

module.exports = { runServiceProcess }
