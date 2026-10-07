'use client'

import type * as Monaco from 'monaco-editor/editor/editor.api'
import { L4_PROJECT_CODE_PARSE_MAX_BYTES } from '@common/l4_foundation/file/l4-project-file-contract'
import { readL4Region } from '@client/l4_foundation/locale/l4-region-store'

export type L4Monaco = typeof Monaco

type MonacoTypography = Pick<
  Monaco.editor.IStandaloneEditorConstructionOptions,
  'fontFamily' | 'fontSize' | 'lineHeight'
>

export function getL4MonacoTypography(): MonacoTypography {
  const scale = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) / 16
  return {
    fontFamily:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
    fontSize: 14 * scale,
    lineHeight: Math.round(22 * scale)
  }
}

export function observeL4MonacoTypography(
  onChange: (typography: MonacoTypography) => void
): () => void {
  const observer = new MutationObserver(() => onChange(getL4MonacoTypography()))
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-pi-desk-display-size']
  })
  return () => observer.disconnect()
}

let monacoPromise: Promise<L4Monaco> | null = null
let modelSequence = 0

interface L4MonacoEnvironment {
  getWorker: (moduleId: string, label: string) => Worker
}

function configureL4MonacoWorkers(): void {
  const scope = globalThis as typeof globalThis & {
    MonacoEnvironment?: L4MonacoEnvironment
  }
  scope.MonacoEnvironment = {
    getWorker(_moduleId, label): Worker {
      return new Worker(new URL('monaco-editor/editor/editor.worker', import.meta.url), {
        type: 'module',
        name: label
      })
    }
  }
}

export function loadL4Monaco(): Promise<L4Monaco> {
  if (monacoPromise) return monacoPromise
  monacoPromise = (async () => {
    if (readL4Region()?.locale === 'zh-CN') {
      await import('monaco-editor/nls/lang/zh-cn')
    }
    const { monaco } = await import('./l4-monaco-bundle')
    configureL4MonacoWorkers()
    return monaco
  })()
  return monacoPromise
}

export function getL4MonacoTheme(): 'vs' | 'vs-dark' {
  return document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'
}

export function observeL4MonacoTheme(onChange: (theme: 'vs' | 'vs-dark') => void): () => void {
  const observer = new MutationObserver(() => onChange(getL4MonacoTheme()))
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

export function createL4MonacoModelUri(monaco: L4Monaco, path: string, side: string): Monaco.Uri {
  modelSequence += 1
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return monaco.Uri.parse(`inmemory://pi-desk/${modelSequence}/${side}/${encodedPath}`)
}

export function getL4MonacoLanguage(path: string, size: number): string {
  if (size > L4_PROJECT_CODE_PARSE_MAX_BYTES) return 'plaintext'
  const name = path.replaceAll('\\', '/').split('/').at(-1)?.toLocaleLowerCase() ?? ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'plaintext'
  const extension = name.includes('.') ? (name.split('.').at(-1) ?? '') : ''
  return (
    (
      {
        bat: 'bat',
        c: 'c',
        cc: 'cpp',
        cjs: 'javascript',
        cpp: 'cpp',
        cs: 'csharp',
        css: 'css',
        dockerfile: 'dockerfile',
        go: 'go',
        h: 'cpp',
        hpp: 'cpp',
        htm: 'html',
        html: 'html',
        ini: 'ini',
        java: 'java',
        js: 'javascript',
        json: 'javascript',
        jsonl: 'javascript',
        jsx: 'javascript',
        kt: 'kotlin',
        less: 'less',
        lua: 'lua',
        md: 'markdown',
        mdx: 'markdown',
        mjs: 'javascript',
        php: 'php',
        ps1: 'powershell',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        scss: 'scss',
        sh: 'shell',
        sql: 'sql',
        swift: 'swift',
        toml: 'ini',
        ts: 'typescript',
        tsx: 'typescript',
        txt: 'plaintext',
        xml: 'xml',
        yaml: 'yaml',
        yml: 'yaml'
      } as Record<string, string>
    )[extension] ?? 'plaintext'
  )
}
