import 'server-only'
import { L3ProjectFileReveal } from '@common/l3_modules/project-files/l3-project-files-contract'
import { revealL2ProjectPath } from '@server/l2_biz/project-preview/l2-project-preview-actions'
import { createL1ProjectRoute } from './l1-project-route'

export const POST = createL1ProjectRoute(L3ProjectFileReveal, revealL2ProjectPath)
