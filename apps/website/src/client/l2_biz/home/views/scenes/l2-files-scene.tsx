'use client'

import { Check, FileText, Folder, GitBranch, ListFilter, RefreshCw, Search, X } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import type { ShowcaseSceneProps } from '../../l2-showcase-story'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import { DemoDevices } from '../l2-demo-devices'
import {
  Action,
  AssistantMessage,
  Chat,
  CodeView,
  Composer,
  Desk,
  FileRow,
  FileToolbar,
  IconButton,
  Modal,
  PaneHeader,
  ProcessRow,
  UserMessage
} from '../l2-demo-ui'
import { FilesProjectPreview } from './l2-files-project-preview'
import { demoFiles, demoHtml, demoExportDiff, type DemoFilePath } from './l2-files-demo-data'
import styles from './l2-files-scene.module.css'

type FileState = {
  path: DemoFilePath | null
  changed: boolean
  branch: string
  selectedBranch: string | null
  project: boolean
  branchPicker: boolean
  drawer: boolean
}
function fileFrame(step: number): FileState {
  return {
    path:
      step === 0 ? null : step === 1 ? 'README.md' : step === 2 ? 'preview.html' : 'src/export.ts',
    changed: false,
    branch: step === 10 ? 'feature/export' : 'main',
    selectedBranch: step === 9 ? 'feature/export' : null,
    project: step >= 4 && step <= 6,
    branchPicker: step === 8 || step === 9,
    drawer: step === 0
  }
}
function advanceFiles(previous: FileState, step: number): FileState {
  const view = fileFrame(step)
  return {
    ...previous,
    path: step <= 3 ? view.path : previous.path,
    changed: previous.changed,
    branch: step === 10 ? (previous.selectedBranch ?? 'feature/export') : previous.branch,
    selectedBranch: step === 9 ? 'feature/export' : previous.selectedBranch,
    project: view.project,
    branchPicker: view.branchPicker,
    drawer: view.drawer
  }
}
function FilesDevice({
  step,
  elapsed = 0,
  onStep,
  mobile
}: ShowcaseSceneProps & { mobile: boolean }): ReactElement {
  const [state, setState] = useDemoState(step, fileFrame, advanceFiles)
  const [source, setSource] = useState(false)
  const [query, setQuery] = useState('')
  const [branchQuery, setBranchQuery] = useState('')
  const [folder, setFolder] = useState(true)
  const [manual, setManual] = useState<number | null>(null)
  function patch(value: Partial<FileState>): void {
    setState((previous) => ({ ...previous, ...value }))
    setManual(step)
    onStep(step)
  }
  function openFile(path: DemoFilePath): void {
    patch({ path, drawer: false })
    setSource(false)
  }
  const fileTree = (
    <div className={styles.fileBrowser}>
      <div className={styles.projectHeader}>
        <strong>轻舟项目</strong>
        <Action label="打开仓库 Git 分支" onClick={() => patch({ branchPicker: true })}>
          <GitBranch size={14} />
          {state.branch}
        </Action>
      </div>
      <div className={styles.search}>
        <Search size={14} />
        <input
          placeholder="搜索文件"
          aria-label="搜索项目文件"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value)
            onStep(step)
          }}
        />
      </div>
      <Action
        active={state.changed}
        label="只看变更"
        onClick={() => patch({ changed: !state.changed })}
        className={styles.filter}
      >
        <ListFilter size={14} />
        只看变更<span>1</span>
      </Action>
      <div className={styles.fileList}>
        {(!query || 'src/export.ts'.includes(query)) && (
          <>
            <FileRow name="src" folder onClick={() => setFolder(!folder)} />
            {folder && (
              <div className={styles.nested}>
                <FileRow
                  name="export.ts"
                  changed
                  active={state.path === 'src/export.ts'}
                  onClick={() => openFile('src/export.ts')}
                />
              </div>
            )}
          </>
        )}
        {!state.changed &&
          (['preview.html', 'README.md'] as const)
            .filter((path) => path.includes(query))
            .map((path) => (
              <FileRow
                key={path}
                name={path}
                active={state.path === path}
                onClick={() => openFile(path)}
              />
            ))}
      </div>
    </div>
  )
  return (
    <Desk
      className={styles.desk}
      mobile={mobile}
      mobileSidebar={
        mobile &&
        (state.drawer ||
          (manual !== step && ((step >= 1 && step <= 3) || step === 7) && elapsed >= 1100))
      }
      sidebar={fileTree}
      onFiles={() => patch({ drawer: true })}
      onProjectPreview={() => patch({ project: true, drawer: false })}
      onRefreshFiles={() => onStep(step)}
    >
      <Chat
        title="开发导出功能"
        focused
        onMenu={() => patch({ drawer: true })}
        composer={<Composer branch={state.branch} onBranch={() => patch({ branchPicker: true })} />}
      >
        <UserMessage>还是包含已完成任务，文件名加上项目名称。</UserMessage>
        <ProcessRow>处理过程 · 1 次工具调用</ProcessRow>
        <AssistantMessage>
          <p>导出功能已完成。现在会包含已完成任务，文件名为 qingzhou-tasks.csv。</p>
        </AssistantMessage>
        <button
          type="button"
          className={styles.fileLink}
          aria-label="打开项目文件 README.md"
          onClick={() => openFile('README.md')}
        >
          <FileText size={14} />
          README.md
        </button>
      </Chat>
      {state.path && (
        <section className={styles.document} aria-label={`项目文件：${state.path}`}>
          <PaneHeader
            title={state.path}
            action={
              <>
                <IconButton label="打开项目文件列表" onClick={() => patch({ drawer: true })}>
                  <Folder size={16} />
                </IconButton>
                <IconButton label="关闭文件预览" onClick={() => patch({ path: null })}>
                  <X size={16} />
                </IconButton>
              </>
            }
          />
          {state.path === 'preview.html' ? (
            <div className={styles.contentToolbar}>
              <Action active={!source} onClick={() => setSource(false)}>
                预览
              </Action>
              <Action active={source} onClick={() => setSource(true)}>
                源码
              </Action>
            </div>
          ) : (
            <FileToolbar />
          )}
          <div className={styles.documentContent}>
            {state.path === 'preview.html' && !source ? (
              <iframe
                title="preview.html HTML 预览"
                sandbox="allow-scripts"
                srcDoc={demoHtml.join('\n')}
                className={styles.preview}
              />
            ) : (
              <CodeView
                lines={state.path === 'src/export.ts' ? demoExportDiff : demoFiles[state.path]}
                diff={state.path === 'src/export.ts'}
              />
            )}
          </div>
          {state.path === 'src/export.ts' && (
            <div className={styles.fileFooter}>
              HEAD ↔ 工作区<span>+2 −2</span>
            </div>
          )}
        </section>
      )}
      <FilesProjectPreview
        step={step}
        open={state.project}
        branch={state.branch}
        onInteract={() => onStep(step)}
        onClose={() => patch({ project: false })}
      />
      {state.branchPicker && (
        <Modal title="Git 分支" onClose={() => patch({ branchPicker: false })}>
          <div className={styles.repositorySummary}>
            <strong>轻舟项目</strong>
            <span>{state.branch}</span>
            <IconButton label="刷新仓库分支" onClick={() => onStep(step)}>
              <RefreshCw size={14} />
            </IconButton>
          </div>
          <div className={styles.search}>
            <Search size={14} />
            <input
              aria-label="搜索 Git 分支"
              placeholder="搜索分支"
              value={branchQuery}
              onChange={(event) => setBranchQuery(event.currentTarget.value)}
            />
          </div>
          <p className={styles.sectionLabel}>最近分支</p>
          {['main', 'feature/export']
            .filter((name) => name.includes(branchQuery))
            .map((name) => (
              <div key={name}>
                <button
                  type="button"
                  aria-label={`选择 Git 分支 ${name}`}
                  className={`${styles.branchRow} ${state.selectedBranch === name ? styles.selectedCommit : ''}`}
                  onClick={() => patch({ selectedBranch: name })}
                >
                  {name === state.branch ? <Check size={16} /> : <GitBranch size={16} />}
                  <span>{name}</span>
                  {name === state.branch && <small>当前</small>}
                </button>
                {state.selectedBranch === name && name !== state.branch && (
                  <div className={styles.branchActions}>
                    <Action onClick={() => patch({ branch: name, branchPicker: false })}>
                      切换 Git 分支
                    </Action>
                    <span>从这里创建分支</span>
                  </div>
                )}
              </div>
            ))}
        </Modal>
      )}
    </Desk>
  )
}
export function FilesScene(props: ShowcaseSceneProps): ReactElement {
  return <DemoDevices>{(mobile) => <FilesDevice {...props} mobile={mobile} />}</DemoDevices>
}
