import { z } from 'zod'
import {
  L4EnvironmentFileDeclarationSchema,
  L4EnvironmentPackageDeclarationSchema
} from '@common/l4_foundation/environment/l4-environment-file-contract'

export const L2EnvironmentIdSchema = z.string().uuid()
export const L2EnvironmentGetRequestSchema = z.object({}).strict()
export const L2EnvironmentGetResponseSchema = z.object({
  canRestart: z.boolean(),
  desktopAvailable: z.boolean()
})
export const L2EnvironmentExportRequestSchema = z
  .object({
    password: z.string().min(1).max(4096),
    includeSessions: z.boolean(),
    includePluginData: z.boolean()
  })
  .strict()
export const L2EnvironmentIdResponseSchema = z.object({ id: L2EnvironmentIdSchema })
export const L2EnvironmentUploadResponseSchema = L2EnvironmentIdResponseSchema
export const L2EnvironmentExportResponseSchema = L2EnvironmentIdResponseSchema
export const L2EnvironmentPreviewRequestSchema = z
  .object({
    id: L2EnvironmentIdSchema,
    password: z.string().min(1).max(4096),
    mappings: z
      .array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict())
      .optional()
  })
  .strict()
export const L2EnvironmentItemSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  category: z.enum(['config', 'plugin-data', 'session']),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  sourceCwd: z.string().nullable(),
  sessionId: z.string().nullable(),
  mappingSources: z.array(z.string()),
  conflicts: z.array(z.string()),
  warnings: z.array(z.string())
})
export const L2EnvironmentPreviewResponseSchema = z.object({
  id: L2EnvironmentIdSchema,
  sourcePlatform: z.enum(['win32', 'darwin', 'linux']),
  items: z.array(L2EnvironmentItemSchema),
  warnings: z.array(z.string())
})
export const L2EnvironmentImportRequestSchema = z
  .object({
    id: L2EnvironmentIdSchema,
    selectedIds: z.array(z.string().min(1)).min(1),
    mappings: z.array(z.object({ from: z.string().min(1), to: z.string().min(1) }).strict()),
    overwrite: z.boolean()
  })
  .strict()
export const L2EnvironmentImportResponseSchema = L2EnvironmentIdResponseSchema
export const L2EnvironmentGetOperationRequestSchema = z
  .object({ id: L2EnvironmentIdSchema })
  .strict()
export const L2EnvironmentOperationSchema = z.object({
  id: L2EnvironmentIdSchema,
  kind: z.enum(['export', 'import']),
  status: z.enum(['pending', 'running', 'ready', 'completed', 'failed']),
  phase: z.string(),
  error: z.string().nullable(),
  warnings: z.array(z.string()),
  expiresAt: z.number().int()
})
export const L2EnvironmentGetOperationResponseSchema = L2EnvironmentOperationSchema
export const L2EnvironmentDownloadRequestSchema = L2EnvironmentGetOperationRequestSchema
export const L2EnvironmentCancelRequestSchema = L2EnvironmentGetOperationRequestSchema
export const L2EnvironmentCancelResponseSchema = z.object({}).strict()

// 静态声明只描述文件及已知本地字段，不执行安装包代码。
export const L2EnvironmentFileSchema = L4EnvironmentFileDeclarationSchema
export const L2EnvironmentPackageSchema = L4EnvironmentPackageDeclarationSchema

export const L2EnvironmentHttp = {
  get: {
    path: '/api/environment/get',
    request: L2EnvironmentGetRequestSchema,
    response: L2EnvironmentGetResponseSchema
  },
  export: {
    path: '/api/environment/export',
    request: L2EnvironmentExportRequestSchema,
    response: L2EnvironmentExportResponseSchema
  },
  upload: { path: '/api/environment/upload', response: L2EnvironmentUploadResponseSchema },
  preview: {
    path: '/api/environment/preview',
    request: L2EnvironmentPreviewRequestSchema,
    response: L2EnvironmentPreviewResponseSchema
  },
  import: {
    path: '/api/environment/import',
    request: L2EnvironmentImportRequestSchema,
    response: L2EnvironmentImportResponseSchema
  },
  getOperation: {
    path: '/api/environment/get-operation',
    request: L2EnvironmentGetOperationRequestSchema,
    response: L2EnvironmentGetOperationResponseSchema
  },
  download: { path: '/api/environment/download', request: L2EnvironmentDownloadRequestSchema },
  cancel: {
    path: '/api/environment/cancel',
    request: L2EnvironmentCancelRequestSchema,
    response: L2EnvironmentCancelResponseSchema
  }
} as const

export type L2EnvironmentGetRequest = z.infer<typeof L2EnvironmentGetRequestSchema>
export type L2EnvironmentExportResponse = z.infer<typeof L2EnvironmentExportResponseSchema>
export type L2EnvironmentUploadResponse = z.infer<typeof L2EnvironmentUploadResponseSchema>
export type L2EnvironmentImportResponse = z.infer<typeof L2EnvironmentImportResponseSchema>
export type L2EnvironmentGetOperationRequest = z.infer<
  typeof L2EnvironmentGetOperationRequestSchema
>
export type L2EnvironmentGetOperationResponse = z.infer<
  typeof L2EnvironmentGetOperationResponseSchema
>
export type L2EnvironmentDownloadRequest = z.infer<typeof L2EnvironmentDownloadRequestSchema>
export type L2EnvironmentCancelRequest = z.infer<typeof L2EnvironmentCancelRequestSchema>
export type L2EnvironmentCancelResponse = z.infer<typeof L2EnvironmentCancelResponseSchema>
export type L2EnvironmentGetResponse = z.infer<typeof L2EnvironmentGetResponseSchema>
export type L2EnvironmentExportRequest = z.infer<typeof L2EnvironmentExportRequestSchema>
export type L2EnvironmentPreviewRequest = z.infer<typeof L2EnvironmentPreviewRequestSchema>
export type L2EnvironmentPreviewResponse = z.infer<typeof L2EnvironmentPreviewResponseSchema>
export type L2EnvironmentImportRequest = z.infer<typeof L2EnvironmentImportRequestSchema>
export type L2EnvironmentOperation = z.infer<typeof L2EnvironmentOperationSchema>
export type L2EnvironmentItem = z.infer<typeof L2EnvironmentItemSchema>
export type L2EnvironmentFile = z.infer<typeof L2EnvironmentFileSchema>
export type L2EnvironmentPackage = z.infer<typeof L2EnvironmentPackageSchema>
