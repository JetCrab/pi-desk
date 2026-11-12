import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

async function copyDirectory(source, target) {
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name)
    const targetPath = join(target, entry.name)
    if (entry.isDirectory()) await copyDirectory(sourcePath, targetPath)
    else if (entry.isFile()) await copyFile(sourcePath, targetPath)
  }
}

await copyFile(join('src', 'command-runner.mjs'), join('dist', 'command-runner.mjs'))
await rm(join('dist', 'browser'), { recursive: true, force: true })
for (const directory of ['skills', 'prompts']) {
  await rm(join('dist', directory), { recursive: true, force: true })
  await copyDirectory(directory, join('dist', directory))
}

for (const name of await readdir('dist')) {
  if (
    name.startsWith('browser') &&
    ['.js', '.d.ts', '.js.map'].some((extension) => name.endsWith(extension))
  ) {
    await rm(join('dist', name), { force: true })
  }
}
