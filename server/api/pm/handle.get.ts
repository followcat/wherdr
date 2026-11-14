// The tasks waiting for the user, for the sidebar's Tasks to handle: the
// board's Your turn, each with what to do.
import { board } from '../../utils/pmBoard'
import { pmStore } from '../../utils/pmStore'
import { toHandle, type ToHandle } from '../../../shared/pm/board'

export default defineApi(async (): Promise<ToHandle[]> => {
  const store = pmStore()
  return await store.enabled() ? toHandle((await board(store)).cards) : []
})
