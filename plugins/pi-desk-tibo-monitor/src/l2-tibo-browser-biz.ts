import type { BrowserPluginHost } from '@jetcrab/pi-desk-sdk/browser'
import {
  modelsResponseSchema,
  recordResponseSchema,
  snapshotSchema,
  type TiboModelOption,
  type TiboRecord,
  type TiboSettings,
  type TiboSnapshot
} from './l4-tibo-protocol.js'

export class TiboBrowserBiz {
  constructor(private readonly host: BrowserPluginHost) {}

  async snapshot(): Promise<TiboSnapshot> {
    return snapshotSchema.parse(await this.host.piDesk.invokeGlobal('state-get', {}))
  }

  async models(): Promise<TiboModelOption[]> {
    return modelsResponseSchema.parse(await this.host.piDesk.invokeGlobal('models-list', {})).models
  }

  async save(settings: TiboSettings): Promise<TiboSnapshot> {
    return snapshotSchema.parse(await this.host.piDesk.invokeGlobal('settings-save', settings))
  }

  async record(id: string): Promise<TiboRecord | null> {
    return recordResponseSchema.parse(await this.host.piDesk.invokeGlobal('record-get', { id }))
      .record
  }

  async translate(id: string): Promise<TiboRecord | null> {
    return recordResponseSchema.parse(
      await this.host.piDesk.invokeGlobal('record-translate', { id })
    ).record
  }
}
