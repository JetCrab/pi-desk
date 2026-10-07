import 'server-only'

import { L2TaskCenterRuntime } from '@server/l2_biz/task-center/l2-task-center-runtime'
import { L2ChatSourceBindingError } from '@server/l2_biz/work-session/l2-work-session-chat-runtime'
import { getL2WorkSessionManage } from '@server/l2_biz/work-session/l2-work-session-manage'
import {
  getL4PiWorkSessionRuntime,
  type L4PiWorkSessionRuntime
} from '@server/l4_foundation/pi/l4-pi-work-session-runtime'

declare global {
  var __piDeskTaskCenterRuntime: L2TaskCenterRuntime | undefined
}

export function getL1TaskCenterRuntime(): L2TaskCenterRuntime {
  if (!globalThis.__piDeskTaskCenterRuntime) {
    const manage = getL2WorkSessionManage()
    globalThis.__piDeskTaskCenterRuntime = new L2TaskCenterRuntime(
      async (source): Promise<L4PiWorkSessionRuntime> => {
        const workSession = await manage.getWorkSession(source.workId)
        if (
          !workSession ||
          workSession.sessionId !== source.sessionId ||
          workSession.branchId !== source.branchId
        ) {
          throw new L2ChatSourceBindingError(source)
        }
        return getL4PiWorkSessionRuntime(source.sessionId)
      }
    )
  }
  return globalThis.__piDeskTaskCenterRuntime
}
