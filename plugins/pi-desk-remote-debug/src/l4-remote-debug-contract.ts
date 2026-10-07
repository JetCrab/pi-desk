import { z } from 'zod'

export const remoteDebugPortSchema = z.number().int().min(1).max(65_535)
export const remoteDebugRangeSchema = z
  .strictObject({
    start: remoteDebugPortSchema,
    end: remoteDebugPortSchema
  })
  .refine((value) => value.start <= value.end, { message: '起始端口不能大于结束端口' })
export const remoteDebugRangesSchema = z.strictObject({
  localRange: remoteDebugRangeSchema,
  publicRange: remoteDebugRangeSchema
})
export const remoteDebugRegistrationSchema = z.strictObject({
  cwd: z.string().min(1),
  profile: z.string().min(1),
  entryPort: remoteDebugPortSchema,
  routePorts: z.array(remoteDebugPortSchema),
  publicPort: remoteDebugPortSchema,
  tunnelServer: z.string().nullable()
})
export const remoteDebugSettingsSchema = remoteDebugRangesSchema.extend({
  registrations: z.array(remoteDebugRegistrationSchema),
  tunnelServer: z.string().nullable()
})
export const remoteDebugProfileDraftSchema = z.strictObject({
  name: z.string().trim().min(1).max(64),
  description: z.string().trim().max(240).default(''),
  command: z.string().trim().min(1).max(8192),
  entryPort: remoteDebugPortSchema.nullable(),
  publicPort: remoteDebugPortSchema.nullable(),
  routes: z.array(
    z.strictObject({ path: z.string(), targetPort: remoteDebugPortSchema.nullable() })
  )
})
export const remoteDebugProjectSaveSchema = z.strictObject({
  cwd: z.string().min(1),
  profiles: z.array(remoteDebugProfileDraftSchema).min(1)
})
export const remoteDebugRegistrationDeleteSchema = z.strictObject({
  cwd: z.string().min(1),
  profile: z.string().min(1),
  tunnelServer: z.string().nullable()
})
export type RemoteDebugRange = z.infer<typeof remoteDebugRangeSchema>
export type RemoteDebugRanges = z.infer<typeof remoteDebugRangesSchema>
export type RemoteDebugRegistration = z.infer<typeof remoteDebugRegistrationSchema>
export type RemoteDebugSettings = z.infer<typeof remoteDebugSettingsSchema>
export type RemoteDebugProfileDraft = z.infer<typeof remoteDebugProfileDraftSchema>
export type RemoteDebugProjectSave = z.infer<typeof remoteDebugProjectSaveSchema>
export type RemoteDebugRegistrationDelete = z.infer<typeof remoteDebugRegistrationDeleteSchema>

export const DEFAULT_REMOTE_DEBUG_RANGES: RemoteDebugRanges = {
  localRange: { start: 43000, end: 43999 },
  publicRange: { start: 11001, end: 11099 }
}
