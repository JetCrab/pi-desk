import 'server-only'

import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { canL4EnvironmentDesktop } from '@server/l4_foundation/environment/l4-environment-desktop'
import { L4EnvironmentOperations } from '@server/l4_foundation/environment/l4-environment-operations'
import {
  canRestartL4PiDesk,
  scheduleL4PiDeskEnvironmentMaintenance
} from '@server/l4_foundation/pi/l4-pi-desk-process-control'
import {
  L2EnvironmentHttp,
  type L2EnvironmentGetResponse,
  type L2EnvironmentExportRequest,
  type L2EnvironmentImportRequest,
  type L2EnvironmentPreviewRequest,
  type L2EnvironmentPreviewResponse,
  type L2EnvironmentOperation
} from '@common/l2_biz/environment/l2-environment-contract'

type EnvironmentRestart = <T>(operation: () => Promise<T>) => Promise<T>

export function initializeL2Environment(input: { runPluginRestart: EnvironmentRestart }): void {
  globalThis.__piDeskEnvironmentRestart = input.runPluginRestart
}

export function getL2Environment(): L2EnvironmentGetResponse {
  return {
    canRestart: canRestartL4PiDesk(),
    desktopAvailable: canL4EnvironmentDesktop(getAgentDir())
  }
}

function environmentOperations(): L4EnvironmentOperations {
  globalThis.__piDeskEnvironmentOperations ??= new L4EnvironmentOperations({
    agentDir: getAgentDir(),
    cwd: process.cwd(),
    canRestart: canRestartL4PiDesk,
    schedule: async (request): Promise<void> => {
      const restart = globalThis.__piDeskEnvironmentRestart
      if (!restart) throw new Error('宿主维护组合入口尚未初始化')
      await restart(async (): Promise<void> => {
        scheduleL4PiDeskEnvironmentMaintenance(request)
      })
    }
  })
  return globalThis.__piDeskEnvironmentOperations
}

export const L2EnvironmentOperations = {
  async get(id: string): Promise<L2EnvironmentOperation> {
    return L2EnvironmentHttp.getOperation.response.parse(await environmentOperations().get(id))
  },
  async export(input: L2EnvironmentExportRequest): Promise<{ id: string }> {
    return L2EnvironmentHttp.export.response.parse(await environmentOperations().export(input))
  },
  async import(input: L2EnvironmentImportRequest): Promise<{ id: string }> {
    return L2EnvironmentHttp.import.response.parse(await environmentOperations().import(input))
  },
  async preview(input: L2EnvironmentPreviewRequest): Promise<L2EnvironmentPreviewResponse> {
    return L2EnvironmentHttp.preview.response.parse(
      await environmentOperations().preview(input.id, input.password, input.mappings)
    )
  },
  async upload(body: ReadableStream<Uint8Array>, length: string | null): Promise<{ id: string }> {
    return L2EnvironmentHttp.upload.response.parse(
      await environmentOperations().upload(body, length)
    )
  },
  async download(id: string): Promise<Response> {
    return environmentOperations().download(id)
  },
  async cancel(id: string): Promise<Record<string, never>> {
    return environmentOperations().cancel(id)
  }
}

declare global {
  var __piDeskEnvironmentOperations: L4EnvironmentOperations | undefined
  var __piDeskEnvironmentRestart: EnvironmentRestart | undefined
}
