'use client'

import {
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FileCode2Icon,
  FolderOpenIcon
} from 'lucide-react'
import { useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { L3ProjectRevealTargetType } from '@common/l3_modules/project-files/l3-project-files-contract'
import { copyL4BrowserText } from '@client/l4_foundation/lib/l4-browser-clipboard'
import { useL4AppToast } from '@client/l4_foundation/ui/l4-app-toast'
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@client/l4_foundation/ui/shadcn/context-menu'
import { L3FileContextMenuContent } from './l3-file-context-menu-content'
import { absoluteL3ProjectPath } from './l3-project-file-actions'

interface Props {
  cwd: string
  path: string
  type: L3ProjectRevealTargetType
  trigger: ReactElement
  openLabel?: string
  onOpen?: () => void
  expanded?: boolean
  onToggle?: () => void
  historical?: boolean
  oldPath?: string | null
  onReveal?: (path: string, type: L3ProjectRevealTargetType) => Promise<void>
}

export function L3ProjectPathMenu({
  cwd,
  path,
  type,
  trigger,
  openLabel,
  onOpen,
  expanded,
  onToggle,
  historical,
  oldPath,
  onReveal
}: Props): React.JSX.Element {
  const { t } = useTranslation('projectFiles')
  const toast = useL4AppToast()
  const [menuTarget, setMenuTarget] = useState<Pick<
    Props,
    'cwd' | 'path' | 'type' | 'oldPath'
  > | null>(null)
  const target = menuTarget ?? { cwd, path, type, oldPath }
  const suppressTouchClick = useRef(false)
  const lastPointer = useRef('')
  const id = type === 'file' ? 'file' : 'folder'
  const copy = (value: string): void => {
    void copyL4BrowserText(value).then((ok) => {
      if (ok) toast.success(t('copied'))
      else toast.error(t('copyFailed'))
    })
  }
  const reveal = (): void => {
    if (!onReveal) return
    void onReveal(target.path, target.type)
      .then(() => toast.success(t('revealRequested')))
      .catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : t('revealFailed'))
      })
  }
  const name =
    (target.path || target.cwd.replaceAll('\\', '/')).split('/').filter(Boolean).at(-1) ??
    target.cwd
  return (
    <ContextMenu
      onOpenChange={(open, details) => {
        setMenuTarget(open ? { cwd, path, type, oldPath } : null)
        const event = details.event
        if (
          open &&
          (lastPointer.current === 'touch' ||
            ('pointerType' in event && event.pointerType === 'touch') ||
            event.type.startsWith('touch'))
        ) {
          suppressTouchClick.current = true
        }
      }}
    >
      <ContextMenuTrigger
        render={trigger}
        data-project-path-menu-trigger=""
        onPointerDown={(event) => {
          lastPointer.current = event.pointerType
          suppressTouchClick.current = false
        }}
        onTouchEndCapture={(event) => {
          const target = event.target
          if (!menuTarget || !suppressTouchClick.current || lastPointer.current !== 'touch') return
          if (
            !(target instanceof Element) ||
            target.closest('[data-project-path-menu-trigger]') !== event.currentTarget
          )
            return
          // 仅取消已打开长按菜单的派生鼠标事件；轻点、滚动仍走默认触控路径。
          if (event.cancelable) event.preventDefault()
        }}
        onClickCapture={(event) => {
          if (suppressTouchClick.current) {
            event.preventDefault()
            event.stopPropagation()
            suppressTouchClick.current = false
          }
        }}
        onKeyDownCapture={(event) => {
          if (event.defaultPrevented || event.nativeEvent.isComposing) return
          const target = event.target
          // 目录的 Trigger 包含子树，键盘事件只能由最近的菜单节点处理。
          if (
            !(target instanceof Element) ||
            target.closest('[data-project-path-menu-trigger]') !== event.currentTarget
          )
            return
          lastPointer.current = 'keyboard'
          suppressTouchClick.current = false
          if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
          event.preventDefault()
          event.stopPropagation()
          const rect = target.getBoundingClientRect()
          event.currentTarget.dispatchEvent(
            new MouseEvent('contextmenu', {
              bubbles: true,
              cancelable: true,
              button: 2,
              clientX: rect.left + Math.min(rect.width, 120) / 2,
              clientY: rect.top + Math.min(rect.height, 36) / 2
            })
          )
        }}
      />
      <L3FileContextMenuContent>
        {onOpen ? (
          <ContextMenuItem onClick={onOpen}>
            <FileCode2Icon />
            {openLabel ?? t('openPreview')}
          </ContextMenuItem>
        ) : null}
        {onToggle ? (
          <ContextMenuItem onClick={onToggle}>
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {t(expanded ? 'collapse' : 'expand')}
          </ContextMenuItem>
        ) : null}
        {onOpen || onToggle ? <ContextMenuSeparator /> : null}
        {onReveal ? (
          <>
            <ContextMenuItem data-testid={`project-${id}-reveal-${path}`} onClick={reveal}>
              <FolderOpenIcon />
              {historical
                ? type === 'directory'
                  ? t('openCurrentWorkspace')
                  : t('locateCurrentWorkspace')
                : type === 'directory'
                  ? t('openFolder')
                  : t('openContainingFolder')}
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        ) : null}
        <ContextMenuItem
          data-testid={`project-${id}-copy-address-${path}`}
          onClick={() => copy(absoluteL3ProjectPath(target.cwd, target.path))}
        >
          <CopyIcon />
          {t('copyAbsolutePath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copy(target.path || '.')}>
          <CopyIcon />
          {t('copyRelativePath')}
        </ContextMenuItem>
        <ContextMenuItem onClick={() => copy(name)}>
          <CopyIcon />
          {t(type === 'directory' ? 'copyFolderName' : 'copyFileName')}
        </ContextMenuItem>
        {target.oldPath ? (
          <ContextMenuItem onClick={() => copy(target.oldPath!)}>
            <CopyIcon />
            {t('copyOldRelativePath')}
          </ContextMenuItem>
        ) : null}
      </L3FileContextMenuContent>
    </ContextMenu>
  )
}
