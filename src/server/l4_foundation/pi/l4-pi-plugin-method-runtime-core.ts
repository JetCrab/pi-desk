import type { PluginJsonObject } from '@jetcrab/pi-desk-sdk'
import { z } from 'zod'

const L4_PLUGIN_METHOD_MAX_JSON_BYTES = 2 * 1024 * 1024
const L4PiPluginIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
const L4PiPluginMethodDataSchema = z.record(z.string(), z.json())

export function l4PiPluginMethodKey(pluginName: string, method: string): string {
  return `${pluginName}\u0000${method}`
}

export function parseL4PiPluginName(value: unknown): string {
  return L4PiPluginIdentifierSchema.parse(value)
}

export function parseL4PiPluginMethodName(value: unknown): string {
  return L4PiPluginIdentifierSchema.parse(value)
}

export function parseL4PiPluginMethodData(
  value: unknown,
  direction: 'input' | 'output'
): PluginJsonObject {
  const data = L4PiPluginMethodDataSchema.parse(value) as PluginJsonObject
  const bytes = Buffer.byteLength(JSON.stringify(data), 'utf8')
  if (bytes > L4_PLUGIN_METHOD_MAX_JSON_BYTES) {
    throw new L4PiPluginMethodPayloadTooLargeError(direction)
  }
  return data
}

export class L4PiPluginMethodNotFoundError extends Error {
  constructor(pluginName: string, method: string) {
    super(`Plugin method was not found: ${pluginName}/${method}`)
    this.name = 'L4PiPluginMethodNotFoundError'
  }
}

export class L4PiPluginMethodConflictError extends Error {
  constructor(pluginName: string, method: string) {
    super(`Plugin method is already registered: ${pluginName}/${method}`)
    this.name = 'L4PiPluginMethodConflictError'
  }
}

export class L4PiPluginMethodPayloadTooLargeError extends Error {
  constructor(readonly direction: 'input' | 'output') {
    super(`Plugin method ${direction} exceeds 2MB`)
    this.name = 'L4PiPluginMethodPayloadTooLargeError'
  }
}
