import { FileCode2Icon, FileTextIcon, Settings2Icon } from 'lucide-react'
import Image, { type StaticImageData } from 'next/image'
import agentIcon from './material/agent.svg'
import consoleIcon from './material/console.svg'
import cssIcon from './material/css.svg'
import dockerIcon from './material/docker.svg'
import gitIcon from './material/git.svg'
import htmlIcon from './material/html.svg'
import imageIcon from './material/image.svg'
import javascriptIcon from './material/javascript.svg'
import jsonIcon from './material/json.svg'
import markdownIcon from './material/markdown.svg'
import nodejsIcon from './material/nodejs.svg'
import pythonIcon from './material/python.svg'
import reactIcon from './material/react.svg'
import reactTsIcon from './material/react_ts.svg'
import skillIcon from './material/skill.svg'
import svgIcon from './material/svg.svg'
import typescriptIcon from './material/typescript.svg'
import yamlIcon from './material/yaml.svg'

const FILE_NAME_ICONS = new Map<string, StaticImageData>(
  Object.entries({
    'agents.md': agentIcon,
    'skill.md': skillIcon,
    'package.json': nodejsIcon,
    'package-lock.json': nodejsIcon,
    'npm-shrinkwrap.json': nodejsIcon,
    dockerfile: dockerIcon,
    '.dockerignore': dockerIcon,
    '.gitignore': gitIcon,
    '.gitattributes': gitIcon,
    '.gitmodules': gitIcon
  })
)

const EXTENSION_ICONS = new Map<string, StaticImageData>(
  Object.entries({
    ts: typescriptIcon,
    mts: typescriptIcon,
    cts: typescriptIcon,
    tsx: reactTsIcon,
    js: javascriptIcon,
    mjs: javascriptIcon,
    cjs: javascriptIcon,
    jsx: reactIcon,
    json: jsonIcon,
    jsonc: jsonIcon,
    jsonl: jsonIcon,
    yaml: yamlIcon,
    yml: yamlIcon,
    md: markdownIcon,
    mdx: markdownIcon,
    png: imageIcon,
    jpg: imageIcon,
    jpeg: imageIcon,
    gif: imageIcon,
    webp: imageIcon,
    avif: imageIcon,
    bmp: imageIcon,
    ico: imageIcon,
    svg: svgIcon,
    sh: consoleIcon,
    bash: consoleIcon,
    zsh: consoleIcon,
    fish: consoleIcon,
    ps1: consoleIcon,
    bat: consoleIcon,
    cmd: consoleIcon,
    html: htmlIcon,
    htm: htmlIcon,
    css: cssIcon,
    py: pythonIcon
  })
)

const CONFIG_EXTENSIONS = new Set(['env', 'toml', 'ini', 'conf', 'cfg', 'properties'])
const CONFIG_NAMES = new Set([
  '.editorconfig',
  '.npmrc',
  '.yarnrc',
  '.prettierignore',
  '.eslintignore'
])
const CODE_EXTENSIONS = new Set([
  'c',
  'cpp',
  'cc',
  'cxx',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'rb',
  'php',
  'swift',
  'dart',
  'vue',
  'svelte',
  'scss',
  'sass',
  'less',
  'sql',
  'xml'
])

export function L4FileIcon({
  path,
  className
}: {
  path: string
  className?: string
}): React.JSX.Element {
  const fileName = path.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  const extension = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1) : ''
  const config =
    CONFIG_EXTENSIONS.has(extension) ||
    CONFIG_NAMES.has(fileName) ||
    fileName.startsWith('.env.') ||
    fileName.startsWith('.eslintrc') ||
    fileName.startsWith('.prettierrc') ||
    fileName.startsWith('eslint.config.') ||
    fileName.startsWith('prettier.config.')
  if (config) return <Settings2Icon className={className} aria-hidden="true" />

  // 特殊文件名优先于扩展名；只查静态子集，不在卡片内生成完整主题映射。
  const icon =
    FILE_NAME_ICONS.get(fileName) ??
    (fileName.startsWith('dockerfile.') ? dockerIcon : undefined) ??
    EXTENSION_ICONS.get(extension)

  if (!icon) {
    const Fallback = CODE_EXTENSIONS.has(extension) ? FileCode2Icon : FileTextIcon
    return <Fallback className={className} aria-hidden="true" />
  }

  return (
    <Image
      src={icon}
      alt=""
      aria-hidden="true"
      width={16}
      height={16}
      className={className}
      unoptimized
    />
  )
}
