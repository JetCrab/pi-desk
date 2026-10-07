import 'server-only'

import { readFileSync } from 'node:fs'
import type { PromptTemplate, Skill } from '@earendil-works/pi-coding-agent'
import { stripFrontmatter } from '@earendil-works/pi-coding-agent'
import type { ImageContent } from '@earendil-works/pi-ai'
import { decodeL4PiImage, validateL4PiInputImage, type L4PiInputImage } from './l4-pi-image'

export const L4_PI_CHAT_MAX_IMAGE_COUNT = 10
export const L4_PI_CHAT_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const L4_PI_CHAT_MAX_INPUT_IMAGE_BYTES = 20 * 1024 * 1024
export const L4_PI_CHAT_MAX_QUEUED_INPUTS = 32
export const L4_PI_CHAT_MAX_QUEUED_IMAGE_BYTES = 20 * 1024 * 1024
export const L4_PI_CHAT_MAX_APPLICATION_JSON_BYTES = 31 * 1024 * 1024

const QUEUE_RESTORE_ENVELOPE_RESERVE_BYTES = 1024

export class L4PiChatInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'L4PiChatInputError'
  }
}

export interface L4PiChatInput {
  text: string
  images: L4PiInputImage[]
}

export interface L4PiPreparedChatInput extends L4PiChatInput {
  imageBytes: number
}

function parseCommandArgs(argsString: string): string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const character of argsString) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (/\s/.test(character)) {
      if (current) args.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current) args.push(current)
  return args
}

function substituteTemplateArgs(content: string, args: readonly string[]): string {
  const allArgs = args.join(' ')
  return content.replace(
    /\$\{(\d+|ARGUMENTS|@):-([^}]*)\}|\$\{@:(\d+)(?::(\d+))?\}|\$(ARGUMENTS|@|\d+)/g,
    (_match, defaultTarget, defaultValue, sliceStart, sliceLength, simple) => {
      if (typeof defaultTarget === 'string') {
        const value =
          defaultTarget === '@' || defaultTarget === 'ARGUMENTS'
            ? allArgs
            : args[Number.parseInt(defaultTarget, 10) - 1]
        return value || defaultValue
      }
      if (typeof sliceStart === 'string') {
        const start = Math.max(0, Number.parseInt(sliceStart, 10) - 1)
        return typeof sliceLength === 'string'
          ? args.slice(start, start + Number.parseInt(sliceLength, 10)).join(' ')
          : args.slice(start).join(' ')
      }
      if (simple === 'ARGUMENTS' || simple === '@') return allArgs
      return args[Number.parseInt(simple, 10) - 1] ?? ''
    }
  )
}

function expandSkill(text: string, skills: readonly Skill[]): string {
  if (!text.startsWith('/skill:')) return text
  const spaceIndex = text.indexOf(' ')
  const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex)
  const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim()
  const skill = skills.find((candidate) => candidate.name === skillName)
  if (!skill) return text

  try {
    const body = stripFrontmatter(readFileSync(skill.filePath, 'utf8')).trim()
    const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`
    return args ? `${block}\n\n${args}` : block
  } catch {
    return text
  }
}

function expandPromptTemplate(text: string, templates: readonly PromptTemplate[]): string {
  if (!text.startsWith('/')) return text
  const match = text.match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/)
  if (!match) return text
  const template = templates.find((candidate) => candidate.name === match[1])
  if (!template) return text
  return substituteTemplateArgs(template.content, parseCommandArgs(match[2] ?? ''))
}

export function expandL4PiChatInputText(
  text: string,
  skills: readonly Skill[],
  templates: readonly PromptTemplate[]
): string {
  return expandPromptTemplate(expandSkill(text, skills), templates)
}

function validatePreparedImages(images: readonly L4PiInputImage[]): number {
  if (images.length > L4_PI_CHAT_MAX_IMAGE_COUNT) {
    throw new L4PiChatInputError(`单次最多发送 ${L4_PI_CHAT_MAX_IMAGE_COUNT} 张图片`)
  }

  let totalBytes = 0
  for (const image of images) {
    const decoded = validateL4PiInputImage(image)
    if (decoded.bytes.length > L4_PI_CHAT_MAX_IMAGE_BYTES) {
      throw new L4PiChatInputError('单张图片压缩后不能超过 10MB')
    }
    totalBytes += decoded.bytes.length
  }
  if (totalBytes > L4_PI_CHAT_MAX_INPUT_IMAGE_BYTES) {
    throw new L4PiChatInputError('单次发送图片总量不能超过 20MB')
  }
  return totalBytes
}

export function prepareL4PiChatInput(input: L4PiChatInput): L4PiPreparedChatInput {
  if (!input.text.trim() && input.images.length === 0) {
    throw new L4PiChatInputError('请输入文字或添加图片')
  }
  return {
    text: input.text,
    images: input.images.map((image) => ({ ...image })),
    imageBytes: validatePreparedImages(input.images)
  }
}

export function prepareL4PiTransformedInput(
  text: string,
  images: readonly ImageContent[] | undefined,
  skills: readonly Skill[],
  templates: readonly PromptTemplate[]
): L4PiPreparedChatInput {
  const expandedText = expandL4PiChatInputText(text, skills, templates)
  const preparedImages = (images ?? []).map((image) => {
    const decoded = decodeL4PiImage(image.data)
    if (decoded.metadata.mimeType !== image.mimeType) {
      throw new L4PiChatInputError('图片 MIME 与实际内容不一致')
    }
    return { ...decoded.metadata, data: image.data }
  })
  return prepareL4PiChatInput({ text: expandedText, images: preparedImages })
}

export function toL4PiImageContent(images: readonly L4PiInputImage[]): ImageContent[] {
  return images.map((image) => ({
    type: 'image',
    data: image.data,
    mimeType: image.mimeType
  }))
}

function queueRestorePayloadBytes(inputs: readonly L4PiPreparedChatInput[]): number {
  const text = inputs
    .map((input) => input.text)
    .filter((value) => value.trim())
    .join('\n\n')
  const images = inputs.flatMap((input) => input.images)
  return Buffer.byteLength(JSON.stringify({ text, images }), 'utf8')
}

export function validateL4PiQueuedInputs(inputs: readonly L4PiPreparedChatInput[]): void {
  if (inputs.length > L4_PI_CHAT_MAX_QUEUED_INPUTS) {
    throw new L4PiChatInputError('当前 WorkSession 最多排队 32 条输入')
  }
  const imageBytes = inputs.reduce((total, input) => total + input.imageBytes, 0)
  if (imageBytes > L4_PI_CHAT_MAX_QUEUED_IMAGE_BYTES) {
    throw new L4PiChatInputError('全部排队图片总量不能超过 20MB')
  }
  if (
    queueRestorePayloadBytes(inputs) + QUEUE_RESTORE_ENVELOPE_RESERVE_BYTES >
    L4_PI_CHAT_MAX_APPLICATION_JSON_BYTES
  ) {
    throw new L4PiChatInputError('排队内容过大，无法通过一次恢复响应返回')
  }
}
