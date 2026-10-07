import 'server-only'

import { basename, dirname, join, resolve } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { L4_PROJECT_TEXT_FILE_MAX_BYTES } from '@common/l4_foundation/file/l4-project-file-contract'
import {
  createL4BilingualText,
  type L4LocalizedText
} from '@common/l4_foundation/locale/l4-localized-text'
import { runL4PiPackageRootExclusive } from '@server/l4_foundation/pi/l4-pi-package-root-gate'
import { protocolSkillPath, skillPathKey } from './l4-skill-path'

export interface SkillResource {
  skillPath: string
  name: string
  description: string
  packageSource: string | null
  managed: boolean
}

export interface SkillCatalog {
  skills: SkillResource[]
  diagnostics: Array<{ path: string; message: L4LocalizedText }>
  managedRoots: string[]
}

function managedSource(source: string): boolean {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/i.test(source)
}

export function discoverSkills(cwd: string | null): Promise<SkillCatalog> {
  return runL4PiPackageRootExclusive(async () => {
    const { CONFIG_DIR_NAME, DefaultPackageManager, getAgentDir, loadSkills, SettingsManager } =
      await import('@earendil-works/pi-coding-agent')
    const agentDir = getAgentDir()
    const effectiveCwd = cwd ?? process.cwd()
    const scope = cwd === null ? 'user' : 'project'
    const settings = SettingsManager.create(effectiveCwd, agentDir, {
      projectTrusted: cwd !== null
    })
    const manager = new DefaultPackageManager({
      cwd: effectiveCwd,
      agentDir,
      settingsManager: settings
    })
    const diagnostics: SkillCatalog['diagnostics'] = settings
      .drainErrors()
      .map(({ scope: errorScope, error }) => ({
        path: protocolSkillPath(
          errorScope === 'global'
            ? join(agentDir, 'settings.json')
            : join(effectiveCwd, CONFIG_DIR_NAME, 'settings.json')
        ),
        message: error.message
      }))
    const configured = manager.listConfiguredPackages()
    const missing = new Set(
      configured
        .filter((item) => item.scope === scope && !item.installedPath)
        .map((item) => item.source)
    )
    // 显式 skip：设置页面绝不能通过资源发现安装缺失包或加载扩展。
    const resources = await manager.resolve(async (source) => {
      if (configured.some((item) => item.source === source && item.scope === scope))
        missing.add(source)
      return 'skip'
    })
    for (const source of missing)
      diagnostics.push({
        path: source,
        message: createL4BilingualText(
          '包未安装或版本不匹配，已跳过；查看 Skills 不会自动安装包。',
          'Package not installed or version mismatch. Skills are not installed automatically.'
        )
      })
    const rootCandidates = [
      join(agentDir, 'npm'),
      join(agentDir, 'git'),
      ...configured.flatMap((item) =>
        managedSource(item.source) && item.installedPath ? [item.installedPath] : []
      ),
      ...(cwd === null
        ? []
        : [join(cwd, CONFIG_DIR_NAME, 'npm'), join(cwd, CONFIG_DIR_NAME, 'git')])
    ]
    const managedRoots = await Promise.all(
      rootCandidates.map(async (path) => {
        try {
          return await realpath(path)
        } catch {
          return resolve(path)
        }
      })
    )
    const globalPackageRoots = new Set(
      await Promise.all(
        configured
          .filter((item) => item.scope === 'user' && item.installedPath)
          .map(async (item) => {
            try {
              return skillPathKey(await realpath(item.installedPath!))
            } catch {
              return skillPathKey(item.installedPath!)
            }
          })
      )
    )
    const skills: SkillResource[] = []
    const seen = new Set<string>()
    for (const resource of resources.skills) {
      if (resource.metadata.scope !== scope) continue
      // 项目 autoload delta 仍使用全局包目录，它不是一份新的项目资源。
      if (
        scope === 'project' &&
        resource.metadata.origin === 'package' &&
        resource.metadata.baseDir
      ) {
        let packageRoot = resource.metadata.baseDir
        try {
          packageRoot = await realpath(packageRoot)
        } catch {
          /* 失效路径由后续读取给出诊断。 */
        }
        if (globalPackageRoots.has(skillPathKey(packageRoot))) continue
      }
      const skillPath = protocolSkillPath(resource.path)
      const key = skillPathKey(skillPath)
      if (seen.has(key)) continue
      seen.add(key)
      const fallbackName =
        basename(skillPath) === 'SKILL.md'
          ? basename(dirname(skillPath))
          : basename(skillPath, '.md')
      let name = fallbackName || 'Skill'
      let description = ''
      try {
        const info = await stat(skillPath)
        if (!info.isFile()) continue
        if (info.size > L4_PROJECT_TEXT_FILE_MAX_BYTES) {
          diagnostics.push({
            path: skillPath,
            message: createL4BilingualText(
              '入口文件超过文本读取限制。',
              'The entry file exceeds the text read limit.'
            )
          })
        } else {
          // 单独解析每个物理入口，不能让同名去重吞掉另一个可编辑文件。
          const parsed = loadSkills({
            cwd: effectiveCwd,
            agentDir,
            skillPaths: [skillPath],
            includeDefaults: false
          })
          name = parsed.skills[0]?.name || name
          description = parsed.skills[0]?.description ?? ''
          diagnostics.push(
            ...parsed.diagnostics.map((item) => ({
              path: protocolSkillPath(item.path ?? skillPath),
              message: item.message
            }))
          )
        }
      } catch (error) {
        diagnostics.push({
          path: skillPath,
          message:
            error instanceof Error
              ? error.message
              : createL4BilingualText('入口文件读取失败', 'Could not read the entry file')
        })
      }
      if (!resource.enabled)
        diagnostics.push({
          path: skillPath,
          message: createL4BilingualText(
            '此资源已被 Pi 配置排除；仍可查看文件。',
            'This resource is excluded by Pi configuration; its files are still available to view.'
          )
        })
      skills.push({
        skillPath,
        name,
        description,
        packageSource: resource.metadata.origin === 'package' ? resource.metadata.source : null,
        managed: resource.metadata.origin === 'package' && managedSource(resource.metadata.source)
      })
    }
    const names = new Map<string, string>()
    for (const skill of skills) {
      const previous = names.get(skill.name)
      if (previous)
        diagnostics.push({
          path: skill.skillPath,
          message: createL4BilingualText(
            `同名 Skill：${previous}；这里保留各自来源，不代表会话加载结果。`,
            `Duplicate Skill name: ${previous}. Each source is shown here; this does not indicate the session load result.`
          )
        })
      else names.set(skill.name, skill.skillPath)
    }
    skills.sort(
      (left, right) =>
        left.name.localeCompare(right.name, 'zh-CN', { numeric: true }) ||
        left.skillPath.localeCompare(right.skillPath)
    )
    return { skills, diagnostics, managedRoots }
  })
}
