// The board: each project's columns and every task's card.
import { board } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { coreAdminDeps } from '../../utils/coreAdminDeps'

export default defineApi(() => board(pmStore(), coreAdminDeps().machines()))
