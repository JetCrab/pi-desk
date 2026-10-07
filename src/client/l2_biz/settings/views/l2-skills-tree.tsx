import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { selectL4LocalizedText } from '@common/l4_foundation/locale/l4-localized-text'
import { useL4Region } from '@client/l4_foundation/locale/l4-region-provider'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCodeIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PackageIcon,
  SearchIcon
} from 'lucide-react'
import type {
  L2SkillFileGetRequest,
  L2SkillFilesListRequest,
  L2SkillFilesListResponse,
  L2SkillItem,
  L2SkillsListResponse
} from '@common/l2_biz/settings/l2-skills-contract'
import { cn } from '@client/l4_foundation/lib/l4-utils'
import { Button } from '@client/l4_foundation/ui/shadcn/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput
} from '@client/l4_foundation/ui/shadcn/input-group'
import {
  l2SkillDirectoryKey,
  l2SkillScopeKey,
  type L2SkillLoad,
  type L2SkillProject
} from '../hooks/l2-use-skills-catalog'

interface TreeProps {
  projects: readonly L2SkillProject[]
  focusedCwd: string | null
  query: string
  onQuery: (query: string) => void
  scopes: Record<string, L2SkillLoad<L2SkillsListResponse>>
  directories: Record<string, L2SkillLoad<L2SkillFilesListResponse>>
  selected: L2SkillFileGetRequest | null
  pending: L2SkillFileGetRequest | null
  onLoadScope: (cwd: string | null) => Promise<void>
  onLoadDirectory: (target: L2SkillFilesListRequest) => Promise<void>
  onOpenFile: (target: L2SkillFileGetRequest) => Promise<boolean>
}

function sameTarget(left: L2SkillFileGetRequest | null, right: L2SkillFileGetRequest): boolean {
  return Boolean(
    left && left.cwd === right.cwd && left.skillPath === right.skillPath && left.path === right.path
  )
}

function Directory({
  target,
  props,
  depth = 0,
  skillName
}: {
  target: L2SkillFilesListRequest
  props: TreeProps
  depth?: number
  skillName: string
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const state = props.directories[l2SkillDirectoryKey(target)]
  const { onLoadDirectory } = props
  useEffect(() => {
    if (!state) void onLoadDirectory(target)
  }, [state, onLoadDirectory, target])

  if (state?.error)
    return (
      <div className="px-3 py-2 text-xs text-destructive">
        {state.error}
        <Button variant="ghost" size="sm" onClick={() => void props.onLoadDirectory(target)}>
          {t('retryFolder')}
        </Button>
      </div>
    )
  if (!state?.data)
    return (
      <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
        {t('loadingFolder')}
      </p>
    )

  return (
    <div className="relative ml-5 border-l border-border/70 py-1 pl-3">
      {state.data.entries.map((entry) => {
        const path = target.path ? `${target.path}/${entry.name}` : entry.name
        const child = { ...target, path }
        if (entry.type === 'directory')
          return (
            <Folder
              key={path}
              target={child}
              props={props}
              depth={depth}
              name={entry.name}
              skillName={skillName}
            />
          )
        const selected = sameTarget(props.selected, child)
        const opening = sameTarget(props.pending, child)
        return (
          <Button
            key={path}
            variant="ghost"
            aria-label={t('skillFile', { path: `${skillName}/${path}` })}
            aria-pressed={selected}
            title={path}
            className={cn(
              'min-h-9 w-full justify-start text-left font-normal text-muted-foreground',
              selected && 'font-medium',
              opening && 'bg-muted text-foreground'
            )}
            onClick={() => void props.onOpenFile(child)}
          >
            {entry.name === 'SKILL.md' ? (
              <FileTextIcon className="size-3.5 shrink-0" />
            ) : (
              <FileCodeIcon className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {opening && <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin" />}
          </Button>
        )
      })}
      {state.data.entries.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('emptyFolder')}</p>
      )}
      {state.data.truncated && (
        <p className="px-3 py-2 text-sm text-status-warning">{t('folderTruncated')}</p>
      )}
    </div>
  )
}

function Folder({
  target,
  props,
  depth,
  name,
  skillName
}: {
  target: L2SkillFilesListRequest
  props: TreeProps
  depth: number
  name: string
  skillName: string
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const [open, setOpen] = useState(false)
  return (
    <div>
      <Button
        variant="ghost"
        aria-expanded={open}
        aria-label={t('skillFolder', { path: `${skillName}/${target.path}` })}
        className={cn(
          'min-h-9 w-full justify-start font-normal text-muted-foreground',
          open && 'bg-muted text-foreground'
        )}
        onClick={() => setOpen(!open)}
      >
        {open ? (
          <ChevronDownIcon className="size-3.5 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0" />
        )}
        <FolderIcon className="size-3.5 shrink-0" />
        <span className="truncate">{name}</span>
      </Button>
      {open && (
        <div className={depth > 3 ? '-ml-3' : undefined}>
          <Directory target={target} props={props} depth={depth + 1} skillName={skillName} />
        </div>
      )}
    </div>
  )
}

function Skill({
  cwd,
  skill,
  props
}: {
  cwd: string | null
  skill: L2SkillItem
  props: TreeProps
}): React.JSX.Element {
  const { t } = useTranslation('skills')
  const selected = props.selected?.cwd === cwd && props.selected.skillPath === skill.skillPath
  const pending = props.pending?.cwd === cwd && props.pending.skillPath === skill.skillPath
  const [expandedOverride, setExpanded] = useState<boolean | null>(null)
  const expanded = expandedOverride ?? selected
  const select = async (): Promise<void> => {
    if (expanded) {
      setExpanded(false)
      return
    }
    const path = skill.skillPath.replaceAll('\\', '/').split('/').at(-1)!
    if (await props.onOpenFile({ cwd, skillPath: skill.skillPath, path })) setExpanded(true)
  }

  return (
    <div className="py-0.5">
      <Button
        variant="ghost"
        aria-label={t('skillName', { name: skill.name })}
        aria-expanded={expanded}
        title={`${skill.description}\n${skill.skillPath}`}
        className={cn(
          'min-h-14 w-full justify-start whitespace-normal text-left',
          expanded && 'bg-accent hover:bg-accent',
          selected && 'text-foreground'
        )}
        onClick={() => void select()}
      >
        {expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{skill.name}</p>
          {skill.description && (
            <p className="mt-0.5 truncate text-xs font-normal text-muted-foreground">
              {skill.description}
            </p>
          )}
        </div>
        {pending ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : skill.packageSource ? (
          <PackageIcon
            aria-label={t('packageSkill')}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
        ) : null}
      </Button>
      {expanded && (
        <Directory
          target={{ cwd, skillPath: skill.skillPath, path: '' }}
          props={props}
          skillName={skill.name}
        />
      )}
    </div>
  )
}

function Scope({
  cwd,
  name,
  props
}: {
  cwd: string | null
  name: string
  props: TreeProps
}): React.JSX.Element | null {
  const { t } = useTranslation('skills')
  const { locale } = useL4Region()
  const activeInScope = props.selected?.cwd === cwd || props.pending?.cwd === cwd
  const [expandedOverride, setExpanded] = useState<boolean | null>(null)
  const { onLoadScope } = props
  const state = props.scopes[l2SkillScopeKey(cwd)]
  const query = props.query.trim().toLowerCase()
  const expanded = expandedOverride ?? (cwd === null || props.focusedCwd === cwd || activeInScope)
  const open = expanded || Boolean(query)
  useEffect(() => {
    if (open && !state) void onLoadScope(cwd)
  }, [cwd, open, state, onLoadScope])

  const projectMatch = `${name} ${cwd ?? ''}`.toLowerCase().includes(query)
  const skills =
    state?.data?.skills.filter(
      (skill) =>
        !query || projectMatch || `${skill.name} ${skill.description}`.toLowerCase().includes(query)
    ) ?? []
  if (query && state?.data && !skills.length && !projectMatch && !state.error) return null

  const global = cwd === null
  return (
    <section
      className="mx-2 mt-2 min-w-0 border-b pb-2"
      aria-label={global ? t('globalSkills') : t('projectSkills', { name })}
    >
      <Button
        variant="ghost"
        className="min-h-14 w-full justify-start text-left"
        aria-label={t('skillsGroup', { name: global ? t('global') : name })}
        aria-expanded={open}
        onClick={() => setExpanded(!expanded)}
      >
        {open ? (
          <ChevronDownIcon className="size-4 shrink-0" />
        ) : (
          <ChevronRightIcon className="size-4 shrink-0" />
        )}
        {global ? (
          <GlobeIcon className="size-4 shrink-0 text-primary" />
        ) : (
          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{global ? t('globalSkills') : name}</p>
          {cwd && (
            <p title={cwd} className="mt-1 truncate text-xs font-normal text-muted-foreground">
              {cwd}
            </p>
          )}
        </div>
        {state?.loading ? (
          <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : state?.data ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {query ? skills.length : state.data.skills.length}
          </span>
        ) : null}
      </Button>
      {open && (
        <div className="px-1 py-1">
          {state?.error && (
            <p className="px-3 py-2 text-xs text-destructive">
              {state.error}
              <Button variant="ghost" size="sm" onClick={() => void props.onLoadScope(cwd)}>
                {t('retryGroup')}
              </Button>
            </p>
          )}
          {skills.map((skill) => (
            <Skill key={skill.skillPath} cwd={cwd} skill={skill} props={props} />
          ))}
          {state?.data && skills.length === 0 && !state.error && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              {query ? t('noSkillMatches') : t('noSkills')}
            </p>
          )}
          {Boolean(state?.data?.diagnostics.length) && (
            <details className="mx-2 mb-1 mt-2 rounded-md bg-muted p-2 text-sm text-muted-foreground">
              <summary className="cursor-pointer text-status-warning">
                {t('diagnostics', { count: state!.data!.diagnostics.length })}
              </summary>
              <div className="mt-2 space-y-3">
                {state!.data!.diagnostics.map((item, index) => (
                  <div key={`${item.path}:${index}`}>
                    <p className="break-words">{selectL4LocalizedText(item.message, locale)}</p>
                    <p className="mt-1 break-all text-xs">{item.path}</p>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
    </section>
  )
}

export function L2SkillsTree(props: TreeProps): React.JSX.Element {
  const { t } = useTranslation('skills')
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b p-3">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon className="size-4" />
          </InputGroupAddon>
          <InputGroupInput
            aria-label={t('searchSkills')}
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
            placeholder={t('searchSkillsPlaceholder')}
          />
        </InputGroup>
      </div>
      <div className="pi-desk-chat-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain pb-4">
        <Scope cwd={null} name={t('global')} props={props} />
        <div className="flex items-center gap-2 px-4 pb-1 pt-5">
          <span className="h-px flex-1 bg-border" />
          <p className="shrink-0 text-xs font-medium text-muted-foreground">
            {t('workspaceCount', { count: props.projects.length })}
          </p>
          <span className="h-px flex-1 bg-border" />
        </div>
        {props.projects.map((project) => (
          <Scope key={project.cwd} cwd={project.cwd} name={project.projectName} props={props} />
        ))}
        {props.projects.length === 0 && (
          <p className="px-4 py-3 text-xs text-muted-foreground">{t('workspaceEmpty')}</p>
        )}
      </div>
    </div>
  )
}
