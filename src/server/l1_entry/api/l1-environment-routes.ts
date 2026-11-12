import 'server-only'

import { L2EnvironmentHttp } from '@common/l2_biz/environment/l2-environment-contract'
import { L4EnvironmentValidationError } from '@server/l4_foundation/environment/l4-environment-error'
import {
  getL2Environment,
  L2EnvironmentOperations
} from '@server/l2_biz/environment/l2-environment'
import {
  createL4ApiErrorResponse,
  createL4ApiSuccessResponse
} from '@server/l4_foundation/http/l4-api-response'

type Action = keyof typeof L2EnvironmentHttp

export async function handleL1EnvironmentRequest(
  action: Action,
  request: Request
): Promise<Response> {
  try {
    const operations = L2EnvironmentOperations
    if (action === 'upload') {
      if (!request.body) return createL4ApiErrorResponse(400, '备份上传请求体为空')
      if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/octet-stream')
        return createL4ApiErrorResponse(
          415,
          '备份上传必须使用 application/octet-stream 原始二进制流'
        )
      return createL4ApiSuccessResponse(
        await operations.upload(request.body, request.headers.get('content-length'))
      )
    }
    let payload: unknown
    try {
      payload = await request.json()
    } catch {
      return createL4ApiErrorResponse(400, '请求 JSON 格式无效')
    }
    switch (action) {
      case 'get': {
        L2EnvironmentHttp.get.request.parse(payload)
        return createL4ApiSuccessResponse(getL2Environment())
      }
      case 'export':
        return createL4ApiSuccessResponse(
          await operations.export(L2EnvironmentHttp.export.request.parse(payload))
        )
      case 'preview': {
        const input = L2EnvironmentHttp.preview.request.parse(payload)
        return createL4ApiSuccessResponse(await operations.preview(input))
      }
      case 'import':
        return createL4ApiSuccessResponse(
          await operations.import(L2EnvironmentHttp.import.request.parse(payload))
        )
      case 'getOperation':
        return createL4ApiSuccessResponse(
          await operations.get(L2EnvironmentHttp.getOperation.request.parse(payload).id)
        )
      case 'download':
        return await operations.download(L2EnvironmentHttp.download.request.parse(payload).id)
      case 'cancel':
        return createL4ApiSuccessResponse(
          await operations.cancel(L2EnvironmentHttp.cancel.request.parse(payload).id)
        )
    }
  } catch (error) {
    console.warn('[Pi Desk][EnvironmentApi] 环境操作被拒绝', {
      phase: action,
      errorName: error instanceof Error ? error.name : 'UnknownError'
    })
    // Schema/解析器错误可能包含配置片段或密码，不能直接转发。
    if (error instanceof L4EnvironmentValidationError)
      return createL4ApiErrorResponse(409, error.message)
    const name = error instanceof Error ? error.name : ''
    if (name === 'ZodError' || name === 'SyntaxError')
      return createL4ApiErrorResponse(400, '环境备份参数或归档格式无效')
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
      return createL4ApiErrorResponse(404, '环境操作或恢复目标不存在')
    if (action === 'preview')
      return createL4ApiErrorResponse(400, '备份解密或校验失败，请检查密码与文件完整性')
    return createL4ApiErrorResponse(
      409,
      '环境操作未能执行，请检查受管重启能力、目标映射、选择集和文件冲突'
    )
  }
}
