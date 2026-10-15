import { useState } from 'react'
import { copyDesktopText, runDesktopAction } from '../l2-desktop-biz'
import type { ControlState } from '../l4-desktop-ipc'
import type { PiUpdateViewProps } from '../views/l2-pi-update-view'
import { useDesktopAction } from './l2-use-desktop-action'

export function usePiUpdate(
  state: ControlState | null,
  refresh: () => void
): {
  checking: boolean
  updating: boolean
  view: Omit<PiUpdateViewProps, 'environment'>
} {
  const check = useDesktopAction(refresh)
  const update = useDesktopAction(refresh)
  const cancellation = useDesktopAction(refresh)
  const [copied, setCopied] = useState(false)
  const [copyHint, setCopyHint] = useState('')
  const [confirmationError, setConfirmationError] = useState('')
  const checking = check.busy || state?.environment.piUpdate.status === 'checking'
  const updating = update.busy || state?.environment.piUpdate.status === 'updating'
  const error =
    confirmationError ||
    cancellation.error ||
    update.error ||
    check.error ||
    state?.environment.piUpdate.error ||
    ''
  const clearFeedback = (): void => {
    check.clearError()
    update.clearError()
    cancellation.clearError()
    setConfirmationError('')
    setCopied(false)
    setCopyHint('')
  }
  const onCheck = (): void => {
    clearFeedback()
    void check.run(() => runDesktopAction('check-pi-update'))
  }
  const onUpdate = (): void => {
    if (!state) return
    clearFeedback()
    const local = state.targets.filter((target) => target.server)
    if (local.some((target) => target.server?.status === 'starting')) {
      setConfirmationError('有本机服务正在启动，请等待启动完成或停止后再更新 Pi。')
      return
    }
    const running = local.filter((target) => target.server?.status === 'running')
    const affected = running.length
      ? running.map((target) => `• ${target.url}`).join('\n')
      : '当前没有运行中的本机服务。'
    if (
      !window.confirm(
        `更新 Pi${state.environment.piUpdate.version ? ` 至 ${state.environment.piUpdate.version}` : ''}？\n\n将暂停全部桌面托管的本机服务：\n${affected}\n\n正在执行的聊天和任务会中断，不会自动续跑。更新或取消后须通过校验，才恢复原先运行的服务；原已停止的服务不会启动。\n\nPi 是全局安装，Windows 上其他终端使用的 Pi 也会受影响，请自行结束桌面未托管的 Pi 进程。\n\n无需退出桌面程序，也不会自动更新 Pi Desk 服务包。`
      )
    )
      return
    void update.run(() => runDesktopAction('update-pi'))
  }
  const onCancel = (): void => {
    void cancellation.run(() => runDesktopAction('cancel-environment'))
  }
  const onCopy = (): void => {
    void copyDesktopText(error).then(
      () => {
        setCopied(true)
        setCopyHint('')
      },
      () => setCopyHint('当前无法自动复制，请选中问题详情中的文字复制。')
    )
  }
  return {
    checking,
    updating,
    view: {
      checking,
      updating,
      cancelling: cancellation.busy,
      error,
      copied,
      copyHint,
      onCheck,
      onUpdate,
      onCancel,
      onCopy
    }
  }
}
