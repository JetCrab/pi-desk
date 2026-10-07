import 'server-only'

import { discoverSkills, type SkillCatalog, type SkillResource } from './runtime/l4-skill-catalog'
import { getSkillFile, listSkillFiles, replaceSkillFile } from './runtime/l4-skill-files'
import { L4SkillError, skillPathKey } from './runtime/l4-skill-path'

export { L4SkillError } from './runtime/l4-skill-path'

function findSkill(catalog: SkillCatalog, skillPath: string): SkillResource {
  const skill = catalog.skills.find(
    (item) => skillPathKey(item.skillPath) === skillPathKey(skillPath)
  )
  if (!skill) throw new L4SkillError(404, '当前范围内未找到此 Skill，请刷新目录')
  return skill
}

export async function listL4Skills(cwd: string | null): Promise<{
  skills: Array<Omit<SkillResource, 'managed'>>
  diagnostics: SkillCatalog['diagnostics']
}> {
  const catalog = await discoverSkills(cwd)
  return {
    skills: catalog.skills.map(({ skillPath, name, description, packageSource }) => ({
      skillPath,
      name,
      description,
      packageSource
    })),
    diagnostics: catalog.diagnostics
  }
}

export async function listL4SkillFiles(
  cwd: string | null,
  skillPath: string,
  path: string
): Promise<Awaited<ReturnType<typeof listSkillFiles>>> {
  const catalog = await discoverSkills(cwd)
  return listSkillFiles(findSkill(catalog, skillPath), path)
}

export async function getL4SkillFile(
  cwd: string | null,
  skillPath: string,
  path: string
): Promise<Awaited<ReturnType<typeof getSkillFile>>> {
  const catalog = await discoverSkills(cwd)
  return getSkillFile(catalog, findSkill(catalog, skillPath), path)
}

export async function replaceL4SkillFile(
  cwd: string | null,
  skillPath: string,
  path: string,
  content: string
): Promise<void> {
  const catalog = await discoverSkills(cwd)
  await replaceSkillFile(catalog, findSkill(catalog, skillPath), path, content)
}
