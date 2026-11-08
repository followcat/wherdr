// Where the sidebar's Board button leads: the board when project management is
// on and has a project, otherwise Settings › Projects, where it is switched on
// and projects are added (an empty board would say nothing).
import type { PmOverview } from '#shared/pm/project'

export const BOARD_PATH = '/board'
export const BOARD_SETUP_PATH = '/settings?section=projects'

// `null`: the overview could not be read; the board shows its own error.
export function boardEntry(o: Pick<PmOverview, 'enabled' | 'projects'> | null): string {
  if (!o) return BOARD_PATH
  return o.enabled && o.projects.length ? BOARD_PATH : BOARD_SETUP_PATH
}
