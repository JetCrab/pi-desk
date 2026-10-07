import 'server-only'

import { L3PluginHostBrowserRuntimeVersionSchema } from '@common/l3_modules/plugin-host/l3-plugin-browser-contract'
import { createL4ApiErrorResponse } from '@server/l4_foundation/http/l4-api-response'
import {
  L4PiPluginHostBrowserResourceNotFoundError,
  L4PiPluginHostBrowserRuntimeUnavailableError,
  readL4PiPluginHostBrowserResource
} from '@server/l4_foundation/pi/l4-pi-plugin-host-browser-resource'

export interface L1PluginHostBrowserResourceRouteContext {
  params: Promise<{
    runtimeVersion: string
    resourcePath: string[]
  }>
}

function resourceHeaders(etag: string, size?: number): HeadersInit {
  return {
    'Cache-Control': 'no-cache',
    'Content-Type': 'text/javascript; charset=utf-8',
    ETag: etag,
    'X-Content-Type-Options': 'nosniff',
    ...(size === undefined ? {} : { 'Content-Length': String(size) })
  }
}

export async function getL1PluginHostBrowserResource(
  request: Request,
  context: L1PluginHostBrowserResourceRouteContext
): Promise<Response> {
  const { runtimeVersion: runtimeVersionInput, resourcePath } = await context.params
  const runtimeVersion = L3PluginHostBrowserRuntimeVersionSchema.safeParse(runtimeVersionInput)
  const protocolPath = resourcePath.join('/')
  if (!runtimeVersion.success || !protocolPath.endsWith('.js')) {
    return createL4ApiErrorResponse(404, 'Host 公共插件资源不存在', {
      key: 'errors:hostResourceMissing'
    })
  }

  try {
    const resource = await readL4PiPluginHostBrowserResource(protocolPath)
    if (request.headers.get('If-None-Match') === resource.etag) {
      return new Response(null, { status: 304, headers: resourceHeaders(resource.etag) })
    }
    return new Response(resource.stream, {
      status: 200,
      headers: resourceHeaders(resource.etag, resource.size)
    })
  } catch (error) {
    if (error instanceof L4PiPluginHostBrowserResourceNotFoundError) {
      return createL4ApiErrorResponse(404, 'Host 公共插件资源不存在', {
        key: 'errors:hostResourceMissing'
      })
    }
    if (error instanceof L4PiPluginHostBrowserRuntimeUnavailableError) {
      console.error('[Pi Desk][PluginHostRuntimeApi] 公共 Runtime 不可用', {
        runtimeVersion: runtimeVersion.data,
        resourcePath: protocolPath,
        errorName: error.name,
        message: error.message
      })
      return createL4ApiErrorResponse(503, 'Host 公共插件 Runtime 尚未构建', {
        key: 'errors:hostRuntimeUnavailable'
      })
    }
    console.error('[Pi Desk][PluginHostRuntimeApi] 读取公共资源失败', {
      runtimeVersion: runtimeVersion.data,
      resourcePath: protocolPath,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '读取 Host 公共插件资源失败', {
      key: 'errors:hostResourceReadFailed'
    })
  }
}
