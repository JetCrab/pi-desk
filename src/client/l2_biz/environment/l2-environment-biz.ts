import type { z } from 'zod'
import {
  L2EnvironmentHttp,
  type L2EnvironmentExportRequest,
  type L2EnvironmentGetResponse,
  type L2EnvironmentImportRequest,
  type L2EnvironmentOperation,
  type L2EnvironmentPreviewRequest,
  type L2EnvironmentPreviewResponse
} from '@common/l2_biz/environment/l2-environment-contract'
import {
  L2PiDirectoryEntryListRequestSchema,
  L2PiDirectoryEntryListResponseSchema,
  type L2PiDirectoryEntryListResponse
} from '@common/l2_biz/pi-session/l2-pi-session-contract'
import type { L4ApiResponse } from '@common/l4_foundation/http/l4-api-response-contract'
import { requestL4Api } from '@client/l4_foundation/lib/l4-api-request'
import { l4LocalizedErrorMessage } from '@client/l4_foundation/locale/l4-localized-error'

export class L2EnvironmentRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'L2EnvironmentRequestError'
  }
}

export interface L2EnvironmentBiz {
  get(signal: AbortSignal): Promise<L2EnvironmentGetResponse>
  export(input: L2EnvironmentExportRequest, signal: AbortSignal): Promise<{ id: string }>
  upload(file: File, signal: AbortSignal): Promise<{ id: string }>
  preview(
    input: L2EnvironmentPreviewRequest,
    signal: AbortSignal
  ): Promise<L2EnvironmentPreviewResponse>
  import(input: L2EnvironmentImportRequest, signal: AbortSignal): Promise<{ id: string }>
  getOperation(id: string, signal: AbortSignal): Promise<L2EnvironmentOperation>
  download(id: string, signal: AbortSignal): Promise<Blob>
  cancel(id: string, signal: AbortSignal): Promise<unknown>
  browse(cwd: string | null, signal: AbortSignal): Promise<L2PiDirectoryEntryListResponse>
}

export function createL2EnvironmentBiz(clientId: string): L2EnvironmentBiz {
  function json<I, O>(
    api: { path: string; request: z.ZodType<I>; response: z.ZodType<O> },
    input: I,
    signal: AbortSignal
  ): Promise<O> {
    return requestL4Api(clientId, api.path, api.request.parse(input), api.response, { signal })
  }

  async function responseFor(
    path: string,
    body: BodyInit,
    contentType: string,
    signal: AbortSignal
  ): Promise<Response> {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': contentType, 'X-Pi-Desk-Client-Id': clientId },
      body,
      signal
    })
    if (!response.ok || response.headers.get('Content-Type')?.includes('application/json')) {
      const envelope = (await response.clone().json()) as L4ApiResponse<unknown>
      if (!response.ok || envelope.code !== 0 || envelope.data === null) {
        throw new L2EnvironmentRequestError(response.status, l4LocalizedErrorMessage(envelope))
      }
    }
    return response
  }

  return {
    get: (signal) => json(L2EnvironmentHttp.get, {}, signal),
    export: (input, signal) => json(L2EnvironmentHttp.export, input, signal),
    upload: async (file, signal) => {
      const response = await responseFor(
        L2EnvironmentHttp.upload.path,
        file,
        'application/octet-stream',
        signal
      )
      const envelope = (await response.json()) as L4ApiResponse<unknown>
      if (envelope.code !== 0 || envelope.data === null)
        throw new Error(l4LocalizedErrorMessage(envelope))
      return L2EnvironmentHttp.upload.response.parse(envelope.data)
    },
    preview: (input, signal) => json(L2EnvironmentHttp.preview, input, signal),
    import: (input, signal) => json(L2EnvironmentHttp.import, input, signal),
    getOperation: async (id, signal) => {
      const api = L2EnvironmentHttp.getOperation
      const response = await responseFor(
        api.path,
        JSON.stringify(api.request.parse({ id })),
        'application/json',
        signal
      )
      const envelope = (await response.json()) as L4ApiResponse<unknown>
      return api.response.parse(envelope.data)
    },
    download: async (id, signal) => {
      const body = JSON.stringify(L2EnvironmentHttp.download.request.parse({ id }))
      const response = await responseFor(
        L2EnvironmentHttp.download.path,
        body,
        'application/json',
        signal
      )
      if (response.headers.get('Content-Type')?.includes('application/json')) {
        throw new Error('未收到加密备份文件')
      }
      return response.blob()
    },
    cancel: (id, signal) => json(L2EnvironmentHttp.cancel, { id }, signal),
    browse: (cwd, signal) =>
      json(
        {
          path: '/api/pi/directory-entries/list',
          request: L2PiDirectoryEntryListRequestSchema,
          response: L2PiDirectoryEntryListResponseSchema
        },
        { cwd },
        signal
      )
  }
}

export function downloadL2EnvironmentBlob(blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'pi-desk-environment.pidesk'
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
