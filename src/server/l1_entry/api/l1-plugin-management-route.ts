import 'server-only'

import {
  L2PluginManagementApplyRequestSchema,
  L2PluginManagementReloadRequestSchema,
  L2PluginManagementListRequestSchema,
  L2PluginManagementSourceRequestSchema,
  type L2PluginManagementSnapshot
} from '@common/l2_biz/plugin/l2-plugin-management-contract'
import {
  getL2PluginManagement,
  L2PluginManagementInvalidPackageError,
  L2PluginManagementNotFoundError,
  L2PluginManagementOperationConflictError,
  L2PluginManagementPackageRootError,
  L2PluginManagementRestartPendingError,
  L2PluginManagementRestartUnavailableError
} from '@server/l2_biz/plugin-management/l2-plugin-management'
import { L2PluginReloadBlockedError } from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { readL4ClientId } from '@server/l4_foundation/http/l4-client-id'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'
import { L4PiPluginSourceNotFoundError } from '@server/l4_foundation/pi/l4-pi-plugin-source-changes'
import { L4PiPluginRuntimeBusyError } from '@server/l4_foundation/pi/l4-pi-plugin-owner-runtime'

async function readPayload(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function pluginOperationError(error: unknown, action: string): Response {
  if (
    error instanceof L2PluginManagementOperationConflictError ||
    (error instanceof Error && error.name === 'L2PluginManagementOperationConflictError')
  ) {
    return createL4ApiErrorResponse(409, error.message)
  }
  if (error instanceof L2PluginManagementPackageRootError) {
    return createL4ApiErrorResponse(409, error.message, error.rootError.i18n)
  }
  if (error instanceof L2PluginReloadBlockedError) {
    return createL4ApiErrorResponse(409, error.message, {
      key: 'errors:pluginReloadBlocked',
      params: { workId: error.workId, reason: error.reason.slice(0, 1000) }
    })
  }
  if (error instanceof L4PiPluginRuntimeBusyError) {
    return createL4ApiErrorResponse(409, error.message, { key: 'errors:pluginRuntimeBusy' })
  }
  if (error instanceof L2PluginManagementRestartPendingError) {
    return createL4ApiErrorResponse(409, error.message, { key: 'errors:pluginRestartPending' })
  }
  if (error instanceof L2PluginManagementRestartUnavailableError) {
    return createL4ApiErrorResponse(409, error.message, { key: 'errors:pluginRestartUnavailable' })
  }
  if (
    error instanceof Error &&
    (error instanceof L2PluginManagementNotFoundError ||
      error instanceof L4PiPluginSourceNotFoundError ||
      error.name === 'L2PluginManagementNotFoundError' ||
      error.name === 'L4PiPluginSourceNotFoundError') &&
    'source' in error &&
    typeof error.source === 'string'
  ) {
    return createL4ApiErrorResponse(404, error.message, {
      key: 'errors:pluginNotFound',
      params: { source: error.source.slice(0, 1000) }
    })
  }
  if (error instanceof L2PluginManagementInvalidPackageError) {
    return createL4ApiErrorResponse(400, error.message)
  }

  console.error('[Pi Desk][PluginManagementApi] 插件操作失败', {
    action,
    errorName: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message : String(error)
  })
  return createL4ApiErrorResponse(
    500,
    error instanceof Error && error.message ? error.message : `${action}失败`
  )
}

async function handleRestart(
  request: Request,
  action: string,
  execute: (mode?: 'normal' | 'basic') => Promise<L2PluginManagementSnapshot>
): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'errors:invalidClient' })
  const input = L2PluginManagementReloadRequestSchema.safeParse(await readPayload(request))
  if (!input.success)
    return createL4ApiErrorResponse(400, '请求参数无效', { key: 'errors:invalidInput' })

  try {
    return createL4ApiSuccessResponse(await execute(input.data.mode))
  } catch (error) {
    return pluginOperationError(error, action)
  }
}

async function handleSource<T>(
  request: Request,
  action: string,
  execute: (source: string) => Promise<T>
): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'errors:invalidClient' })
  const input = L2PluginManagementSourceRequestSchema.safeParse(await readPayload(request))
  if (!input.success)
    return createL4ApiErrorResponse(400, '插件来源无效', { key: 'errors:pluginSourceInvalid' })

  try {
    return createL4ApiSuccessResponse(await execute(input.data.source))
  } catch (error) {
    return pluginOperationError(error, action)
  }
}

export async function listL1Plugins(request: Request): Promise<Response> {
  const clientId = readL4ClientId(request)
  if (!clientId)
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'errors:invalidClient' })
  const input = L2PluginManagementListRequestSchema.safeParse(await readPayload(request))
  if (!input.success)
    return createL4ApiErrorResponse(400, '请求参数无效', { key: 'errors:invalidInput' })

  try {
    return createL4ApiSuccessResponse(
      await getL2PluginManagement().list(input.data.checkUpdates === true)
    )
  } catch (error) {
    return pluginOperationError(error, '查询插件')
  }
}

export function getL1Plugin(request: Request): Promise<Response> {
  return handleSource(request, '查询插件详情', (source) => getL2PluginManagement().get(source))
}

export function addL1Plugin(request: Request): Promise<Response> {
  return handleSource(request, '安装插件', (source) => getL2PluginManagement().add(source))
}

export function updateL1Plugin(request: Request): Promise<Response> {
  return handleSource(request, '更新插件', (source) => getL2PluginManagement().update(source))
}

export function deleteL1Plugin(request: Request): Promise<Response> {
  return handleSource(request, '删除插件', (source) => getL2PluginManagement().del(source))
}

export async function applyL1Plugins(request: Request): Promise<Response> {
  if (!readL4ClientId(request))
    return createL4ApiErrorResponse(400, '客户端标识无效', { key: 'errors:invalidClient' })
  const input = L2PluginManagementApplyRequestSchema.safeParse(await readPayload(request))
  if (!input.success)
    return createL4ApiErrorResponse(400, '请求参数无效', { key: 'errors:invalidInput' })
  try {
    return createL4ApiSuccessResponse(await getL2PluginManagement().apply(input.data.sources))
  } catch (error) {
    return pluginOperationError(error, '加载插件变更')
  }
}

export function reloadL1Plugins(request: Request): Promise<Response> {
  return handleRestart(request, '重启 Pi Desk', (mode) => getL2PluginManagement().reload(mode))
}
