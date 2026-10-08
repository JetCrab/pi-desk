'use client'

import { FileCode2, FolderTree, GitBranch, PanelLeftClose, RefreshCw, X } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useDemoState } from '../../hooks/l2-use-demo-state'
import { Action, CodeView, FileRow, IconButton } from '../l2-demo-ui'
import { demoFiles, demoCommits, demoBranchDiff, type DemoFilePath } from './l2-files-demo-data'
import styles from './l2-files-scene.module.css'

type PreviewState = {
  page: string
  git: boolean
  path: DemoFilePath
  commit: string | null
  codeCommit: string | null
}
function previewFrame(step: number): PreviewState {
  return {
    page: step === 5 || step === 6 ? 'git' : 'code',
    git: step === 5 || step === 6,
    path: 'README.md',
    commit: step === 6 ? '8fd210a' : null,
    codeCommit: null
  }
}
export function FilesProjectPreview({
  step,
  open,
  branch,
  onClose,
  onInteract
}: {
  step: number
  open: boolean
  branch: string
  onClose: () => void
  onInteract: () => void
}): ReactElement | null {
  const [state, setState] = useDemoState(step, previewFrame, (previous, next) =>
    next === 4
      ? previous
      : next === 5
        ? { ...previous, git: true, page: 'git' }
        : next === 6
          ? { ...previous, commit: '8fd210a' }
          : previous
  )
  const [directory, setDirectory] = useState(true)
  const [mode, setMode] = useState('history')
  const [base, setBase] = useState('main')
  const [compare, setCompare] = useState('feature/export')
  const [query, setQuery] = useState('')
  function patch(value: Partial<PreviewState>): void {
    setState((previous) => ({ ...previous, ...value }))
    onInteract()
  }
  function openFile(path: DemoFilePath): void {
    patch({ path, page: 'code', codeCommit: null })
  }
  const commit = demoCommits.find((item) => item.id === state.commit)
  const codeCommit = demoCommits.find((item) => item.id === state.codeCommit)
  if (!open) return null
  return (
    <div className={styles.previewBackdrop}>
      <section
        className={styles.projectPreview}
        aria-label="项目预览演示面板"
        data-page={state.page}
        data-git={state.git}
        data-directory={directory}
      >
        <header className={styles.projectPreviewHeader}>
          <IconButton label="收起项目预览目录" onClick={() => setDirectory(!directory)}>
            <PanelLeftClose size={16} />
          </IconButton>
          <div>
            <strong>轻舟项目</strong>
            <span>/projects/qingzhou</span>
          </div>
          <Action
            active={state.git}
            label="查看 Git 记录"
            onClick={() => patch({ git: !state.git, page: state.git ? 'code' : 'git' })}
          >
            <GitBranch size={16} />
            <span>Git 记录</span>
          </Action>
          <IconButton label="刷新项目预览" onClick={onInteract}>
            <RefreshCw size={16} />
          </IconButton>
          <IconButton label="关闭项目预览" onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        <div className={styles.previewPages}>
          <Action active={state.page === 'files'} onClick={() => patch({ page: 'files' })}>
            <FolderTree size={16} />
            目录
          </Action>
          <Action active={state.page === 'code'} onClick={() => patch({ page: 'code' })}>
            <FileCode2 size={16} />
            代码
          </Action>
          <Action active={state.page === 'git'} onClick={() => patch({ page: 'git', git: true })}>
            <GitBranch size={16} />
            Git
          </Action>
        </div>
        <div className={styles.projectPreviewBody}>
          <aside className={styles.previewTree}>
            <div className={styles.treeHeading}>
              <strong>轻舟项目</strong>
              <span>{branch}</span>
            </div>
            <FileRow name="src" folder onClick={() => openFile('src/export.ts')} />
            <FileRow
              name="export.ts"
              changed
              active={state.path === 'src/export.ts'}
              onClick={() => openFile('src/export.ts')}
            />
            <FileRow
              name="README.md"
              active={state.path === 'README.md'}
              onClick={() => openFile('README.md')}
            />
            <FileRow
              name="preview.html"
              active={state.path === 'preview.html'}
              onClick={() => openFile('preview.html')}
            />
          </aside>
          <div className={styles.previewCode}>
            <div className={styles.previewFileTab}>
              {codeCommit ? `${codeCommit.path} · ${codeCommit.id}` : state.path}
            </div>
            <div className={styles.previewCodeContent}>
              <CodeView
                lines={codeCommit?.lines ?? demoFiles[state.path]}
                diff={Boolean(codeCommit)}
              />
            </div>
          </div>
          <section className={styles.previewGit} aria-label="项目 Git 记录">
            <header>
              <GitBranch size={16} />
              <strong>Git</strong>
              <span>{branch}</span>
            </header>
            <div className={styles.historyToolbar}>
              <Action
                active={mode === 'history'}
                onClick={() => {
                  setMode('history')
                  onInteract()
                }}
              >
                提交记录
              </Action>
              <Action
                active={mode === 'compare'}
                onClick={() => {
                  setMode('compare')
                  onInteract()
                }}
              >
                分支比较
              </Action>
              {mode === 'history' ? (
                <input
                  aria-label="搜索提交"
                  placeholder="搜索提交说明或 SHA"
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                />
              ) : (
                <>
                  <select
                    aria-label="比较基准分支"
                    value={base}
                    onChange={(event) => setBase(event.currentTarget.value)}
                  >
                    <option>main</option>
                    <option>feature/export</option>
                  </select>
                  <span>→</span>
                  <select
                    aria-label="比较目标分支"
                    value={compare}
                    onChange={(event) => setCompare(event.currentTarget.value)}
                  >
                    <option>feature/export</option>
                    <option>main</option>
                  </select>
                </>
              )}
            </div>
            {mode === 'history' ? (
              <div className={styles.historyBody}>
                <div className={styles.commitList}>
                  {demoCommits
                    .filter((item) => `${item.id} ${item.title}`.includes(query))
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-label={`查看提交 ${item.title}`}
                        className={state.commit === item.id ? styles.selectedCommit : ''}
                        onClick={() => patch({ commit: item.id })}
                      >
                        <span className={styles.commitDot} />
                        <div>
                          <strong>{item.title}</strong>
                          <small>{item.id} · 轻舟 · 今天 10:20</small>
                        </div>
                      </button>
                    ))}
                </div>
                <div className={styles.commitDetail}>
                  {commit ? (
                    <>
                      <strong>提交详情 · {commit.id}</strong>
                      <p>{commit.title}</p>
                      <button
                        type="button"
                        className={styles.changedFile}
                        onClick={() => patch({ codeCommit: commit.id, page: 'code' })}
                      >
                        <span>{commit.change}</span>
                        {commit.path}
                        <span>{commit.delta}</span>
                      </button>
                      <CodeView lines={commit.lines} diff />
                    </>
                  ) : (
                    <p>选择提交查看详情</p>
                  )}
                </div>
              </div>
            ) : (
              <div className={styles.commitDetail}>
                <strong>
                  {base} → {compare}
                </strong>
                {base === compare ? (
                  <p>没有文件差异</p>
                ) : (
                  <>
                    <p>src/export.ts · 完成时间列</p>
                    <CodeView
                      diff
                      lines={
                        base === 'main'
                          ? demoBranchDiff
                          : demoBranchDiff.map((line) =>
                              line.startsWith('+')
                                ? `-${line.slice(1)}`
                                : line.startsWith('-')
                                  ? `+${line.slice(1)}`
                                  : line
                            )
                      }
                    />
                  </>
                )}
              </div>
            )}
          </section>
        </div>
      </section>
    </div>
  )
}
