import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  L2SkillFilesListRequest,
  L2SkillFilesListResponse,
  L2SkillsListResponse
} from '@common/l2_biz/settings/l2-skills-contract'
import type { L2SkillsBiz } from '../l2-skills-biz'
import { l2SkillsText } from '../l2-skills-text'

export interface L2SkillProject {
  cwd: string
  projectName: string
}
export interface L2SkillLoad<T> {
  data: T | null
  loading: boolean
  error: string | null
}
export function l2SkillScopeKey(cwd: string | null): string {
  return JSON.stringify(cwd)
}
export function l2SkillDirectoryKey(target: L2SkillFilesListRequest): string {
  return JSON.stringify([target.cwd, target.skillPath, target.path])
}

interface SkillsCatalogState {
  scopes: Record<string, L2SkillLoad<L2SkillsListResponse>>
  directories: Record<string, L2SkillLoad<L2SkillFilesListResponse>>
  loadScope: (cwd: string | null) => Promise<void>
  loadDirectory: (target: L2SkillFilesListRequest) => Promise<void>
}

export function useL2SkillsCatalog(
  biz: L2SkillsBiz,
  projects: readonly L2SkillProject[]
): SkillsCatalogState {
  const [scopes, setScopes] = useState<SkillsCatalogState['scopes']>({})
  const [directories, setDirectories] = useState<SkillsCatalogState['directories']>({})
  const requests = useRef(new Map<string, AbortController>())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    const activeRequests = requests.current
    return () => {
      alive.current = false
      for (const request of activeRequests.values()) request.abort()
      activeRequests.clear()
    }
  }, [])

  const loadScope = useCallback(
    async (cwd: string | null): Promise<void> => {
      const key = l2SkillScopeKey(cwd)
      const requestKey = `scope:${key}`
      requests.current.get(requestKey)?.abort()
      const controller = new AbortController()
      requests.current.set(requestKey, controller)
      setScopes((state) => ({
        ...state,
        [key]: { data: state[key]?.data ?? null, loading: true, error: null }
      }))
      try {
        const data = await biz.list({ cwd }, controller.signal)
        if (!controller.signal.aborted && alive.current)
          setScopes((state) => ({ ...state, [key]: { data, loading: false, error: null } }))
      } catch (error) {
        if (!controller.signal.aborted && alive.current)
          setScopes((state) => ({
            ...state,
            [key]: {
              data: state[key]?.data ?? null,
              loading: false,
              error: error instanceof Error ? error.message : l2SkillsText('skillsReadFailed')
            }
          }))
      } finally {
        if (requests.current.get(requestKey) === controller) requests.current.delete(requestKey)
      }
    },
    [biz]
  )

  const loadDirectory = useCallback(
    async (target: L2SkillFilesListRequest): Promise<void> => {
      const key = l2SkillDirectoryKey(target)
      const requestKey = `directory:${key}`
      requests.current.get(requestKey)?.abort()
      const controller = new AbortController()
      requests.current.set(requestKey, controller)
      setDirectories((state) => ({
        ...state,
        [key]: { data: state[key]?.data ?? null, loading: true, error: null }
      }))
      try {
        const data = await biz.listFiles(target, controller.signal)
        if (!controller.signal.aborted && alive.current)
          setDirectories((state) => ({ ...state, [key]: { data, loading: false, error: null } }))
      } catch (error) {
        if (!controller.signal.aborted && alive.current)
          setDirectories((state) => ({
            ...state,
            [key]: {
              data: null,
              loading: false,
              error: error instanceof Error ? error.message : l2SkillsText('directoryReadFailed')
            }
          }))
      } finally {
        if (requests.current.get(requestKey) === controller) requests.current.delete(requestKey)
      }
    },
    [biz]
  )

  const scopeSignature = JSON.stringify(projects.map((item) => item.cwd))
  useEffect(() => {
    const valid = new Set([
      l2SkillScopeKey(null),
      ...(JSON.parse(scopeSignature) as string[]).map(l2SkillScopeKey)
    ])
    // 只保留当前工作区的可丢弃目录数据；编辑器草稿由独立生命周期持有。
    setScopes((state) =>
      Object.fromEntries(Object.entries(state).filter(([key]) => valid.has(key)))
    )
    setDirectories((state) =>
      Object.fromEntries(
        Object.entries(state).filter(([key]) =>
          valid.has(l2SkillScopeKey((JSON.parse(key) as [string | null])[0]))
        )
      )
    )
    for (const [key, controller] of requests.current) {
      const scopeKey = key.startsWith('scope:')
        ? key.slice(6)
        : l2SkillScopeKey((JSON.parse(key.slice(10)) as [string | null])[0])
      if (!valid.has(scopeKey)) {
        controller.abort()
        requests.current.delete(key)
      }
    }
  }, [scopeSignature])

  return { scopes, directories, loadScope, loadDirectory }
}
