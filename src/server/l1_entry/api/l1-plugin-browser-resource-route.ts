import 'server-only'

import { L3PluginBrowserResourceGroupSchema } from '@common/l3_modules/plugin-host/l3-plugin-browser-contract'
import { createL4ApiErrorResponse } from '@server/l4_foundation/http/l4-api-response'
import {
  getL4PiPluginBrowserResourceRegistry,
  L4PiPluginBrowserResourceNotFoundError
} from '@server/l4_foundation/pi/l4-pi-plugin-browser-resource'

interface L1PluginBrowserResourceRouteContext {
  params: Promise<{
    resourceGroup: string
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

export async function GET(
  request: Request,
  context: L1PluginBrowserResourceRouteContext
): Promise<Response> {
  const { resourceGroup: resourceGroupInput, resourcePath } = await context.params
  const resourceGroup = L3PluginBrowserResourceGroupSchema.safeParse(resourceGroupInput)
  const protocolPath = resourcePath.join('/')
  if (!resourceGroup.success || !protocolPath.endsWith('.js')) {
    return createL4ApiErrorResponse(404, '插件资源不存在', { key: 'errors:pluginResourceMissing' })
  }

  try {
    const resource = await getL4PiPluginBrowserResourceRegistry().read(
      resourceGroup.data,
      protocolPath
    )
    if (request.headers.get('If-None-Match') === resource.etag) {
      return new Response(null, { status: 304, headers: resourceHeaders(resource.etag) })
    }
    return new Response(resource.stream, {
      status: 200,
      headers: resourceHeaders(resource.etag, resource.size)
    })
  } catch (error) {
    if (
      error instanceof L4PiPluginBrowserResourceNotFoundError ||
      (error instanceof Error && error.name === 'L4PiPluginBrowserResourceNotFoundError')
    ) {
      return createL4ApiErrorResponse(404, '插件资源不存在', {
        key: 'errors:pluginResourceMissing'
      })
    }
    console.error('[Pi Desk][PluginBrowserResourceApi] 读取 Browser 资源失败', {
      resourceGroup: resourceGroup.data,
      resourcePath: protocolPath,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    return createL4ApiErrorResponse(500, '读取插件资源失败', {
      key: 'errors:pluginResourceReadFailed'
    })
  }
}
