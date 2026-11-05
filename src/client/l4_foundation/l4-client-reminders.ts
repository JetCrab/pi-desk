'use client'

export type L4ReminderPlatform = 'web' | 'windows' | 'macos' | 'android'
export type L4NotificationPermission = NotificationPermission | 'unsupported'

type NativeReminderRequest =
  | { action: 'permission'; request: boolean }
  | { action: 'notify'; title: string; body: string }
  | { action: 'attention' }
  | { action: 'clear' }

interface NativeReminderBridge {
  readonly platform: Exclude<L4ReminderPlatform, 'web'>
  invoke(request: NativeReminderRequest): Promise<NotificationPermission | null>
}

declare global {
  interface Window {
    readonly __PI_DESK_REMINDER__?: NativeReminderBridge
  }
}

export interface L4ClientReminderInput {
  title: string
  body: string
  system: boolean
  sound: boolean
  attention: boolean
}

let audio: AudioContext | null = null
let notification: Notification | null = null

export function readL4ReminderPlatform(): L4ReminderPlatform {
  return typeof window === 'undefined' ? 'web' : (window.__PI_DESK_REMINDER__?.platform ?? 'web')
}

export function subscribeL4ReminderPlatform(listener: () => void): () => void {
  window.addEventListener('pi-desk-reminder-ready', listener)
  return () => window.removeEventListener('pi-desk-reminder-ready', listener)
}

export async function getL4NotificationPermission(
  request = false
): Promise<L4NotificationPermission> {
  const native = window.__PI_DESK_REMINDER__
  if (native) {
    const permission = await native.invoke({ action: 'permission', request })
    if (permission === 'granted' || permission === 'denied' || permission === 'default') {
      return permission
    }
    throw new Error('客户端未返回有效的通知权限')
  }
  if (!window.isSecureContext || !('Notification' in window)) return 'unsupported'
  if (request && window.Notification.permission === 'default') {
    return window.Notification.requestPermission()
  }
  return window.Notification.permission
}

export async function prepareL4ReminderSound(): Promise<void> {
  if (!audio || audio.state === 'closed') audio = new AudioContext()
  if (audio.state === 'suspended') await audio.resume()
}

async function playSound(): Promise<void> {
  const context = audio
  if (!context || context.state !== 'running') return
  const tone = context.createOscillator()
  const volume = context.createGain()
  const start = context.currentTime
  tone.type = 'sine'
  tone.frequency.setValueAtTime(660, start)
  tone.frequency.setValueAtTime(880, start + 0.14)
  volume.gain.setValueAtTime(0, start)
  volume.gain.linearRampToValueAtTime(0.12, start + 0.02)
  volume.gain.exponentialRampToValueAtTime(0.001, start + 0.35)
  tone.connect(volume)
  volume.connect(context.destination)
  tone.onended = () => {
    tone.disconnect()
    volume.disconnect()
  }
  tone.start(start)
  tone.stop(start + 0.36)
}

async function showSystemNotification(title: string, body: string): Promise<void> {
  const native = window.__PI_DESK_REMINDER__
  if (native) {
    await native.invoke({ action: 'notify', title, body })
    return
  }
  if (!window.isSecureContext || !('Notification' in window)) return
  if (window.Notification.permission !== 'granted') return
  notification?.close()
  const current = new window.Notification(title, {
    body,
    silent: true,
    requireInteraction: false,
    tag: 'pi-desk-reminder'
  })
  notification = current
  current.onclick = () => {
    window.focus()
    current.close()
  }
  current.onclose = () => {
    if (notification === current) notification = null
    current.onclick = null
    current.onclose = null
  }
}

// 调用方决定触发时机和偏好；本入口不依赖会话、消息或插件身份。
export async function sendL4ClientReminder(input: L4ClientReminderInput): Promise<void> {
  const operations: Promise<unknown>[] = []
  if (input.system) {
    operations.push(showSystemNotification(input.title.slice(0, 120), input.body.slice(0, 320)))
  }
  if (input.sound) operations.push(playSound())
  const platform = readL4ReminderPlatform()
  if (input.attention && (platform === 'windows' || platform === 'macos')) {
    operations.push(window.__PI_DESK_REMINDER__!.invoke({ action: 'attention' }))
  }
  const results = await Promise.allSettled(operations)
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
  if (errors.length) throw new AggregateError(errors, '部分提醒未能发送')
}

export async function clearL4ClientReminder(): Promise<void> {
  notification?.close()
  notification = null
  const native = window.__PI_DESK_REMINDER__
  if (native) await native.invoke({ action: 'clear' })
}

export function disposeL4ClientReminders(): void {
  void clearL4ClientReminder().catch((cause: unknown) => {
    console.warn('[Pi Desk][Reminders] 清除提醒失败', cause)
  })
  const previous = audio
  audio = null
  if (previous && previous.state !== 'closed') {
    void previous.close().catch((cause: unknown) => {
      console.warn('[Pi Desk][Reminders] 释放提示音失败', cause)
    })
  }
}
