'use client'

import {
  ArrowDownToLine,
  BatteryFull,
  CornerDownLeft,
  Clock3,
  LoaderCircle,
  ListTodo,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  Folder,
  FolderTree,
  FolderSearch,
  GitBranch,
  Menu as MenuIcon,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  Paperclip,
  Pin,
  PinOff,
  Plus,
  Repeat2,
  Trash2,
  RefreshCw,
  Settings as SettingsIcon,
  Signal,
  Wifi,
  X
} from 'lucide-react'
import { motion } from 'motion/react'
import {
  Fragment,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode
} from 'react'
import { L4Otter } from '@client/l4_foundation/ui/otter/l4-otter'
import { DemoActivity } from '../hooks/l2-demo-activity'
import styles from './l2-demo-ui.module.css'

export { styles as demoStyles }

export type DemoSession = {
  id: string
  title: string
  projectName?: string
  cwd?: string
  counts?: { user: number; total: number }
  updated?: string
  running?: boolean
  pinned?: boolean
  active?: boolean
  onSelect?: () => void
  onPin?: () => void
  onDelete?: () => void
}
export type DemoShortcut = { label: string; icon?: ReactNode; onClick?: () => void }

function projectColor(cwd: string): string {
  const normalized = cwd.replaceAll('\\', '/').toLowerCase()
  let hash = 2166136261
  for (let index = 0; index < normalized.length; index++) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `light-dark(oklch(0.49 0.1 ${(hash >>> 0) % 360}), oklch(0.76 0.1 ${(hash >>> 0) % 360}))`
}

function SessionGrip({ running }: { running?: boolean }): ReactElement {
  const frames = running ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] : ['⠿']
  const dots = [
    [5, 3, 1],
    [11, 3, 8],
    [5, 8, 2],
    [11, 8, 16],
    [5, 13, 4],
    [11, 13, 32]
  ]
  return (
    <svg viewBox="0 0 16 16" className={styles.grip} aria-hidden="true">
      {frames.map((frame, index) => (
        <g
          key={frame}
          className={running ? styles.runningGrip : undefined}
          style={running ? { animationDelay: `${index * 80 - 800}ms` } : undefined}
        >
          {dots
            .filter(([, , bit]) => frame.charCodeAt(0) & bit)
            .map(([cx, cy, bit]) => (
              <circle key={bit} cx={cx} cy={cy} r="1.15" fill="currentColor" />
            ))}
        </g>
      ))}
    </svg>
  )
}

export function Action({
  children,
  onClick,
  active = false,
  primary = false,
  disabled = false,
  label,
  className = ''
}: {
  children: ReactNode
  onClick?: () => void
  active?: boolean
  primary?: boolean
  disabled?: boolean
  label?: string
  className?: string
}): ReactElement {
  return (
    <button
      type="button"
      className={`${styles.action} ${active ? styles.active : ''} ${primary ? styles.primary : ''} ${className}`}
      onClick={onClick}
      disabled={disabled || !onClick}
      aria-label={label}
      aria-pressed={active || undefined}
    >
      {children}
    </button>
  )
}

export function IconButton({
  children,
  label,
  onClick,
  active = false
}: {
  children: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
}): ReactElement {
  return (
    <Action label={label} onClick={onClick} active={active} className={styles.iconButton}>
      {children}
    </Action>
  )
}

export function Desk({
  children,
  sessions = [],
  sidebar,
  shortcuts = [],
  onSettings,
  onFiles,
  onSessions,
  onProjectPreview,
  onRefreshFiles,
  mobileSidebar = false,
  animateSessions = false,
  mobile = false,
  className = ''
}: {
  children: ReactNode
  sessions?: DemoSession[]
  sidebar?: ReactNode
  shortcuts?: DemoShortcut[]
  onSettings?: () => void
  onFiles?: () => void
  onSessions?: () => void
  onProjectPreview?: () => void
  onRefreshFiles?: () => void
  mobileSidebar?: boolean
  animateSessions?: boolean
  mobile?: boolean
  className?: string
}): ReactElement {
  const shortcutRef = useRef<HTMLDivElement>(null)
  const [columns, setColumns] = useState(3)
  useEffect(() => {
    const element = shortcutRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) =>
      setColumns(Math.max(1, Math.floor(entry.contentRect.width / 56)))
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const capacity = columns * (mobile ? 2 : 3)
  const overflow = shortcuts.length + 1 > capacity
  const visible = shortcuts.slice(0, overflow ? Math.max(0, capacity - 2) : shortcuts.length)
  const hidden = shortcuts.slice(visible.length)
  const total = visible.length + 1 + Number(overflow)
  const rowCount = Math.ceil(total / columns)
  const rowSizes = Array.from(
    { length: rowCount },
    (_, index) => Math.floor(total / rowCount) + Number(index < total % rowCount)
  )
  const items = [
    <button
      key="settings"
      type="button"
      onClick={onSettings}
      disabled={!onSettings}
      title="设置"
      aria-label="打开设置"
    >
      <SettingsIcon size={20} />
      <span>设置</span>
    </button>,
    ...visible.map((item) =>
      item.onClick ? (
        <button
          key={item.label}
          type="button"
          onClick={item.onClick}
          title={item.label}
          aria-label={`打开应用 ${item.label}`}
        >
          {item.icon ?? <FileText size={20} />}
          <span>{item.label}</span>
        </button>
      ) : (
        <span key={item.label} className={styles.shortcut} title={item.label}>
          {item.icon ?? <FileText size={20} />}
          <span>{item.label}</span>
        </span>
      )
    ),
    ...(overflow
      ? [
          <details key="more" className={styles.moreShortcuts}>
            <summary title="更多应用">
              <MoreHorizontal size={20} />
              <span>更多</span>
            </summary>
            <div>
              {hidden.map((item) =>
                item.onClick ? (
                  <button
                    key={item.label}
                    type="button"
                    onClick={item.onClick}
                    aria-label={`打开应用 ${item.label}`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ) : (
                  <span key={item.label}>
                    {item.icon}
                    <span>{item.label}</span>
                  </span>
                )
              )}
            </div>
          </details>
        ]
      : [])
  ]
  let shortcutIndex = 0
  return (
    <div className={`${styles.desk} ${className}`}>
      <aside
        className={`${styles.sidebar} ${mobileSidebar ? styles.mobileSidebar : ''}`}
        aria-label="示例会话侧栏"
      >
        <div className={styles.sidebarTop}>
          <div className={styles.segment}>
            <IconButton label="显示工作会话" onClick={onSessions} active={!sidebar}>
              <MessageSquare size={20} />
            </IconButton>
            <IconButton label="显示项目文件" onClick={onFiles} active={Boolean(sidebar)}>
              <FolderTree size={20} />
            </IconButton>
          </div>
          <span className={styles.headerActions}>
            {sidebar ? (
              <>
                <IconButton label="项目预览" onClick={onProjectPreview}>
                  <FolderSearch size={16} />
                </IconButton>
                <IconButton label="刷新项目文件" onClick={onRefreshFiles}>
                  <RefreshCw size={16} />
                </IconButton>
              </>
            ) : (
              <>
                <span className={styles.staticIcon} title="替换工作会话">
                  <Repeat2 size={16} />
                </span>
                <span className={styles.staticIcon} title="创建工作会话">
                  <Plus size={16} />
                </span>
              </>
            )}
          </span>
        </div>
        <div className={styles.sidebarBody}>
          {sidebar ??
            sessions.map((session, index) => (
              <Fragment key={session.id}>
                {session.pinned && !sessions[index - 1]?.pinned && (
                  <div className={styles.pinBoundary}>以下固定</div>
                )}
                <motion.div
                  layout={animateSessions ? 'position' : false}
                  transition={{ duration: 0.45, ease: 'easeInOut' }}
                  className={`${styles.session} ${session.active ? styles.active : ''}`}
                  data-demo-session={session.id}
                  style={
                    {
                      '--demo-project-color': projectColor(session.cwd ?? '/projects/qingzhou')
                    } as CSSProperties
                  }
                >
                  <span
                    className={styles.dragHandle}
                    title={session.running ? '运行中' : '拖动排序'}
                  >
                    <SessionGrip running={session.running} />
                  </span>
                  <div className={styles.sessionContent}>
                    <button
                      type="button"
                      className={styles.sessionSelect}
                      aria-label={`选择会话 ${session.title}`}
                      aria-current={session.active ? 'true' : undefined}
                      onClick={session.onSelect}
                      disabled={!session.onSelect}
                    >
                      <span className={styles.sessionMetadata}>
                        <span className={styles.project}>{session.projectName ?? '轻舟项目'}</span>
                        <span className={styles.counts}>
                          {session.counts?.user ?? 1}/{session.counts?.total ?? 4} ·{' '}
                          {session.updated ?? '刚刚'}
                        </span>
                      </span>
                      <strong title={session.title}>{session.title}</strong>
                    </button>
                    <span className={styles.rowActions}>
                      <IconButton
                        label={`${session.pinned ? '取消固定' : '固定'}工作会话 ${session.title}`}
                        onClick={session.onPin}
                      >
                        {session.pinned ? (
                          <PinOff size={16} className={styles.projectPin} />
                        ) : (
                          <Pin size={16} />
                        )}
                      </IconButton>
                      <IconButton
                        label={`删除工作会话 ${session.title}`}
                        onClick={session.onDelete}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </span>
                  </div>
                </motion.div>
              </Fragment>
            ))}
        </div>
        <div ref={shortcutRef} className={styles.shortcuts} aria-label="快捷入口">
          {rowSizes.map((count, index) => {
            const row = items.slice(shortcutIndex, shortcutIndex + count)
            shortcutIndex += count
            return (
              <div key={index} className={styles.shortcutRow}>
                {row}
              </div>
            )
          })}
        </div>
      </aside>
      <div className={styles.workspace}>{children}</div>
    </div>
  )
}

export function Chat({
  title = '开发导出功能',
  children,
  composer,
  onMenu,
  badge,
  projectName = '轻舟项目',
  fixed = false,
  focused = false,
  focusKey,
  onFocus,
  empty = false,
  overlay,
  autoScroll = false,
  scrollKey,
  className = ''
}: {
  title?: string
  children: ReactNode
  composer?: ReactNode
  onMenu?: () => void
  badge?: ReactNode
  projectName?: string
  fixed?: boolean
  focused?: boolean
  focusKey?: string
  onFocus?: () => void
  empty?: boolean
  overlay?: ReactNode
  autoScroll?: boolean
  scrollKey?: string | number
  className?: string
}): ReactElement {
  const active = useContext(DemoActivity)
  const messageRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (autoScroll && messageRef.current)
      messageRef.current.scrollTop = messageRef.current.scrollHeight
  }, [autoScroll, scrollKey])
  return (
    <section
      className={`${styles.chat} ${className}`}
      aria-label={`示例会话：${title}`}
      data-demo-focus={focusKey}
      data-focused={focused}
      data-fixed={fixed}
      onPointerDown={onFocus}
      onFocusCapture={onFocus}
    >
      <header className={styles.chatHeader}>
        <span className={styles.desktopMenu}>
          <PanelLeftClose size={15} />
        </span>
        <span className={styles.mobileMenu}>
          <IconButton label="打开会话列表" onClick={onMenu}>
            <MenuIcon size={17} />
          </IconButton>
        </span>
        <div>
          <span>{projectName}</span>
          <strong>{title}</strong>
        </div>
        {badge && <span className={styles.headerBadge}>{badge}</span>}
      </header>
      <div
        ref={messageRef}
        className={styles.messages}
        tabIndex={0}
        aria-label={`${title}的示例消息`}
      >
        {empty ? (
          <div className={styles.welcome} data-demo-empty-session="">
            <L4Otter state="idle" size={100} active={active} />
            <p>你负责脑洞，我负责折腾。</p>
          </div>
        ) : (
          children
        )}
      </div>
      {composer ?? <Composer />}
      {overlay}
    </section>
  )
}

export function Composer({
  draft = '',
  onDraftChange,
  onSend,
  onMore,
  onContext,
  context = '18%',
  branch = 'main',
  onBranch,
  panel,
  task,
  taskRunning = false,
  onTask
}: {
  draft?: string
  onDraftChange?: (value: string) => void
  onSend?: () => void
  onMore?: () => void
  onContext?: () => void
  context?: string
  branch?: string
  onBranch?: () => void
  panel?: ReactNode
  task?: string
  taskRunning?: boolean
  onTask?: () => void
}): ReactElement {
  return (
    <div className={styles.composerWrap}>
      {task && (
        <button
          type="button"
          className={styles.taskSummary}
          onClick={onTask}
          aria-label={`查看任务：${task}`}
        >
          {taskRunning ? (
            <LoaderCircle size={14} className={styles.taskSpinner} />
          ) : (
            <Clock3 size={14} />
          )}
          <span>{task}</span>
          <ChevronRight size={14} />
        </button>
      )}
      {panel}
      <div className={styles.composer}>
        {onDraftChange ? (
          <textarea
            aria-label="编辑示例消息"
            data-guide-target="composer-draft"
            className={`${styles.draft} ${styles.draftTextarea}`}
            value={draft}
            rows={2}
            onChange={(event) => onDraftChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                onSend
              ) {
                event.preventDefault()
                onSend()
              }
            }}
          />
        ) : (
          <div
            className={`${styles.draft} ${!draft ? styles.muted : ''}`}
            data-guide-target="composer-draft"
          >
            {draft || '输入消息，Enter 发送'}
            {draft && <span className={styles.caret} aria-hidden="true" />}
          </div>
        )}
        <div className={styles.composerTools}>
          <IconButton label="更多操作" onClick={onMore}>
            <MoreHorizontal size={16} />
          </IconButton>
          {onTask && (
            <IconButton label="打开任务中心" onClick={onTask}>
              <ListTodo size={16} />
            </IconButton>
          )}
          <span className={styles.staticIcon} title="添加图片">
            <Paperclip size={16} />
          </span>
          <button
            type="button"
            className={styles.context}
            onClick={onContext}
            disabled={!onContext}
            aria-label="查看上下文占用"
            title={`上下文 ${context}`}
          >
            <svg
              viewBox="0 0 20 20"
              width="20"
              height="20"
              aria-hidden="true"
              style={{ transform: 'rotate(-90deg)' }}
            >
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                opacity=".2"
              />
              <circle
                cx="10"
                cy="10"
                r="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeDasharray="43.98"
                strokeDashoffset={43.98 * (1 - Number.parseFloat(context) / 100)}
                strokeLinecap="round"
              />
            </svg>
          </button>
          <Action onClick={onBranch} label="Git 分支" className={styles.branch}>
            <GitBranch size={14} />
            <span>{branch}</span>
          </Action>
          <span className={styles.model}>
            <Bot size={14} />
            <span>示例模型</span>
            <ChevronDown size={12} />
          </span>
          <IconButton label="发送消息" onClick={onSend}>
            <CornerDownLeft size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  )
}

export function UserMessage({
  children,
  time
}: {
  children: ReactNode
  time?: string
}): ReactElement {
  const active = useContext(DemoActivity)
  return (
    <motion.div
      className={styles.userMessage}
      initial={active ? { opacity: 0, y: 5 } : false}
      animate={{ opacity: 1, y: 0 }}
    >
      <div>{children}</div>
      {time && <small>{time}</small>}
    </motion.div>
  )
}

export function AssistantMessage({
  children,
  usage = false
}: {
  children: ReactNode
  usage?: boolean
}): ReactElement {
  const active = useContext(DemoActivity)
  return (
    <motion.div
      className={styles.assistantMessage}
      initial={active ? { opacity: 0, y: 5 } : false}
      animate={{ opacity: 1, y: 0 }}
    >
      <div>{children}</div>
      {usage && <small>输入 1.2k / 输出 340 / 缓存 600 · 示例记录</small>}
    </motion.div>
  )
}

export function ProcessRow({
  children,
  onClick,
  expanded = false
}: {
  children: ReactNode
  onClick?: () => void
  expanded?: boolean
}): ReactElement {
  return (
    <button type="button" className={styles.process} onClick={onClick} disabled={!onClick}>
      {children}
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  )
}

export function Badge({ children }: { children: ReactNode }): ReactElement {
  return <span className={styles.badge}>{children}</span>
}

export function InfoBar({ children }: { children: ReactNode }): ReactElement {
  return <div className={styles.infoBar}>{children}</div>
}

export function Menu({ title, children }: { title?: string; children: ReactNode }): ReactElement {
  return (
    <div className={styles.menu} aria-label={title ?? '示例操作菜单'}>
      {title && <p className={styles.menuLabel}>{title}</p>}
      {children}
    </div>
  )
}

export function MenuItem({
  children,
  onClick,
  icon
}: {
  children: ReactNode
  onClick: () => void
  icon?: ReactNode
}): ReactElement {
  return (
    <button type="button" className={styles.menuItem} onClick={onClick}>
      {icon}
      {children}
    </button>
  )
}

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  intrinsic = false,
  panel = false,
  icon,
  footer
}: {
  title: string
  children: ReactNode
  onClose: () => void
  wide?: boolean
  intrinsic?: boolean
  panel?: boolean
  icon?: ReactNode
  footer?: ReactNode
}): ReactElement {
  return (
    <div className={styles.modalBackdrop}>
      <motion.section
        className={`${styles.modal} ${wide ? styles.wideModal : ''} ${intrinsic ? styles.intrinsicModal : ''} ${panel ? styles.panelModal : ''}`}
        aria-label={`${title}演示面板`}
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
      >
        <PaneHeader
          title={title}
          icon={icon}
          action={
            <IconButton label={`关闭${title}`} onClick={onClose}>
              <X size={16} />
            </IconButton>
          }
        />
        <div className={styles.modalContent} data-demo-modal-scroll="">
          {children}
        </div>
        {footer && <footer className={styles.modalFooter}>{footer}</footer>}
      </motion.section>
    </div>
  )
}

export function Settings({
  title,
  children,
  onClose,
  plugin = true,
  onPlugins,
  pages = [],
  footer
}: {
  title: string
  children: ReactNode
  onClose: () => void
  plugin?: boolean
  onPlugins?: () => void
  pages?: readonly { label: string; onSelect: () => void }[]
  footer?: ReactNode
}): ReactElement {
  const navRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if ((plugin || pages.length > 0) && navRef.current)
      navRef.current.scrollTop = navRef.current.scrollHeight
  }, [plugin, pages.length])
  return (
    <Modal title="设置" onClose={onClose} wide panel>
      <div className={styles.settings}>
        <nav ref={navRef} aria-label="示例设置分类">
          <span>外观</span>
          <span>语言与地区</span>
          <span>习惯</span>
          <span>登录保护</span>
          <span>模型</span>
          <span>能力模式</span>
          <span>技能</span>
          {plugin ? (
            <button type="button" onClick={onPlugins} disabled={!onPlugins}>
              插件
            </button>
          ) : (
            <strong>插件</strong>
          )}
          <span>关于</span>
          {(plugin || pages.length > 0) && (
            <>
              <small>插件设置</small>
              {plugin && <strong>{title}</strong>}
              {pages.map((page) => (
                <button key={page.label} type="button" onClick={page.onSelect}>
                  {page.label}
                </button>
              ))}
            </>
          )}
        </nav>
        <section>
          <div className={styles.settingsCategory}>
            <select
              data-guide-target="settings-category"
              aria-label="设置分类"
              value={plugin ? title : '插件'}
              onChange={(event) => {
                const page = pages.find((page) => page.label === event.currentTarget.value)
                if (page) page.onSelect()
                else if (event.currentTarget.value === '插件') onPlugins?.()
              }}
            >
              {plugin && <option>{title}</option>}
              <option>插件</option>
              {pages.map((page) => (
                <option key={page.label}>{page.label}</option>
              ))}
            </select>
          </div>
          <div className={styles.settingsBody}>{children}</div>
          {footer && <footer className={styles.settingsFooter}>{footer}</footer>}
        </section>
      </div>
    </Modal>
  )
}

export function PaneHeader({
  title,
  action,
  icon
}: {
  title: string
  action?: ReactNode
  icon?: ReactNode
}): ReactElement {
  return (
    <header className={`${styles.paneHeader} ${icon ? styles.applicationHeader : ''}`}>
      {icon && <span className={styles.applicationIcon}>{icon}</span>}
      <strong>{title}</strong>
      {action}
    </header>
  )
}

export function CodeView({
  lines,
  diff = false
}: {
  lines: readonly string[]
  diff?: boolean
}): ReactElement {
  return (
    <div
      className={styles.codeView}
      tabIndex={0}
      aria-label={diff ? '示例代码差异' : '示例文件源码'}
    >
      {lines.map((line, index) => (
        <div
          key={`${index}-${line}`}
          className={
            diff && line.startsWith('+')
              ? styles.added
              : diff && line.startsWith('-')
                ? styles.removed
                : ''
          }
        >
          <span>{index + 1}</span>
          <code>{line}</code>
        </div>
      ))}
    </div>
  )
}

export function FileRow({
  name,
  onClick,
  active = false,
  changed = false,
  folder = false
}: {
  name: string
  onClick: () => void
  active?: boolean
  changed?: boolean
  folder?: boolean
}): ReactElement {
  return (
    <button
      type="button"
      className={`${styles.fileRow} ${active ? styles.active : ''}`}
      aria-label={`${folder ? '切换目录' : '打开文件'} ${name}`}
      onClick={onClick}
    >
      {folder ? <Folder size={15} /> : <FileText size={15} />}
      <span>{name}</span>
      {changed && <small>M</small>}
    </button>
  )
}

export function Phone({
  children,
  label = '手机端'
}: {
  children: ReactNode
  label?: string
}): ReactElement {
  return (
    <div className={styles.phone} aria-label={label}>
      <span className={styles.phoneSideKeys} aria-hidden="true">
        <span />
        <span />
      </span>
      <span className={styles.phonePowerKey} aria-hidden="true" />
      <div className={styles.phoneScreen}>
        <div className={styles.phoneTop} aria-hidden="true">
          <span>9:41</span>
          <span className={styles.phoneCamera} />
          <span className={styles.phoneStatus}>
            <Signal size={13} />
            <Wifi size={13} />
            <BatteryFull size={16} />
          </span>
        </div>
        <div className={styles.phoneContent}>{children}</div>
        <div className={styles.phoneBottom} aria-hidden="true">
          <span />
        </div>
      </div>
    </div>
  )
}

export function CheckRow({
  children,
  checked = true,
  onClick
}: {
  children: ReactNode
  checked?: boolean
  onClick?: () => void
}): ReactElement {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={styles.checkRow}
      onClick={onClick}
      disabled={!onClick}
    >
      <span className={`${styles.checkBox} ${checked ? styles.checked : ''}`}>
        {checked && <Check size={12} />}
      </span>
      <span>{children}</span>
    </button>
  )
}

export function FileToolbar(): ReactElement {
  return (
    <div className={styles.fileToolbar} aria-hidden="true">
      <span>代码</span>
      <span>
        <Copy size={14} />
        <ArrowDownToLine size={14} />
        <RefreshCw size={14} />
      </span>
    </div>
  )
}
