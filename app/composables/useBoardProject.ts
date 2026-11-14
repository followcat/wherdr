// The board's project picker (BoardView.vue), kept on the server so it follows
// the user: Follow machine tab, All projects, or a project's fixed key; null
// until the user picks (then Follow once machine groups exist, else All).
import { syncedRef } from './useSyncedSettings'

export const BOARD_FOLLOW = 'follow'
export const BOARD_ALL = 'all'
export const boardProject = syncedRef<string | null>('boardProject', raw => raw || null, v => v || null)
