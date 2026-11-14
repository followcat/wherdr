// The setup wizard of project management: three steps for one project, each
// done or not from what the server reports. Pure, so the board, the settings
// and the tests read the same answer. No workflow step: the project's
// coordinator sets it up with the user once it runs.
import type { Pane } from '../types'
import type { PmOverview } from './project'

export const SETUP_STEPS = ['enable', 'project', 'coordinator'] as const
export type SetupStepId = (typeof SETUP_STEPS)[number]
export type SetupDone = Record<SetupStepId, boolean>

// Only what the wizard needs from a coordinator: its project and whether a
// conversation was started (it then has a terminal).
type Coord = { project: string, terminal?: string }
type Overview = Pick<PmOverview, 'enabled' | 'projects'>

// start: its coordinator's state from its live pane (the wizard): step 3 is
// done only once it runs, not while its pane has not arrived, starts or asks something.
export function setupDone(o: Overview | null, key: string | undefined, coords: Coord[] = [], start?: CoordinatorStart): SetupDone {
  const p = o?.enabled ? o.projects.find(x => x.key === key && x.git !== false) : undefined
  return {
    enable: !!o?.enabled,
    project: !!p,
    coordinator: !!p && coords.some(c => c.project === p.key && !!c.terminal) && (start === undefined || start === 'runs'),
  }
}

// Step 3 from its coordinator's pane: not started, starting (no state yet, or
// one core cannot tell), asking something before it can work (a dialog, a
// login), or running (idle, working, done).
export type CoordinatorStart = 'none' | 'starting' | 'asks' | 'runs'
export function coordinatorStart(pane?: Pick<Pane, 'status' | 'prompt' | 'screen'>): CoordinatorStart {
  if (!pane) return 'none'
  if (pane.status === 'blocked' || pane.prompt || pane.screen) return 'asks'
  return pane.status && pane.status !== 'unknown' ? 'runs' : 'starting'
}

export const setupCount = (d: SetupDone) => SETUP_STEPS.filter(s => d[s]).length
// Where the wizard opens: the first step left, or past the last when all are done.
export const setupResume = (d: SetupDone) => {
  const i = SETUP_STEPS.findIndex(s => !d[s])
  return i < 0 ? SETUP_STEPS.length : i
}

// The project the wizard finishes: the first git project with a step left, else the first one.
export function setupProject(o: Overview | null, coords: Coord[] = []): string | undefined {
  const git = o?.projects.filter(p => p.git !== false) ?? []
  return (git.find(p => setupCount(setupDone(o, p.key, coords)) < SETUP_STEPS.length) ?? git[0])?.key
}

// Set up: one project's coordinator was started, with or without a workflow
// yet. The board then shows nothing.
export const setupComplete = (o: Overview | null, coords: Coord[] = []) =>
  !!o?.projects.some(p => setupCount(setupDone(o, p.key, coords)) === SETUP_STEPS.length)
