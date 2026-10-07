'use strict'

const { performance } = require('node:perf_hooks')

const CHECK_INTERVAL_MS = 1_000
const STARTUP_TIMEOUT_MS = 120_000
const HEARTBEAT_TIMEOUT_MS = 60_000
const HEARTBEAT_WARNING_MS = 15_000
const SHUTDOWN_TIMEOUT_MS = 20_000
const HEARTBEAT_INTERVAL_MS = 5_000
const DELAY_WARNING_MS = 1_000
const WARNING_INTERVAL_MS = 30_000

function watchManagedChild(onFailure, options = {}) {
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS
  const startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS
  let phase = 'starting'
  let deadline = Date.now() + startupTimeoutMs
  let checkedAt = Date.now()
  let checkedMonotonicAt = performance.now()
  let checkDelayMs = 0
  let heartbeatMonotonicAt = null
  let lastHeartbeat = null
  let heartbeatMissing = false
  let transportWarnedAt = -Infinity
  let clockJumpWarnedAt = -Infinity
  let disposed = false

  function diagnostics(now) {
    const heartbeatAgeMs =
      heartbeatMonotonicAt === null ? null : Math.round(performance.now() - heartbeatMonotonicAt)
    return {
      phase,
      deadlineAt: deadline,
      heartbeatAgeMs,
      checkDelayMs,
      lastHeartbeat:
        lastHeartbeat === null
          ? null
          : {
              ...lastHeartbeat,
              sampleAgeMs: lastHeartbeat.sample ? now - lastHeartbeat.sample.sentAt : null
            }
    }
  }

  function report(message, now, extra = {}) {
    options.onDiagnostic?.(message, { ...diagnostics(now), ...extra })
  }

  const timer = setInterval(() => {
    if (disposed) return
    const now = Date.now()
    const monotonicNow = performance.now()
    const elapsed = now - checkedAt
    checkDelayMs = Math.round(Math.max(0, monotonicNow - checkedMonotonicAt - intervalMs))
    checkedAt = now
    checkedMonotonicAt = monotonicNow
    // 父进程也被暂停时先给子进程恢复窗口，避免休眠/调试恢复后立即误杀。
    if (elapsed < 0 || elapsed > Math.max(intervalMs * 5, 5_000)) {
      const previousDeadlineAt = deadline
      deadline = now + timeoutForPhase()
      if (monotonicNow - clockJumpWarnedAt >= WARNING_INTERVAL_MS) {
        clockJumpWarnedAt = monotonicNow
        report('监护计时跳变，已重新给出响应窗口', now, { elapsedMs: elapsed, previousDeadlineAt })
      }
      return
    }
    if (now >= deadline) {
      const reason =
        phase === 'starting'
          ? '服务启动未在截止时间内就绪'
          : phase === 'stopping'
            ? '服务关闭未在截止时间内完成'
            : '服务事件循环持续无响应'
      const detail = diagnostics(now)
      dispose()
      onFailure(reason, detail)
      return
    }
    if (
      phase === 'ready' &&
      !heartbeatMissing &&
      monotonicNow - heartbeatMonotonicAt >= HEARTBEAT_WARNING_MS
    ) {
      heartbeatMissing = true
      report('服务心跳已超过15秒未收到', now)
    }
  }, intervalMs)
  timer.unref()

  function timeoutForPhase() {
    if (phase === 'starting') return startupTimeoutMs
    if (phase === 'stopping') return shutdownTimeoutMs
    return heartbeatTimeoutMs
  }

  function dispose() {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    lastHeartbeat = null
    heartbeatMonotonicAt = null
  }

  return {
    accept(message) {
      if (!message || typeof message !== 'object') return false
      if (message.type === 'pi-desk.supervisor-ready') {
        if (!disposed && phase !== 'stopping') {
          phase = 'ready'
          deadline = Date.now() + heartbeatTimeoutMs
          heartbeatMonotonicAt = performance.now()
          lastHeartbeat = null
          heartbeatMissing = false
        }
        return true
      }
      if (message.type === 'pi-desk.heartbeat') {
        if (!disposed && phase === 'ready') {
          const now = Date.now()
          const monotonicNow = performance.now()
          const missingMs = Math.round(monotonicNow - heartbeatMonotonicAt)
          lastHeartbeat = {
            receivedAt: now,
            transportDelayMs: message.diagnostics ? now - message.diagnostics.sentAt : null,
            sample: message.diagnostics ?? null
          }
          heartbeatMonotonicAt = monotonicNow
          deadline = now + heartbeatTimeoutMs
          if (heartbeatMissing) report('服务心跳已恢复', now, { missingMs })
          heartbeatMissing = false
          if (
            lastHeartbeat.transportDelayMs >= DELAY_WARNING_MS &&
            monotonicNow - transportWarnedAt >= WARNING_INTERVAL_MS
          ) {
            transportWarnedAt = monotonicNow
            report('服务心跳接收延迟', now)
          }
        }
        return true
      }
      if (message.type === 'pi-desk.shutting-down') {
        if (!disposed && phase !== 'stopping') {
          phase = 'stopping'
          deadline = Date.now() + shutdownTimeoutMs
        }
        return true
      }
      return false
    },
    dispose
  }
}

function startManagedHeartbeat() {
  let disposed = false
  let closing = false
  let timer = null
  let sendErrorWarnedAt = -Infinity
  const managed = process.env.PI_DESK_MANAGED_RESTART === '1' && process.connected

  function reportSendError(error, eventType) {
    // 关闭时 IPC 可以先于资源断开，不把正常拆卸记作故障。
    if (disposed || closing) return
    const now = performance.now()
    if (now - sendErrorWarnedAt < WARNING_INTERVAL_MS) return
    sendErrorWarnedAt = now
    console.warn(`[${new Date().toISOString()}] [Pi Desk][Supervisor] 服务心跳通知发送失败`, {
      servicePid: process.pid,
      eventType,
      errorCode: error.code ?? null,
      errorMessage: error.message
    })
  }

  function send(message) {
    if (!managed || disposed || !process.connected || !process.send) return
    try {
      process.send(message, (error) => {
        if (error) reportSendError(error, message.type)
      })
    } catch (error) {
      reportSendError(error, message.type)
    }
  }

  function onDisconnect() {
    if (!disposed) process.exit(1)
  }

  if (managed) {
    let previousTickAt = performance.now()
    let previousCpu = process.cpuUsage()
    let delayWarnedAt = -Infinity
    timer = setInterval(() => {
      const now = performance.now()
      const intervalMs = now - previousTickAt
      const cpu = process.cpuUsage()
      const memory = process.memoryUsage()
      const diagnostics = {
        sentAt: Date.now(),
        intervalMs: Math.round(intervalMs),
        timerDelayMs: Math.round(Math.max(0, intervalMs - HEARTBEAT_INTERVAL_MS)),
        cpuMs: Math.round((cpu.user + cpu.system - previousCpu.user - previousCpu.system) / 1_000),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed
      }
      previousTickAt = now
      previousCpu = cpu
      send({ type: 'pi-desk.heartbeat', diagnostics })
      if (
        !closing &&
        diagnostics.timerDelayMs >= DELAY_WARNING_MS &&
        now - delayWarnedAt >= WARNING_INTERVAL_MS
      ) {
        delayWarnedAt = now
        console.warn(`[${new Date().toISOString()}] [Pi Desk][Supervisor] 服务心跳定时器执行延迟`, {
          servicePid: process.pid,
          ...diagnostics
        })
      }
    }, HEARTBEAT_INTERVAL_MS)
    timer.unref()
    process.once('disconnect', onDisconnect)
  }

  return {
    ready() {
      send({ type: 'pi-desk.supervisor-ready' })
    },
    closing(source) {
      closing = true
      send({ type: 'pi-desk.shutting-down', source })
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
      process.removeListener('disconnect', onDisconnect)
    }
  }
}

module.exports = { watchManagedChild, startManagedHeartbeat }
