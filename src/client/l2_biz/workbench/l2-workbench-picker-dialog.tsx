'use client'

import {
  ArrowLeftIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EyeOffIcon,
  FingerprintIcon,
  FolderIcon,
  FolderOpenIcon,
  HeadingIcon,
  HistoryIcon,
  MessageSquareTextIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SearchIcon,
  UserIcon
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import type {
  L2PiDirectoryEntryListResponse,
  L2PiDirectoryListResponse,
  L2PiSessionHistoryResponse,
  L2PiSessionHistorySearchScope,
  L2PiSessionUserMessageListRequest,
  L2PiSessionUserMessageListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import {
  L4AppDialogBody,
  L4AppDialogContent,
  L4AppDialogDescription,
  L4AppDialogFooter,
  L4AppDialogHeader,
  L4AppDialogRoot,
  L4AppDialogTitle
} from '@client/l4_foundation/ui/l4-app-dialog'
import { Input } from '@client/l4_foundation/ui/shadcn/input'
import { buttonVariants } from '@client/l4_foundation/ui/shadcn/button'

export type L2WorkbenchPickerMode = 'create' | 'replace' | null
export type L2WorkbenchPickerView = 'directories' | 'history' | 'ignored' | 'browser'

export interface L2WorkbenchReplacementTarget {
  projectName: string
  sessionTitle: string | null
  sessionId: string
}

interface L2WorkbenchPickerDialogProps {
  open: boolean
  pickerMode: L2WorkbenchPickerMode
  pickerView: L2WorkbenchPickerView
  pickerCwd: string | null
  directories: L2PiDirectoryListResponse['directories']
  ignoredDirectories: L2PiDirectoryListResponse['directories']
  directoryBrowser: L2PiDirectoryEntryListResponse | null
  historySessions: L2PiSessionHistoryResponse['sessions']
  replacementTarget: L2WorkbenchReplacementTarget | null
  unavailableSessionIds: readonly string[]
  error: string | null
  loading: boolean
  creatingCwd: string | null
  replacingSessionId: string | null
  updatingIgnoreCwd: string | null
  onOpenChange: (open: boolean) => void
  onBack: () => void
  onSearchHistory: (query: string, searchIn: readonly L2PiSessionHistorySearchScope[]) => void
  onListSessionUserMessages: (
    input: L2PiSessionUserMessageListRequest,
    signal?: AbortSignal
  ) => Promise<L2PiSessionUserMessageListResponse>
  onRefresh: (query: string, searchIn: readonly L2PiSessionHistorySearchScope[]) => void
  onOpenIgnoredDirectories: () => void
  onOpenDirectoryBrowser: () => void
  onNavigateDirectory: (cwd: string | null) => void
  onSelectBrowserDirectory: (cwd: string) => void
  onReplaceDirectoryIgnore: (cwd: string, ignored: boolean) => void
  onSelectDirectory: (cwd: string) => void
  onSelectSession: (sessionId: string) => void
}

function pathName(cwd: string): string {
  const segments = cwd.replace(/[\\/]+$/, '').split(/[\\/]/)
  return segments.at(-1) || cwd
}

function historySessionTitle(
  session: L2PiSessionHistoryResponse['sessions'][number],
  t: TFunction<'workbenchPicker'>
): string {
  return (
    session.name?.trim() ||
    session.firstMessage.trim() ||
    t('sessionFallback', { id: session.sessionId.slice(0, 8) })
  )
}

function targetTitle(
  target: L2WorkbenchReplacementTarget,
  t: TFunction<'workbenchPicker'>
): string {
  return target.sessionTitle ?? t('newSession')
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase()
}

const DEFAULT_HISTORY_SEARCH_IN: readonly L2PiSessionHistorySearchScope[] = ['title', 'user']

const HISTORY_SEARCH_SCOPE_OPTIONS: ReadonlyArray<{
  value: L2PiSessionHistorySearchScope
  label: string
}> = [
  { value: 'title', label: 'scopeTitle' },
  { value: 'user', label: 'scopeUser' },
  { value: 'assistant', label: 'scopeAssistant' },
  { value: 'sessionId', label: 'Session ID' }
]

function historyMatchLabel(
  scope: L2PiSessionHistorySearchScope,
  count: number,
  t: TFunction<'workbenchPicker'>
): string {
  if (scope === 'title') return t('scopeTitle')
  if (scope === 'sessionId') return 'Session ID'
  return t(scope === 'user' ? 'scopeUserMatches' : 'scopeAssistantMatches', { count })
}

function historyMatchTone(scope: L2PiSessionHistorySearchScope): string {
  switch (scope) {
    case 'user':
      return 'bg-muted text-foreground'
    case 'assistant':
      return 'bg-muted text-foreground'
    case 'title':
      return 'bg-muted text-foreground'
    case 'sessionId':
      return 'bg-muted text-muted-foreground'
  }
}

function historyMatchMarkTone(scope: L2PiSessionHistorySearchScope): string {
  switch (scope) {
    case 'user':
      return 'bg-accent text-accent-foreground'
    case 'assistant':
      return 'bg-accent text-accent-foreground'
    case 'title':
      return 'bg-accent text-accent-foreground'
    case 'sessionId':
      return 'bg-muted-foreground/25 text-foreground'
  }
}

function HistoryMatchIcon({
  scope,
  className
}: {
  scope: L2PiSessionHistorySearchScope
  className: string
}): React.JSX.Element {
  switch (scope) {
    case 'user':
      return <UserIcon className={className} />
    case 'assistant':
      return <BotIcon className={className} />
    case 'title':
      return <HeadingIcon className={className} />
    case 'sessionId':
      return <FingerprintIcon className={className} />
  }
}

function normalizeBrowserDirectoryPath(value: string): string {
  const path = value.trim()
  if (path.length < 2) return path

  const quote = path.at(0)
  if ((quote === '"' || quote === "'") && path.at(-1) === quote) {
    return path.slice(1, -1).trim()
  }
  return path
}

function isAbsoluteBrowserDirectoryPath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/)/.test(path)
}

function highlightedText(
  text: string,
  query: string,
  markClassName = 'bg-primary/20 text-foreground'
): ReactNode {
  if (!query) return text
  const normalizedText = text.toLocaleLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let matchIndex = normalizedText.indexOf(query)
  while (matchIndex >= 0) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex))
    const matchEnd = matchIndex + query.length
    parts.push(
      <mark key={`${matchIndex}-${matchEnd}`} className={`rounded-sm px-px ${markClassName}`}>
        {text.slice(matchIndex, matchEnd)}
      </mark>
    )
    cursor = matchEnd
    matchIndex = normalizedText.indexOf(query, cursor)
  }
  if (cursor < text.length) parts.push(text.slice(cursor))
  return parts.length ? parts : text
}

interface L2ExpandedHistoryMessages {
  sessionId: string
  query: string
  messages: L2PiSessionUserMessageListResponse['messages']
  page: L2PiSessionUserMessageListResponse['page'] | null
  loading: boolean
  error: string | null
}

export function L2WorkbenchPickerDialog({
  open,
  pickerMode,
  pickerView,
  pickerCwd,
  directories,
  ignoredDirectories,
  directoryBrowser,
  historySessions,
  replacementTarget,
  unavailableSessionIds,
  error,
  loading,
  creatingCwd,
  replacingSessionId,
  updatingIgnoreCwd,
  onOpenChange,
  onBack,
  onSearchHistory,
  onListSessionUserMessages,
  onRefresh,
  onOpenIgnoredDirectories,
  onOpenDirectoryBrowser,
  onNavigateDirectory,
  onSelectBrowserDirectory,
  onReplaceDirectoryIgnore,
  onSelectDirectory,
  onSelectSession
}: L2WorkbenchPickerDialogProps): React.JSX.Element {
  const { t } = useTranslation('workbenchPicker')
  const { locale, timeZone } = useL4Region()
  const timeFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'zh-CN', {
        timeZone,
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      }),
    [locale, timeZone]
  )
  const pickerTime = (timestamp: number): string => timeFormatter.format(timestamp)
  const [search, setSearch] = useState('')
  const [searchIn, setSearchIn] =
    useState<readonly L2PiSessionHistorySearchScope[]>(DEFAULT_HISTORY_SEARCH_IN)
  const [browserPathInput, setBrowserPathInput] = useState('')
  const [expandedHistory, setExpandedHistory] = useState<L2ExpandedHistoryMessages | null>(null)
  const lastRequestedHistorySearchRef = useRef('')
  const userMessageRequestIdRef = useRef(0)
  const userMessageAbortControllerRef = useRef<AbortController | null>(null)
  const working = creatingCwd !== null || replacingSessionId !== null || updatingIgnoreCwd !== null
  const unavailableSessionIdSet = useMemo(
    () => new Set(unavailableSessionIds),
    [unavailableSessionIds]
  )
  const query = normalizeSearch(search)
  const browserPath = normalizeBrowserDirectoryPath(browserPathInput)
  const canOpenBrowserPath = isAbsoluteBrowserDirectoryPath(browserPath)
  const activeDirectories = pickerView === 'ignored' ? ignoredDirectories : directories
  const filteredDirectories = activeDirectories.filter((directory) => {
    if (!query) return true
    return normalizeSearch(`${pathName(directory.cwd)} ${directory.cwd}`).includes(query)
  })
  const filteredSessions = historySessions
  const filteredBrowserDirectories = (directoryBrowser?.directories ?? []).filter((directory) => {
    if (!query) return true
    return normalizeSearch(`${directory.name} ${directory.cwd}`).includes(query)
  })

  useEffect(() => {
    setSearch('')
    setSearchIn(DEFAULT_HISTORY_SEARCH_IN)
    setBrowserPathInput('')
    lastRequestedHistorySearchRef.current = ''
  }, [open, pickerMode, pickerCwd, pickerView])

  const historySearchKey = `${query}\u0000${searchIn.join('\u0000')}`
  useEffect(() => {
    if (
      pickerView !== 'history' ||
      !query ||
      historySearchKey === lastRequestedHistorySearchRef.current
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      lastRequestedHistorySearchRef.current = historySearchKey
      onSearchHistory(query, searchIn)
    }, 300)
    return () => window.clearTimeout(timer)
  }, [historySearchKey, onSearchHistory, pickerView, query, searchIn])

  useEffect(() => {
    userMessageRequestIdRef.current += 1
    userMessageAbortControllerRef.current?.abort()
    userMessageAbortControllerRef.current = null
    setExpandedHistory(null)
  }, [open, pickerCwd, pickerView, query])

  useEffect(
    () => () => {
      userMessageAbortControllerRef.current?.abort()
    },
    []
  )

  const loadUserMessages = async (
    sessionId: string,
    messageQuery: string,
    pageIndex: number,
    append: boolean
  ): Promise<void> => {
    if (!pickerCwd) return
    const requestId = ++userMessageRequestIdRef.current
    userMessageAbortControllerRef.current?.abort()
    const controller = new AbortController()
    userMessageAbortControllerRef.current = controller
    setExpandedHistory((current) => ({
      sessionId,
      query: messageQuery,
      messages: append && current?.sessionId === sessionId ? current.messages : [],
      page: append && current?.sessionId === sessionId ? current.page : null,
      loading: true,
      error: null
    }))
    try {
      const response = await onListSessionUserMessages(
        {
          cwd: pickerCwd,
          sessionId,
          query: messageQuery,
          page: { index: pageIndex, size: 20 }
        },
        controller.signal
      )
      if (userMessageRequestIdRef.current !== requestId) return
      setExpandedHistory((current) => ({
        sessionId,
        query: messageQuery,
        messages:
          append && current?.sessionId === sessionId
            ? [...current.messages, ...response.messages]
            : response.messages,
        page: response.page,
        loading: false,
        error: null
      }))
    } catch (cause) {
      if (
        userMessageRequestIdRef.current !== requestId ||
        (cause instanceof Error && cause.name === 'AbortError')
      ) {
        return
      }
      setExpandedHistory((current) => ({
        sessionId,
        query: messageQuery,
        messages: current?.sessionId === sessionId ? current.messages : [],
        page: current?.sessionId === sessionId ? current.page : null,
        loading: false,
        error: cause instanceof Error ? cause.message : t('loadUserFailed')
      }))
    } finally {
      if (userMessageAbortControllerRef.current === controller) {
        userMessageAbortControllerRef.current = null
      }
    }
  }

  const toggleSearchScope = (scope: L2PiSessionHistorySearchScope): void => {
    setSearchIn((current) => {
      if (current.includes(scope)) {
        return current.length === 1 ? current : current.filter((item) => item !== scope)
      }
      return [...current, scope]
    })
  }

  const toggleUserMessages = (session: L2PiSessionHistoryResponse['sessions'][number]): void => {
    if (expandedHistory?.sessionId === session.sessionId) {
      userMessageRequestIdRef.current += 1
      userMessageAbortControllerRef.current?.abort()
      userMessageAbortControllerRef.current = null
      setExpandedHistory(null)
      return
    }
    const messageQuery = session.matches?.some((match) => match.scope === 'user') ? query : ''
    void loadUserMessages(session.sessionId, messageQuery, 1, false)
  }

  const title =
    pickerView === 'ignored'
      ? t('ignoredRestoreTitle')
      : pickerView === 'browser'
        ? t('browseOtherTitle')
        : pickerMode === 'replace'
          ? t('replaceTitle')
          : t('createTitle')
  const description =
    pickerView === 'ignored'
      ? t('ignoredRestoreDescription')
      : pickerView === 'browser'
        ? t('browseDescription')
        : pickerMode === 'replace'
          ? replacementTarget
            ? t('replaceDescription', {
                project: replacementTarget.projectName,
                session: targetTitle(replacementTarget, t)
              })
            : t('replaceMissingDescription')
          : t('createDescription')
  const searchPlaceholder =
    pickerView === 'history'
      ? t('searchHistory')
      : pickerView === 'browser'
        ? t('searchBrowser')
        : pickerView === 'ignored'
          ? t('searchIgnored')
          : t('searchProjects')
  const itemCount =
    pickerView === 'history'
      ? historySessions.length
      : pickerView === 'browser'
        ? (directoryBrowser?.directories.length ?? 0)
        : activeDirectories.length
  const showInitialLoading =
    loading && (pickerView === 'browser' ? directoryBrowser === null : itemCount === 0)
  const footerDescription =
    pickerView === 'history'
      ? t('currentProject', { path: pickerCwd ?? '' })
      : pickerView === 'ignored'
        ? t('ignoredCount', { count: ignoredDirectories.length })
        : pickerView === 'browser'
          ? (directoryBrowser?.cwd ?? t('rootChoose'))
          : pickerMode === 'replace'
            ? t('replaceChooseFirst')
            : t('regularExcludesIgnored')
  const loadingText =
    pickerView === 'history'
      ? t('loadingHistory')
      : pickerView === 'ignored'
        ? t('loadingIgnored')
        : pickerView === 'browser'
          ? t('loadingBrowser')
          : t('loadingProjects')
  const handleOpenChange = (nextOpen: boolean): void => {
    if (!nextOpen && working) return
    onOpenChange(nextOpen)
  }

  const navigateBrowserDirectory = (cwd: string | null): void => {
    setSearch('')
    setBrowserPathInput('')
    onNavigateDirectory(cwd)
  }

  const openBrowserPath = (): void => {
    if (loading || working || !canOpenBrowserPath) return
    setSearch('')
    onNavigateDirectory(browserPath)
  }

  return (
    <L4AppDialogRoot open={open} onOpenChange={handleOpenChange}>
      <L4AppDialogContent
        className="h-[min(44rem,calc(100dvh-2rem))] max-w-[45rem]"
        showCloseButton={!working}
        finalFocus={false}
      >
        <L4AppDialogHeader className="border-b px-4 py-3 pr-12">
          <div className="flex min-w-0 items-center gap-2">
            {pickerView !== 'directories' ? (
              <button
                type="button"
                disabled={working}
                onClick={onBack}
                aria-label={t('backFolders')}
                title={t('backFolders')}
                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            ) : (
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <FolderIcon className="size-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <L4AppDialogTitle>{title}</L4AppDialogTitle>
              <L4AppDialogDescription className="mt-1 truncate" title={description}>
                {description}
              </L4AppDialogDescription>
            </div>
          </div>
        </L4AppDialogHeader>

        <div className="shrink-0 border-b px-3 py-2.5 sm:px-4">
          {pickerView === 'browser' ? (
            <div className="mb-2">
              <div className="flex gap-2">
                <div className="relative min-w-0 flex-1">
                  <FolderOpenIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={browserPathInput}
                    onChange={(event) => setBrowserPathInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' || !canOpenBrowserPath) return
                      event.preventDefault()
                      openBrowserPath()
                    }}
                    placeholder={t('pastePath')}
                    aria-label={t('fullPath')}
                    disabled={loading || working}
                    className="pl-9"
                  />
                </div>
                <button
                  data-testid="workbench-picker-open-directory-path"
                  type="button"
                  disabled={loading || working || !canOpenBrowserPath}
                  onClick={openBrowserPath}
                  title={canOpenBrowserPath ? t('openTyped') : t('enterAbsolute')}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('open')}
                </button>
              </div>
              <p className="mt-1.5 px-0.5 text-sm text-muted-foreground">
                {browserPathInput.trim() && !canOpenBrowserPath
                  ? t('absoluteExample')
                  : t('pasteHint')}
              </p>
            </div>
          ) : null}
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              disabled={working}
              className="pl-9"
            />
          </div>
          {pickerView === 'history' ? (
            <fieldset className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-0.5">
              <legend className="mr-1 text-xs text-muted-foreground">{t('searchScopes')}</legend>
              {HISTORY_SEARCH_SCOPE_OPTIONS.map((option) => {
                const checked = searchIn.includes(option.value)
                return (
                  <label
                    key={option.value}
                    className="flex min-h-7 cursor-pointer items-center gap-2 text-sm text-muted-foreground has-[:focus-visible]:rounded-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={working || (checked && searchIn.length === 1)}
                      onChange={() => toggleSearchScope(option.value)}
                      className="size-4 accent-primary"
                    />
                    <span>{t(option.label)}</span>
                  </label>
                )
              })}
            </fieldset>
          ) : null}
        </div>

        <L4AppDialogBody className="max-h-none min-h-0">
          <div className="p-2 sm:p-3" aria-busy={loading || working} aria-live="polite">
            {error ? (
              <p
                role="alert"
                className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {error}
              </p>
            ) : null}
            {pickerMode === 'replace' && replacementTarget === null ? (
              <p
                role="alert"
                className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                {t('replaceTargetMissing')}
              </p>
            ) : null}

            {showInitialLoading ? (
              <div className="flex min-h-36 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
                <RefreshCwIcon className="size-5 animate-spin" />
                <p>{loadingText}</p>
              </div>
            ) : pickerView === 'history' ? (
              filteredSessions.length === 0 ? (
                error === null ? (
                  <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                    {query ? t('noHistoryMatches') : t('noReplaceHistory')}
                  </p>
                ) : null
              ) : (
                <>
                  {query ? (
                    <p className="px-3 pb-1 pt-0.5 text-xs text-muted-foreground">
                      {t('sessionFound', { count: filteredSessions.length })}
                    </p>
                  ) : null}
                  <div className="divide-y">
                    {filteredSessions.map((session) => {
                      const sessionTitle = historySessionTitle(session, t)
                      const sessionMeta = t('sessionMessages', {
                        users: session.userMessageCount,
                        total: session.messageCount,
                        time: pickerTime(session.updatedAt)
                      })
                      const current = replacementTarget?.sessionId === session.sessionId
                      const unavailable = unavailableSessionIdSet.has(session.sessionId)
                      const replacing = replacingSessionId === session.sessionId
                      const targetInvalid = replacementTarget === null
                      const disabled = working || current || unavailable || targetInvalid
                      const expanded =
                        expandedHistory?.sessionId === session.sessionId ? expandedHistory : null
                      const matches = session.matches ?? []
                      const previewMatches = matches.filter((match) => match.scope !== 'title')
                      const userMatch = matches.find((match) => match.scope === 'user')
                      const showSearchPreviews = expanded === null && previewMatches.length > 0
                      const userMessagePanelId = `workbench-picker-user-message-panel-${session.sessionId}`
                      const buttonLabel = replacing
                        ? t('replacing')
                        : current
                          ? t('current')
                          : unavailable
                            ? t('alreadyUsed')
                            : targetInvalid
                              ? t('targetUnavailable')
                              : t('replace')
                      const buttonTitle = current
                        ? t('currentBound')
                        : unavailable
                          ? t('historyUsed')
                          : targetInvalid
                            ? t('replaceTargetUnavailable')
                            : t('replaceWith', { name: sessionTitle })
                      const expandLabel = expanded
                        ? t('hideUserMessages')
                        : userMatch
                          ? t('viewMatching', { count: userMatch.count })
                          : t('viewUserMessages', { count: session.userMessageCount })
                      const hasMore =
                        expanded?.page !== null &&
                        expanded !== null &&
                        expanded.messages.length < expanded.page.total

                      return (
                        <div key={session.sessionId} className="px-2 sm:px-3">
                          <div className="flex min-h-15 items-center gap-2 py-2">
                            <HistoryIcon className="size-4 shrink-0 text-muted-foreground" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium" title={sessionTitle}>
                                {matches.some((match) => match.scope === 'title')
                                  ? highlightedText(
                                      sessionTitle,
                                      query,
                                      historyMatchMarkTone('title')
                                    )
                                  : sessionTitle}
                              </p>
                              <p
                                className="mt-0.5 truncate text-xs text-muted-foreground"
                                title={sessionMeta}
                              >
                                {sessionMeta}
                              </p>
                            </div>
                            {session.userMessageCount > 0 ? (
                              <button
                                data-testid={`workbench-picker-user-messages-${session.sessionId}`}
                                type="button"
                                disabled={working}
                                aria-label={expandLabel}
                                aria-expanded={expanded !== null}
                                aria-controls={userMessagePanelId}
                                onClick={() => toggleUserMessages(session)}
                                title={expandLabel}
                                className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                              >
                                <ChevronDownIcon
                                  className={`size-4 transition-transform${expanded ? ' rotate-180' : ''}`}
                                />
                              </button>
                            ) : null}
                            <button
                              data-testid={`workbench-picker-replace-${session.sessionId}`}
                              type="button"
                              disabled={disabled}
                              onClick={() => onSelectSession(session.sessionId)}
                              title={buttonTitle}
                              className={buttonVariants({ variant: 'outline' })}
                            >
                              {replacing ? (
                                <RefreshCwIcon className="size-3.5 animate-spin" />
                              ) : (
                                buttonLabel
                              )}
                            </button>
                          </div>

                          {showSearchPreviews ? (
                            <div className="mb-2 ml-6 min-w-0 space-y-1.5 overflow-hidden">
                              {previewMatches.map((match) => {
                                const userMessageMatch = match.scope === 'user'
                                const preview = (
                                  <>
                                    <HistoryMatchIcon
                                      scope={match.scope}
                                      className="mt-0.5 size-3.5 shrink-0"
                                    />
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 items-center gap-2 text-xs leading-5">
                                        <span
                                          className={`shrink-0 rounded px-1.5 py-0.5 font-medium ${historyMatchTone(match.scope)}`}
                                        >
                                          {historyMatchLabel(match.scope, match.count, t)}
                                        </span>
                                        {match.timestampMs !== null ? (
                                          <span className="truncate text-muted-foreground">
                                            {pickerTime(match.timestampMs)}
                                          </span>
                                        ) : null}
                                      </div>
                                      <p className="mt-1 line-clamp-2 break-words text-sm leading-5 text-foreground">
                                        {highlightedText(
                                          match.preview,
                                          query,
                                          historyMatchMarkTone(match.scope)
                                        )}
                                      </p>
                                    </div>
                                  </>
                                )
                                const className = `flex w-full max-w-full min-w-0 items-start gap-2 overflow-hidden rounded-md px-2.5 py-2 text-left ${historyMatchTone(match.scope)}`
                                return userMessageMatch ? (
                                  <button
                                    key={match.scope}
                                    data-testid={`workbench-picker-user-message-preview-${session.sessionId}`}
                                    type="button"
                                    disabled={working}
                                    onClick={() => toggleUserMessages(session)}
                                    aria-label={t('viewMatch', {
                                      label: historyMatchLabel(match.scope, match.count, t)
                                    })}
                                    className={`${className} outline-none transition-colors hover:brightness-95 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50`}
                                  >
                                    {preview}
                                  </button>
                                ) : (
                                  <div key={match.scope} className={className}>
                                    {preview}
                                  </div>
                                )
                              })}
                            </div>
                          ) : null}

                          {expanded ? (
                            <div
                              id={userMessagePanelId}
                              data-testid={userMessagePanelId}
                              className="mb-2 ml-6 rounded-md border bg-background px-3 py-2.5"
                            >
                              <div className="flex min-w-0 items-center justify-between gap-2">
                                <p className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
                                  <MessageSquareTextIcon className="size-3.5 shrink-0 text-primary" />
                                  <span className="truncate">
                                    {expanded.query
                                      ? t('matchingUserCount', { count: expanded.page?.total ?? 0 })
                                      : t('userCount', {
                                          count: expanded.page?.total ?? session.userMessageCount
                                        })}
                                  </span>
                                </p>
                                {expanded.query ? (
                                  <button
                                    type="button"
                                    disabled={expanded.loading || working}
                                    onClick={() =>
                                      void loadUserMessages(session.sessionId, '', 1, false)
                                    }
                                    className={buttonVariants({ variant: 'ghost', size: 'sm' })}
                                  >
                                    {t('viewAll')}
                                  </button>
                                ) : null}
                              </div>

                              {expanded.error ? (
                                <p className="mt-2 text-xs text-destructive">{expanded.error}</p>
                              ) : null}
                              {expanded.loading && expanded.messages.length === 0 ? (
                                <div className="flex min-h-16 items-center justify-center text-muted-foreground">
                                  <RefreshCwIcon className="size-4 animate-spin" />
                                </div>
                              ) : expanded.messages.length === 0 ? (
                                <p className="py-4 text-center text-xs text-muted-foreground">
                                  {t('noUserMessages')}
                                </p>
                              ) : (
                                <div className="mt-2 divide-y">
                                  {expanded.messages.map((message) => (
                                    <div
                                      key={message.entryId}
                                      className="py-2 first:pt-0 last:pb-0"
                                    >
                                      <p className="text-xs tabular-nums text-muted-foreground">
                                        {pickerTime(message.timestampMs)}
                                      </p>
                                      <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">
                                        {message.text
                                          ? highlightedText(message.text, expanded.query)
                                          : t('noText')}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {hasMore ? (
                                <button
                                  type="button"
                                  disabled={expanded.loading || working}
                                  onClick={() =>
                                    void loadUserMessages(
                                      session.sessionId,
                                      expanded.query,
                                      (expanded.page?.index ?? 0) + 1,
                                      true
                                    )
                                  }
                                  className={buttonVariants({
                                    variant: 'outline',
                                    className: 'mt-2'
                                  })}
                                >
                                  {expanded.loading ? (
                                    <RefreshCwIcon className="size-3.5 animate-spin" />
                                  ) : null}
                                  {t('loadMore')}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      )
                    })}
                  </div>
                </>
              )
            ) : pickerView === 'browser' ? (
              <>
                <div className="mb-2 flex min-h-10 items-center gap-2 rounded-md bg-muted/60 px-3 text-xs text-muted-foreground">
                  <FolderOpenIcon className="size-4 shrink-0" />
                  <span className="truncate" title={directoryBrowser?.cwd ?? t('root')}>
                    {directoryBrowser?.cwd ?? t('root')}
                  </span>
                </div>
                {filteredBrowserDirectories.length === 0 ? (
                  error === null ? (
                    <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                      {(directoryBrowser?.directories.length ?? 0) === 0
                        ? directoryBrowser?.cwd
                          ? t('browserEmpty')
                          : t('rootsEmpty')
                        : t('subfoldersNoMatches')}
                    </p>
                  ) : null
                ) : (
                  <div className="divide-y">
                    {filteredBrowserDirectories.map((directory) => (
                      <button
                        key={directory.cwd}
                        type="button"
                        disabled={loading || working}
                        onClick={() => navigateBrowserDirectory(directory.cwd)}
                        className="group flex min-h-15 w-full items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 sm:px-3"
                      >
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-sm font-medium"
                            title={directory.name}
                          >
                            {directory.name}
                          </span>
                          <span
                            className="mt-0.5 block truncate text-xs text-muted-foreground"
                            title={directory.cwd}
                          >
                            {directory.cwd}
                          </span>
                        </span>
                        <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                      </button>
                    ))}
                  </div>
                )}
              </>
            ) : filteredDirectories.length === 0 ? (
              error === null ? (
                <p className="px-3 py-10 text-center text-sm text-muted-foreground">
                  {activeDirectories.length === 0
                    ? pickerView === 'ignored'
                      ? t('ignoredEmpty')
                      : t('projectsEmpty')
                    : t('projectNoMatches')}
                </p>
              ) : null
            ) : pickerView === 'ignored' ? (
              <div className="divide-y">
                {filteredDirectories.map((directory) => {
                  const directoryName = pathName(directory.cwd)
                  const restoring = updatingIgnoreCwd === directory.cwd

                  return (
                    <div
                      key={directory.cwd}
                      className="flex min-h-15 items-center gap-3 px-2 py-2 sm:px-3"
                    >
                      <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium" title={directoryName}>
                          {directoryName}
                        </p>
                        <p
                          className="mt-0.5 truncate text-xs text-muted-foreground"
                          title={directory.cwd}
                        >
                          {directory.cwd}
                        </p>
                      </div>
                      <button
                        data-testid={`workbench-picker-restore-directory-${directory.cwd}`}
                        type="button"
                        disabled={working}
                        onClick={() => onReplaceDirectoryIgnore(directory.cwd, false)}
                        aria-label={t('restoreFolder', { name: directoryName })}
                        title={t('restoreTip')}
                        className={buttonVariants({ variant: 'outline' })}
                      >
                        {restoring ? (
                          <RefreshCwIcon className="size-3.5 animate-spin" />
                        ) : (
                          <RotateCcwIcon className="size-3.5" />
                        )}
                        <span>{t('restore')}</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="divide-y">
                {filteredDirectories.map((directory) => {
                  const directoryName = pathName(directory.cwd)
                  const directoryMeta = t('directorySessions', {
                    count: directory.sessionCount,
                    time: pickerTime(directory.updatedAt)
                  })
                  const creating = creatingCwd === directory.cwd
                  const ignoring = updatingIgnoreCwd === directory.cwd

                  return (
                    <div key={directory.cwd} className="flex items-center gap-1">
                      <button
                        data-testid={`workbench-picker-directory-${directory.cwd}`}
                        type="button"
                        disabled={working}
                        onClick={() => onSelectDirectory(directory.cwd)}
                        className="group flex min-h-15 min-w-0 flex-1 items-center gap-3 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-55 sm:px-3"
                      >
                        <FolderIcon className="size-4 shrink-0 text-muted-foreground group-hover:text-primary" />
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-sm font-medium"
                            title={directoryName}
                          >
                            {directoryName}
                          </span>
                          <span
                            className="mt-0.5 block truncate text-xs text-muted-foreground"
                            title={directory.cwd}
                          >
                            {directory.cwd}
                          </span>
                        </span>
                        {creating ? (
                          <span className="flex min-h-10 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                            <RefreshCwIcon className="size-3.5 animate-spin" />
                            {t('creating')}
                          </span>
                        ) : (
                          <span
                            className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                            title={directoryMeta}
                          >
                            <span>{t('directoryCount', { count: directory.sessionCount })}</span>
                            <ChevronRightIcon className="size-4 group-hover:text-foreground" />
                          </span>
                        )}
                      </button>
                      {pickerMode === 'create' ? (
                        <button
                          data-testid={`workbench-picker-ignore-directory-${directory.cwd}`}
                          type="button"
                          disabled={working}
                          onClick={() => onReplaceDirectoryIgnore(directory.cwd, true)}
                          aria-label={t('ignoreFolder', { name: directoryName })}
                          title={t('ignoreTip')}
                          className={buttonVariants({ variant: 'ghost', size: 'icon' })}
                        >
                          {ignoring ? (
                            <RefreshCwIcon className="size-3.5 animate-spin" />
                          ) : (
                            <EyeOffIcon className="size-4" />
                          )}
                        </button>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </L4AppDialogBody>

        <L4AppDialogFooter className="flex-row flex-wrap items-center justify-between gap-2 px-3 py-2.5 sm:px-4">
          <p
            className="min-w-24 flex-1 truncate text-xs text-muted-foreground"
            title={footerDescription}
          >
            {footerDescription}
          </p>
          <div className="ml-auto flex items-center gap-2">
            {pickerMode === 'create' && pickerView === 'directories' ? (
              <>
                <button
                  type="button"
                  disabled={loading || working}
                  onClick={onOpenIgnoredDirectories}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('ignoredFolders')}
                </button>
                <button
                  type="button"
                  disabled={loading || working}
                  onClick={onOpenDirectoryBrowser}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('chooseOther')}
                </button>
              </>
            ) : null}
            {pickerView === 'browser' && directoryBrowser?.cwd ? (
              <button
                data-testid="workbench-picker-select-browser-directory"
                type="button"
                disabled={loading || working}
                onClick={() => onSelectBrowserDirectory(directoryBrowser.cwd!)}
                className={buttonVariants()}
              >
                {t('selectCurrent')}
              </button>
            ) : null}
            {pickerView === 'browser' && directoryBrowser?.parentCwd ? (
              <button
                type="button"
                disabled={loading || working}
                onClick={() => navigateBrowserDirectory(directoryBrowser.parentCwd)}
                aria-label={t('parentDirectory')}
                title={t('parentDirectory')}
                className={buttonVariants({ variant: 'outline', size: 'icon' })}
              >
                <ArrowLeftIcon className="size-4" />
              </button>
            ) : null}
            {pickerView === 'browser' && directoryBrowser?.cwd ? (
              <button
                type="button"
                disabled={loading || working}
                onClick={() => navigateBrowserDirectory(null)}
                aria-label={t('backRoots')}
                title={t('backRoots')}
                className={buttonVariants({ variant: 'outline', size: 'icon' })}
              >
                <FolderOpenIcon className="size-4" />
              </button>
            ) : null}
            <button
              data-testid="workbench-picker-refresh"
              type="button"
              disabled={loading || working}
              onClick={() => onRefresh(query, searchIn)}
              aria-label={t('refreshList')}
              title={t('refreshList')}
              className={buttonVariants({ variant: 'outline', size: 'icon' })}
            >
              <RefreshCwIcon className={`size-4${loading ? ' animate-spin' : ''}`} />
            </button>
          </div>
        </L4AppDialogFooter>
      </L4AppDialogContent>
    </L4AppDialogRoot>
  )
}
