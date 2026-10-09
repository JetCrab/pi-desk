import { useState } from 'react'
import {
  copyDesktopText,
  openInstallHelp,
  piInstallCommand,
  prepareEnvironment,
  runDesktopAction,
  selectEnvironment
} from '../l2-desktop-biz'
import type { ControlState, TargetSnapshot } from '../l4-desktop-ipc'
import type { EnvironmentViewAction, EnvironmentViewProps } from '../views/l2-environment-view'
import { useDesktopAction } from './l2-use-desktop-action'
import { useDownloadSource } from './l2-use-download-source'

export function useEnvironmentSetup(
  state: ControlState | null,
  refresh: () => void
): {
  optionsUrl: string | null
  activeUrl: string | null
  showOptions: (url: string) => void
  onAction: (target: TargetSnapshot, input: EnvironmentViewAction) => void
  view: Omit<EnvironmentViewProps, 'environment' | 'target' | 'optionsOpen' | 'mode' | 'onAction'>
} {
  const [optionsUrl, setOptionsUrl] = useState<string | null>(null)
  const [activeUrl, setActiveUrl] = useState<string | null>(null)
  const [launching, setLaunching] = useState(false)
  const [copied, setCopied] = useState('')
  const [copyHint, setCopyHint] = useState('')
  const action = useDesktopAction(refresh)
  const cancellation = useDesktopAction(refresh)
  const { downloadSource, selectDownloadSource, markStarted } = useDownloadSource(
    Boolean(optionsUrl || state?.targets.some((target) => target.server?.needsSetup))
  )
  const installCommand = piInstallCommand(downloadSource)

  if (optionsUrl && state && !state.targets.some((target) => target.url === optionsUrl)) {
    setOptionsUrl(null)
  }
  const activeTarget = state?.targets.find((target) => target.url === activeUrl)
  if (
    activeUrl &&
    !launching &&
    state &&
    (!activeTarget ||
      (activeTarget.server?.status === 'running' && state.environment.status === 'ready'))
  ) {
    setActiveUrl(null)
    setOptionsUrl(null)
  }

  const showOptions = (url: string): void => {
    setOptionsUrl(url)
    action.clearError()
  }
  const onAction = (target: TargetSnapshot, input: EnvironmentViewAction): void => {
    if (!state) return
    setCopyHint('')
    if (input.kind === 'download-source') {
      selectDownloadSource(input.downloadSource)
      setCopied('')
    } else if (input.kind === 'options') {
      setOptionsUrl(input.open ? target.url : null)
    } else if (input.kind === 'cancel') {
      void cancellation
        .run(() =>
          state.environment.status === 'installing'
            ? runDesktopAction('cancel-environment')
            : runDesktopAction('stop', target.url)
        )
        .then((accepted) => {
          if (accepted) setActiveUrl(null)
        })
    } else if (input.kind === 'copy-error' || input.kind === 'copy-command') {
      const command = input.kind === 'copy-command'
      const text = command
        ? installCommand
        : action.error || state.environment.error || target.server?.detail || ''
      void copyDesktopText(text).then(
        () => setCopied(command ? 'command' : 'error'),
        () => setCopyHint('当前无法自动复制，请选中文字后复制。')
      )
    } else if (input.kind === 'select') {
      void action.run(() => selectEnvironment(input.component, input.archive))
    } else if (input.kind === 'help') {
      void action.run(() => openInstallHelp(input.component))
    } else if (input.kind === 'check') {
      void action.run(() => runDesktopAction('check-environment'))
    } else {
      markStarted()
      setActiveUrl(target.url)
      setOptionsUrl(null)
      setLaunching(true)
      void action
        .run(() =>
          input.kind === 'prepare'
            ? prepareEnvironment(target.url, downloadSource)
            : runDesktopAction('open', target.url)
        )
        .then((accepted) => {
          setLaunching(false)
          if (!accepted) setActiveUrl(null)
        })
    }
  }
  return {
    optionsUrl,
    activeUrl,
    showOptions,
    onAction,
    view: {
      downloadSource,
      installCommand,
      launching,
      busy: action.busy,
      cancelling: cancellation.busy,
      error: action.error || cancellation.error,
      copied,
      copyHint
    }
  }
}
