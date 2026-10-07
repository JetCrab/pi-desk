export interface L3PathDirectory {
  path: string
  directories: Map<string, L3PathDirectory>
  files: string[]
}
export interface L3CompactDirectory {
  path: string
  targetPath: string
  label: string
  paths: string[]
}
export interface L3PathTreeRow {
  key: string
  type: 'file' | 'directory'
  path: string
  label: string
  depth: number
  directory?: L3CompactDirectory
  expanded?: boolean
}

export function keyL3ProjectTree(type: 'file' | 'directory', path: string): string {
  return `${type}:${path}`
}
export function joinL3ProjectPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child
}
export function compareL3ProjectNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' })
}
export function compactL3ProjectDirectory(
  path: string,
  nextDirectory: (path: string) => string | null,
  boundaries: ReadonlySet<string> = new Set()
): L3CompactDirectory {
  const paths = [path]
  let targetPath = path
  while (!boundaries.has(targetPath)) {
    const next = nextDirectory(targetPath)
    if (!next || boundaries.has(next) || !next.startsWith(`${targetPath}/`)) break
    paths.push(next)
    targetPath = next
  }
  return { path, targetPath, paths, label: targetPath.slice(path.lastIndexOf('/') + 1) }
}

export function buildL3ProjectPathTree(
  paths: readonly string[],
  rootPath = ''
): Map<string, L3PathDirectory> {
  const root: L3PathDirectory = { path: rootPath, directories: new Map(), files: [] }
  const directories = new Map([[rootPath, root]])
  for (const path of paths) {
    const relative = rootPath ? path.slice(rootPath.length + 1) : path
    const segments = relative.split('/')
    let parent = root
    for (const name of segments.slice(0, -1)) {
      const nextPath = joinL3ProjectPath(parent.path, name)
      let next = directories.get(nextPath)
      if (!next) {
        next = { path: nextPath, directories: new Map(), files: [] }
        directories.set(nextPath, next)
        parent.directories.set(nextPath, next)
      }
      parent = next
    }
    // 文件与目录分别存储：删除 a 同时新增 a/b 时，两条变更都必须可见。
    parent.files.push(path)
  }
  return directories
}

export function compactL3PathTreeDirectory(
  path: string,
  tree: ReadonlyMap<string, L3PathDirectory>,
  boundaries?: ReadonlySet<string>
): L3CompactDirectory {
  return compactL3ProjectDirectory(
    path,
    (current) => {
      const node = tree.get(current)
      return node && node.files.length === 0 && node.directories.size === 1
        ? (node.directories.keys().next().value ?? null)
        : null
    },
    boundaries
  )
}

export function flattenL3ProjectPathTree(
  tree: ReadonlyMap<string, L3PathDirectory>,
  collapsed: ReadonlySet<string>,
  rootPath = ''
): L3PathTreeRow[] {
  const rows: L3PathTreeRow[] = []
  const visit = (path: string, depth: number): void => {
    const node = tree.get(path)
    if (!node) return
    for (const child of [...node.directories.keys()].sort(compareL3ProjectNames)) {
      const directory = compactL3PathTreeDirectory(child, tree)
      const expanded = !directory.paths.some((part) => collapsed.has(part))
      rows.push({
        key: keyL3ProjectTree('directory', child),
        type: 'directory',
        path: directory.targetPath,
        label: directory.label,
        depth,
        directory,
        expanded
      })
      if (expanded) visit(directory.targetPath, depth + 1)
    }
    for (const file of [...node.files].sort(compareL3ProjectNames)) {
      rows.push({
        key: keyL3ProjectTree('file', file),
        type: 'file',
        path: file,
        label: file.slice(file.lastIndexOf('/') + 1),
        depth
      })
    }
  }
  visit(rootPath, 0)
  return rows
}
