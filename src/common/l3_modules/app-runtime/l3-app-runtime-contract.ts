import { z } from 'zod'
import { HostRegionSchema, HostSettingsSchema } from '@jetcrab/pi-desk-sdk/settings'
import { L3CapabilityModeNamesSchema } from '@common/l3_modules/capability-modes/l3-capability-modes-contract'
import {
  L3PluginEventNameSchema,
  L3PluginJsonObjectSchema,
  L3PluginNameSchema
} from '@common/l3_modules/plugin-host/l3-plugin-json-contract'
import { L4TimestampMsSchema } from '@common/l4_foundation/l4-timestamp-contract'

export const L3AppNotificationIdSchema = z.string().uuid()
export const L3AppNotificationLevelSchema = z.enum(['info', 'success', 'warning', 'error'])
export const L3AppNotificationTitleSchema = z.string().trim().min(1).max(120)
export const L3AppNotificationDescriptionSchema = z.string().trim().max(320).nullable()

export const L3PluginAppNotificationEventSchema = z
  .object({
    type: z.literal('plugin'),
    pluginName: L3PluginNameSchema,
    name: L3PluginEventNameSchema,
    data: L3PluginJsonObjectSchema
  })
  .strict()

export const L3AppNotificationEventSchema = L3PluginAppNotificationEventSchema

export const L3AppNotificationSchema = z
  .object({
    notificationId: L3AppNotificationIdSchema,
    level: L3AppNotificationLevelSchema,
    title: L3AppNotificationTitleSchema,
    description: L3AppNotificationDescriptionSchema,
    createdAt: L4TimestampMsSchema,
    event: L3AppNotificationEventSchema.nullable()
  })
  .strict()

export const L3AppRuntimePluginsSchema = z.record(L3PluginNameSchema, L3PluginJsonObjectSchema)

export const L3AppRuntimeSchema = z
  .object({
    mode: z.enum(['normal', 'basic']).default('normal'),
    notifications: z.array(L3AppNotificationSchema),
    plugins: L3AppRuntimePluginsSchema,
    capabilityModes: L3CapabilityModeNamesSchema,
    settings: HostSettingsSchema.default({ region: { locale: 'en', timeZone: 'UTC' } })
  })
  .strict()

export const L3AppNotificationChangesSchema = z
  .object({
    level: L3AppNotificationLevelSchema.optional(),
    title: L3AppNotificationTitleSchema.optional(),
    description: L3AppNotificationDescriptionSchema.optional()
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'notification changes cannot be empty'
  })

export const L3AppNotificationAddUpdateSchema = z
  .object({
    type: z.literal('add'),
    notification: L3AppNotificationSchema
  })
  .strict()

export const L3AppNotificationChangeUpdateSchema = z
  .object({
    type: z.literal('update'),
    notificationId: L3AppNotificationIdSchema,
    changes: L3AppNotificationChangesSchema
  })
  .strict()

export const L3AppNotificationDeleteUpdateSchema = z
  .object({
    type: z.literal('delete'),
    notificationId: L3AppNotificationIdSchema
  })
  .strict()

export const L3AppNotificationUpdateSchema = z.discriminatedUnion('type', [
  L3AppNotificationAddUpdateSchema,
  L3AppNotificationChangeUpdateSchema,
  L3AppNotificationDeleteUpdateSchema
])

export const L3AppPluginStateUpdateSchema = z
  .object({
    pluginName: L3PluginNameSchema,
    state: L3PluginJsonObjectSchema.nullable()
  })
  .strict()

const L3AppCapabilityModesUpdateSchema = z
  .object({ key: z.literal('capabilityModes'), update: L3CapabilityModeNamesSchema })
  .strict()

const L3AppSettingsUpdateSchema = z
  .object({ key: z.literal('settings'), update: HostSettingsSchema })
  .strict()

export const L3AppRuntimeModuleUpdateSchema = z.discriminatedUnion('key', [
  L3AppSettingsUpdateSchema,
  L3AppCapabilityModesUpdateSchema,
  z
    .object({
      key: z.literal('notifications'),
      update: L3AppNotificationUpdateSchema
    })
    .strict(),
  z
    .object({
      key: z.literal('plugins'),
      update: L3AppPluginStateUpdateSchema
    })
    .strict()
])

export const L3AppRuntimeEventSchema = z.union([
  L3AppSettingsUpdateSchema.extend({ type: z.literal('update') }),
  L3AppCapabilityModesUpdateSchema.extend({ type: z.literal('update') }),
  z
    .object({
      type: z.literal('replace'),
      runtime: L3AppRuntimeSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('update'),
      key: z.literal('notifications'),
      update: L3AppNotificationUpdateSchema
    })
    .strict(),
  z
    .object({
      type: z.literal('update'),
      key: z.literal('plugins'),
      update: L3AppPluginStateUpdateSchema
    })
    .strict()
])

export const L3AppRuntimeApplyRequestSchema = z.discriminatedUnion('key', [
  z
    .object({ key: z.literal('notifications'), update: L3AppNotificationDeleteUpdateSchema })
    .strict(),
  z
    .object({
      key: z.literal('settings'),
      update: z
        .object({
          region: HostRegionSchema.unwrap()
            .partial()
            .strict()
            .refine((value) => Object.keys(value).length > 0, '地区更新不能为空')
        })
        .strict()
    })
    .strict()
])

export const L3AppRuntimeApplyResponseSchema = z.object({}).strict()

export const L3PluginNotificationEventInputSchema = z
  .object({
    name: L3PluginEventNameSchema,
    data: L3PluginJsonObjectSchema
  })
  .strict()

export const L3PluginNotificationPublishInputSchema = z
  .object({
    level: L3AppNotificationLevelSchema,
    title: L3AppNotificationTitleSchema,
    description: z.string().trim().max(320).optional(),
    event: L3PluginNotificationEventInputSchema.optional()
  })
  .strict()

export const L3PluginNotificationChangesSchema = z
  .object({
    level: L3AppNotificationLevelSchema.optional(),
    title: L3AppNotificationTitleSchema.optional(),
    description: L3AppNotificationDescriptionSchema.optional()
  })
  .strict()
  .refine((changes) => Object.keys(changes).length > 0, {
    message: 'plugin notification changes cannot be empty'
  })

export type L3AppNotificationLevel = z.infer<typeof L3AppNotificationLevelSchema>
export type L3PluginAppNotificationEvent = z.infer<typeof L3PluginAppNotificationEventSchema>
export type L3AppNotificationEvent = z.infer<typeof L3AppNotificationEventSchema>
export type L3AppNotification = z.infer<typeof L3AppNotificationSchema>
export type L3AppRuntime = z.infer<typeof L3AppRuntimeSchema>
export type L3AppNotificationChanges = z.infer<typeof L3AppNotificationChangesSchema>
export type L3AppNotificationUpdate = z.infer<typeof L3AppNotificationUpdateSchema>
export type L3AppPluginStateUpdate = z.infer<typeof L3AppPluginStateUpdateSchema>
export type L3AppRuntimeModuleUpdate = z.infer<typeof L3AppRuntimeModuleUpdateSchema>
export type L3AppRuntimeEvent = z.infer<typeof L3AppRuntimeEventSchema>
export type L3AppRuntimeApplyRequest = z.infer<typeof L3AppRuntimeApplyRequestSchema>
export type L3AppRuntimeApplyResponse = z.infer<typeof L3AppRuntimeApplyResponseSchema>
export type L3PluginNotificationPublishInput = z.infer<
  typeof L3PluginNotificationPublishInputSchema
>
export type L3PluginNotificationChanges = z.infer<typeof L3PluginNotificationChangesSchema>
