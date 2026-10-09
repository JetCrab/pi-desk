import 'server-only'

import { randomUUID } from 'node:crypto'
import type {
  L2ModelAuthProvider,
  L2ModelAuthState
} from '@common/l2_biz/model-auth/l2-model-auth-contract'
import {
  L4ModelAuth,
  L4ModelAuthError,
  type L4ModelAuthNotice,
  type L4ModelAuthPrompt
} from '@server/l4_foundation/model-auth/l4-model-auth'

export { L4ModelAuthError as L2ModelAuthError }

const LOGIN_TIMEOUT_MS = 15 * 60_000
const CATALOG_TIMEOUT_MS = 15_000
const MAX_PROVIDER_OPERATIONS = 32
// 只记录当前进程内正在运行的登录/退出；操作 finally 必须移除。
const runningProviders = new Set<string>()

interface PendingPrompt {
  id: string
  resolve(value: string): void
  reject(error: Error): void
  cleanup(): void
}

interface LoginRun {
  state: L2ModelAuthState
  abort: AbortController
  timer: ReturnType<typeof setTimeout> | null
  scheduled: ReturnType<typeof setImmediate> | null
  pending: PendingPrompt | null
}

function reserveProvider(provider: string): void {
  if (runningProviders.has(provider)) {
    throw new L4ModelAuthError(409, '该服务正在登录或退出，请等待当前操作结束')
  }
  if (runningProviders.size >= MAX_PROVIDER_OPERATIONS) {
    throw new L4ModelAuthError(429, '正在处理的账号操作过多，请稍后重试')
  }
  runningProviders.add(provider)
}

function logFailure(run: LoginRun, stage: string, error: unknown): void {
  console.warn('[Pi Desk][ModelAuth] 账号操作未完成', {
    provider: run.state.provider,
    loginId: run.state.loginId,
    stage,
    errorName: error instanceof Error ? error.name : 'UnknownError'
  })
}

export class L2ModelAuth {
  private active: LoginRun | null = null
  private disposed = false
  private readonly logoutControllers = new Set<AbortController>()

  constructor(private readonly onState: (state: L2ModelAuthState) => void) {}

  async list(): Promise<L2ModelAuthProvider[]> {
    this.assertOpen()
    const foundation = await L4ModelAuth.create()
    return foundation.list()
  }

  async start(provider: string, loginId: string): Promise<void> {
    this.assertOpen()
    if (this.active) throw new L4ModelAuthError(409, '当前连接已有登录流程，请先完成或取消')
    reserveProvider(provider)
    const run: LoginRun = {
      state: { loginId, provider, status: 'running', notice: null, prompt: null, message: null },
      abort: new AbortController(),
      timer: null,
      scheduled: null,
      pending: null
    }
    this.active = run
    run.timer = setTimeout(() => this.stop(run, true), LOGIN_TIMEOUT_MS)
    try {
      const foundation = await L4ModelAuth.create(run.abort.signal)
      const option = (await foundation.list(run.abort.signal)).find(
        (entry) => entry.provider === provider
      )
      if (!option) throw new L4ModelAuthError(400, '该服务不支持账号登录')
      if (option.conflict) throw new L4ModelAuthError(409, option.conflict)
      run.abort.signal.throwIfAborted()
      this.assertOpen()
      // 接纳响应先送出，再开始推送完整登录状态。
      run.scheduled = setImmediate(() => {
        run.scheduled = null
        void this.login(run, foundation)
      })
    } catch (error) {
      this.release(run)
      runningProviders.delete(provider)
      if (run.abort.signal.aborted) throw new L4ModelAuthError(409, '登录流程已取消或超时')
      throw error
    }
  }

  respond(loginId: string, promptId: string, value: string): void {
    const run = this.getRun(loginId)
    const pending = run.pending
    if (!pending || pending.id !== promptId) {
      throw new L4ModelAuthError(409, '该登录问题已结束，请使用当前问题')
    }
    const prompt = run.state.prompt
    if (prompt?.type === 'select' && !prompt.options?.some((option) => option.id === value)) {
      throw new L4ModelAuthError(400, '请选择当前问题提供的选项')
    }
    this.clearPrompt(run)
    pending.resolve(value)
    this.push(run)
  }

  cancel(loginId: string): void {
    this.stop(this.getRun(loginId), false)
  }

  async logout(provider: string): Promise<void> {
    this.assertOpen()
    reserveProvider(provider)
    const controller = new AbortController()
    this.logoutControllers.add(controller)
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
    try {
      const foundation = await L4ModelAuth.create(controller.signal)
      const providers = await foundation.list(controller.signal)
      const account = providers.find((entry) => entry.provider === provider)
      if (!account) throw new L4ModelAuthError(400, '该服务不支持账号登录')
      if (!account.loggedIn) throw new L4ModelAuthError(409, '该服务没有已保存的账号登录')
      controller.signal.throwIfAborted()
      await foundation.logout(provider, controller.signal)
    } catch (error) {
      console.warn('[Pi Desk][ModelAuth] 退出账号未完成', {
        provider,
        stage: 'logout',
        errorName: error instanceof Error ? error.name : 'UnknownError'
      })
      if (error instanceof L4ModelAuthError) throw error
      throw new L4ModelAuthError(
        500,
        controller.signal.aborted
          ? '退出账号已取消或超时，请重新获取账号状态'
          : '退出账号失败，请重试'
      )
    } finally {
      clearTimeout(timer)
      this.logoutControllers.delete(controller)
      runningProviders.delete(provider)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.active) this.stop(this.active, false)
    for (const controller of this.logoutControllers) controller.abort()
    this.logoutControllers.clear()
  }

  private assertOpen(): void {
    if (this.disposed) throw new L4ModelAuthError(409, '账号连接已关闭')
  }

  private getRun(loginId: string): LoginRun {
    this.assertOpen()
    const run = this.active
    if (!run || run.state.loginId !== loginId || run.state.status !== 'running') {
      throw new L4ModelAuthError(409, '登录流程已结束或不属于当前连接')
    }
    return run
  }

  private push(run: LoginRun): void {
    if (!this.disposed) this.onState({ ...run.state })
  }

  private notify(run: LoginRun, event: L4ModelAuthNotice): void {
    if (run.state.status !== 'running' || run.abort.signal.aborted) return
    if (event.type === 'progress') {
      run.state.message = event.message
      if (run.state.notice?.type !== 'auth_url' && run.state.notice?.type !== 'device_code') {
        run.state.notice = { type: 'progress', message: event.message }
      }
    } else if (event.type === 'info') {
      run.state.notice = {
        type: 'info',
        message: event.message,
        ...(event.links ? { links: event.links.map((link) => ({ ...link })) } : {})
      }
      run.state.message = event.message
    } else {
      run.state.notice =
        event.type === 'device_code'
          ? {
              type: 'device_code',
              userCode: event.userCode,
              verificationUri: event.verificationUri
            }
          : { ...event }
      run.state.message = null
    }
    this.push(run)
  }

  private prompt(run: LoginRun, prompt: L4ModelAuthPrompt): Promise<string> {
    if (run.abort.signal.aborted || run.state.status !== 'running' || prompt.signal?.aborted) {
      return Promise.reject(new DOMException('登录问题已取消', 'AbortError'))
    }
    if (run.pending) {
      const previous = run.pending
      this.clearPrompt(run)
      previous.reject(new DOMException('登录问题已替换', 'AbortError'))
    }
    return new Promise<string>((resolve, reject) => {
      const id = randomUUID()
      const onAbort = (): void => {
        if (run.pending?.id !== id) return
        this.clearPrompt(run)
        reject(new DOMException('登录问题已取消', 'AbortError'))
        if (run.state.status === 'running') this.push(run)
      }
      run.pending = {
        id,
        resolve,
        reject,
        cleanup: () => {
          run.abort.signal.removeEventListener('abort', onAbort)
          prompt.signal?.removeEventListener('abort', onAbort)
        }
      }
      run.state.prompt = {
        id,
        type: prompt.type,
        message: prompt.message,
        ...(prompt.type === 'select'
          ? { options: prompt.options.map((option) => ({ ...option })) }
          : { placeholder: prompt.placeholder })
      }
      run.abort.signal.addEventListener('abort', onAbort, { once: true })
      prompt.signal?.addEventListener('abort', onAbort, { once: true })
      this.push(run)
    })
  }

  private clearPrompt(run: LoginRun): void {
    run.pending?.cleanup()
    run.pending = null
    run.state.prompt = null
  }

  private stop(run: LoginRun, timedOut: boolean): void {
    if (run.state.status !== 'running') return
    run.state.status = timedOut ? 'error' : 'cancelled'
    run.state.message = timedOut ? '登录已超时，请重新开始' : '登录已取消'
    logFailure(run, timedOut ? 'timeout' : 'cancel', new DOMException('登录已结束', 'AbortError'))
    this.release(run)
    run.abort.abort()
    this.push(run)
    if (run.scheduled) {
      clearImmediate(run.scheduled)
      run.scheduled = null
      runningProviders.delete(run.state.provider)
    }
  }

  private release(run: LoginRun): void {
    if (run.timer) clearTimeout(run.timer)
    run.timer = null
    const pending = run.pending
    this.clearPrompt(run)
    pending?.reject(new DOMException('登录已结束', 'AbortError'))
    if (this.active === run) this.active = null
  }

  private async login(run: LoginRun, foundation: L4ModelAuth): Promise<void> {
    let stage = 'login'
    try {
      this.push(run)
      const synchronized = await foundation.login(run.state.provider, {
        signal: run.abort.signal,
        prompt: (prompt) => this.prompt(run, prompt),
        notify: (event) => this.notify(run, event)
      })
      if (run.state.status !== 'running') return
      if (!synchronized) {
        logFailure(
          run,
          'credential-sync',
          new DOMException('本地同步失败', 'CredentialSynchronizationError')
        )
      }
      stage = 'catalog'
      run.state.message = '登录成功，正在更新模型目录'
      this.push(run)
      let message = synchronized
        ? '登录成功'
        : '登录成功，但本地模型状态同步失败，请重新获取模型列表'
      const catalogAbort = new AbortController()
      const signal = AbortSignal.any([run.abort.signal, catalogAbort.signal])
      const timer = setTimeout(() => catalogAbort.abort(), CATALOG_TIMEOUT_MS)
      try {
        await foundation.refreshCatalog(run.state.provider, signal)
      } catch (error) {
        logFailure(run, stage, error)
        message = '登录成功，但模型目录刷新失败，请稍后重新获取模型列表'
      } finally {
        clearTimeout(timer)
      }
      if (run.state.status !== 'running') return
      run.state.status = 'completed'
      run.state.message = message
      this.release(run)
      this.push(run)
    } catch (error) {
      if (run.state.status !== 'running') return
      logFailure(run, stage, error)
      run.state.status = run.abort.signal.aborted ? 'cancelled' : 'error'
      run.state.message = run.abort.signal.aborted ? '登录已取消' : '登录未完成，请重试'
      this.release(run)
      this.push(run)
    } finally {
      this.release(run)
      // Pi 监听整体 signal 释放 OAuth callback；不接管 Pi 的凭据或回调服务器。
      run.abort.abort()
      runningProviders.delete(run.state.provider)
    }
  }
}
