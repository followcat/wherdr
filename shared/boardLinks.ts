// herdr-projects 1.x on the home list: which Herdr panes and spaces belong to
// the board. wherdr no longer reads the Board; these types remain for the
// notification rules (shared/notificationRules.ts).

// The board's five groups, in the order they need you (1.x: shown/states.rs).
export type TaskGroup = 'needs' | 'ready' | 'working' | 'todo' | 'done'
export interface TaskAgentIdentity { agent: string, reviewer: string, from: string }

// In Working, whether an agent runs or it waits for CI or its turn.
export type TaskActivity =
  | { kind: 'running' }
  | { kind: 'ci', passed: number | null, total: number | null }
  | { kind: 'queued', after: string | null, place: number | null }

// herdr-projects gives each helper of a task its own tab in the task's space
// (its docs/tabs.md): `Agent`, `Reviewer #N`, `Planner`, `Plan review`,
// `Agent A` / `Agent B` and `Picker`.
export type PaneRole = 'worker' | 'reviewer' | 'attempt' | 'planner'
// What its reviewer looks at: the work, the plan, or the attempts (the Picker).
export type ReviewKind = 'work' | 'plan' | 'pick'
export interface LinkedTask {
  identity?: TaskAgentIdentity
  id: string // `<repo>/<n>`
  repo: string
  n: number
  key: string // `WHR-2`, or `#2` while the repo's key is not known
  title: string
  // Its agents' panes (app ids), with their role; `letter`: an attempt's;
  // `kind`: the program on it, when the board says (`codex`).
  panes: { id: string, role: PaneRole, letter?: string, kind?: string }[]
  // What its reviewer pane is for, while one runs.
  review?: ReviewKind | null
  // The space the board made for it (app id), if any.
  workspace: string | null
  stage: string
  group?: TaskGroup
  // The Herdr session its link names (socketSession): which session's
  // coordinators it belongs to.
  session?: string
  // The board's report: progress (0-100), the line on what it does now, and
  // when the current agent's turn on it began (ms; the reviewer's while it reviews).
  progress: number | null
  msg: string
  since: number | null
  // In Working, whether an agent runs or it waits for CI or its turn, read from
  // the task's own stage and message (a watcher kept after its review says nothing of it).
  activity?: TaskActivity | null
}
export type CoordinatorLevel = 'top' | 'machine' | 'project'
export interface LinkedCoordinator {
  level: CoordinatorLevel
  repo?: string // a project coordinator's
  // Its folder under data/coordinator (one per Herdr session): with `level`
  // and `repo`, it names the coordinator across restarts (its pane changes).
  session?: string
  pane: string | null // app id
  workspace: string | null // app id
  // The conversation it resumes (its file's `session`): Herdr's integration
  // reports the same on its pane (`agent_session`), whatever the pane's id.
  agentSession?: string
}
// A repo of the board (data/repos.json) and its main checkout: its branch and
// how many commits it is behind its upstream, as git last knew it (null: unknown).
export interface RepoInfo { repo: string, root: string, branch: string, behind: number | null }
// One board (a base machine): its tasks, coordinators and repos.
export interface MachineLinks { machine: string, tasks: LinkedTask[], coordinators: LinkedCoordinator[], repos?: RepoInfo[] }
