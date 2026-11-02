// herdr-projects 1.x on the home list: which Herdr panes and spaces belong to
// the board, and the groups the list draws from that (one per repo: its
// project coordinator, then its tasks' agents; the machine's Coordinator and
// machine coordinator above them).
//
// What the board knows is read from its files only (server/utils/boardLinks.ts),
// never through its CLI, whose every command also runs the board's upkeep:
//  - a task's `task.json` (data/tasks/<repo>/<n>): `link.pane`, `link.workspace`
//    (`ownsWorkspace`: the board made that space for it), `link.reviewer`
//    (`pane`, `kind`: its program; set while a review runs, null after), in
//    the session `link.socket` names. While a planner of its own writes the
//    plan, `link.pane` is the planner's and `plan.home.pane` the agent's;
//    `comparing`: the reviewer compares the attempts (the Picker);
//  - an attempt's `task.json` (data/tasks/<repo>/<n><letter>, `attemptOf`);
//  - each coordinator's `state.json` (data/coordinator/<session>/state.json,
//    `machine/state.json`, `projects/<repo>/state.json`): `pane`, `space`,
//    and `session`, its conversation (resolveCoordinators: when the pane is gone).
// Pure functions, tested in tests/boardLinks.test.ts.
import { rowFromTaskFile, taskAgentIdentity, type TaskAgentIdentity, type TaskGroup } from './projectsTasks'
import type { Pane, Workspace } from './types'
import { type TaskActivity, taskActivity } from './taskActivity'
import { type RowGroup, type Row, leadPane, rowGroup } from './spaces'
import { joinId, machineOf } from './ids'

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
export interface BoardLinks { version: string, machines: MachineLinks[] }
export type BoardLinksReply = BoardLinks | { same: true, version: string }

type Raw = Record<string, unknown>
const obj = (v: unknown): Raw | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Raw : null)
const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '')
const PANE_LOCAL_RE = /^w[0-9a-z]+:p[0-9a-z]+$/i
const SPACE_LOCAL_RE = /^w[0-9a-z]+$/i
const REPO_RE = /^[A-Za-z0-9][\w.-]{0,79}$/
// A task folder (`12`) or an attempt's (`12a`).
export const TASK_DIR_RE = /^\d{1,7}[a-e]?$/

// The machine key of the session a socket names (null: one wherdr has not opened).
export type SessionKey = (socket: unknown) => string | null
// The Herdr session a socket names (`…/sessions/<name>/herdr.sock`, else
// `default`); no socket: the board's own session `own`, as herdr-projects reads it.
export function socketSession(socket: unknown, own: string): string {
  if (typeof socket !== 'string' || !socket) return own
  const parts = socket.split('/')
  const n = parts.length
  return n >= 3 && parts[n - 1] === 'herdr.sock' && parts[n - 3] === 'sessions' ? parts[n - 2]!.slice(0, 80) : 'default'
}

const paneOf = (key: string | null, v: unknown) => (key !== null && typeof v === 'string' && PANE_LOCAL_RE.test(v) ? joinId(key, v) : null)
const spaceOf = (key: string | null, v: unknown) => (key !== null && typeof v === 'string' && SPACE_LOCAL_RE.test(v) ? joinId(key, v) : null)

// What a `task.json` links to. An attempt (`attemptOf`) comes back as its
// task's id with its pane as an attempt; the caller merges it into the task.
export interface FileLinks extends Pick<LinkedTask, 'stage' | 'progress' | 'msg' | 'since' | 'review' | 'group' | 'identity' | 'session' | 'activity'> { id: string, repo: string, n: number, title: string, attemptOf: string | null, letter: string, archived: boolean, panes: LinkedTask['panes'], workspace: string | null }
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export function linksFromTaskFile(t: unknown, sessionKey: SessionKey, sessionName?: (socket: unknown) => string): FileLinks | null {
  const r = obj(t)
  if (!r) return null
  const id = str(r.id, 100)
  const m = /^([A-Za-z0-9][\w.-]{0,79})\/(\d{1,7})([a-e]?)$/.exec(id)
  if (!m) return null
  const attemptOf = m[3] ? str(r.attemptOf, 100) : ''
  if (m[3] && attemptOf !== `${m[1]}/${m[2]}`) return null
  const link = obj(r.link)
  const key = link ? sessionKey(link.socket) : null
  const panes: LinkedTask['panes'] = []
  const kind = (v: unknown) => { const k = str(v, 30); return /^[a-z][\w-]*$/i.test(k) ? { kind: k } : {} }
  // A plan not yet approved; `home`: the agent's own pane while a planner writes it.
  const plan = obj(r.plan)
  const planOpen = Boolean(plan) && !plan!.approvedAt
  const home = planOpen ? obj(plan!.home) : null
  const worker = paneOf(key, link?.pane)
  const letter = m[3] ? (str(r.letter, 1) || m[3]).toUpperCase() : ''
  const agentPane = home ? paneOf(key, home.pane) : null
  if (agentPane) panes.push({ id: agentPane, role: 'worker', ...kind(home!.agent) })
  if (worker) panes.push(attemptOf ? { id: worker, role: 'attempt', letter, ...kind(r.agent) } : { id: worker, role: home ? 'planner' : 'worker', ...kind(r.agent) })
  const rv = obj(link?.reviewer)
  const reviewer = paneOf(key, rv?.pane)
  if (reviewer) panes.push({ id: reviewer, role: 'reviewer', ...kind(rv!.kind) })
  const stage = str(r.stage, 30)
  const watch = obj(r.watch)
  const progress = num(watch?.progress)
  // When the turn on it began, as the board counts it (flow/state.rs began).
  // The task's own line is the board's word on what happens now; a watcher's
  // line (kept after a review: close_reviewer drops the link, not `watch`) only
  // while an agent really runs on it.
  const group = rowFromTaskFile(r, null)?.group
  const ownMsg = str(r.msg, 400)
  const activity = taskActivity({ group: group ?? '', stage, msg: ownMsg })
  const running = !activity || activity.kind === 'running'
  const began = stage === 'reviewing' ? num(r.reviewAt) : Math.max(num(r.since) ?? 0, num(r.workAt) ?? 0) || null
  return {
    id: attemptOf || id, repo: m[1]!, n: Number(m[2]), title: str(r.title).replace(/\s+/g, ' ').trim(),
    attemptOf: attemptOf || null, letter, archived: Boolean(r.archivedAt),
    panes, workspace: link?.ownsWorkspace === true ? spaceOf(key, link.workspace) : null,
    stage,
    ...(link && sessionName ? { session: sessionName(link.socket) } : {}),
    identity: taskAgentIdentity(r),
    group,
    activity,
    review: reviewer ? (r.comparing ? 'pick' : planOpen ? 'plan' : 'work') : null,
    progress: progress === null || !running ? null : Math.max(0, Math.min(100, Math.round(progress))),
    msg: ((running && str(watch?.msg, 400)) || ownMsg).replace(/\s+/g, ' ').trim(),
    since: began && began > 0 ? began : null,
  }
}

// Tasks from their files' links: attempts merged into their task, tasks with
// nothing open in Herdr left out. `keys`: repo -> its short key.
export function tasksFromFiles(files: FileLinks[], keys: Record<string, string>): LinkedTask[] {
  const byId = new Map<string, LinkedTask>()
  const own = files.filter(f => !f.attemptOf)
  const task = (f: FileLinks): LinkedTask => ({ id: f.id, repo: f.repo, n: f.n, key: taskKeyOf(f.id, keys[f.repo]), title: f.title, identity: f.identity, panes: [...f.panes], workspace: f.workspace, ...(f.session === undefined ? {} : { session: f.session }), stage: f.stage, group: f.group, activity: f.activity, review: f.review, progress: f.progress, msg: f.msg, since: f.since })
  for (const f of own) byId.set(f.id, task(f))
  for (const a of files.filter(f => f.attemptOf)) {
    const t = byId.get(a.id)
    // An attempt whose task is gone (or unread) still belongs to that task.
    if (t) { t.panes.push(...a.panes); t.review ??= a.review }
    else byId.set(a.id, task(a))
  }
  return [...byId.values()].filter(t => t.panes.length || t.workspace).sort((a, b) => a.repo.localeCompare(b.repo) || b.n - a.n)
}
const taskKeyOf = (id: string, key?: string) => { const n = id.split('/')[1] || ''; return key ? `${key}-${n}` : `#${n}` }

// A coordinator's `state.json`. `repo`: a project coordinator's (its file's
// own `repo`, else its folder's name).
export function coordinatorFromFile(level: CoordinatorLevel, s: unknown, sessionKey: SessionKey, folder = '', session?: string): LinkedCoordinator | null {
  const r = obj(s)
  if (!r) return null
  const key = sessionKey(r.socket)
  const pane = paneOf(key, r.pane)
  const workspace = spaceOf(key, r.space) || spaceOf(key, r.workspace)
  if (!pane && !workspace) return null
  const conversation = str(r.session, 500)
  const named = { ...(session === undefined ? {} : { session: session.slice(0, 80) }), ...(conversation ? { agentSession: conversation } : {}) }
  if (level !== 'project') return { level, pane, workspace, ...named }
  const repo = str(r.repo, 80) || folder
  return REPO_RE.test(repo) ? { level, repo, pane, workspace, ...named } : null
}

// A coordinator's file names the pane and space it had when it started. When
// Herdr closes that pane (a restart of Herdr or of the agent), the ids it
// wrote no longer say where it is, and may even name another agent's pane or
// space. `panes`: what Herdr shows now. Each coordinator is found again by its
// conversation (`agentSession`, the same on its pane): one pane of its machine
// with that conversation, never one another coordinator's file rightly names.
// Not found: a pane of another conversation is not its own, and its space is
// kept only while no agent of another conversation is there (an ordinary
// space never becomes a coordinator). Coordinators whose ids still hold, and
// those without a conversation in their file, are left as they are.
type LivePane = Pick<Pane, 'id' | 'workspace' | 'agent' | 'agentSession'>
export function resolveCoordinators(machines: MachineLinks[], panes: readonly LivePane[]): MachineLinks[] {
  const byId = new Map(panes.map(p => [p.id, p]))
  const bySession = new Map<string, LivePane[]>()
  for (const p of panes) if (p.agent && p.agentSession) bySession.set(p.agentSession, [...(bySession.get(p.agentSession) ?? []), p])
  const fits = (c: LinkedCoordinator, p: LivePane) => !c.agentSession || !p.agentSession || p.agentSession === c.agentSession
  const held = new Set<string>()
  for (const m of machines) for (const c of m.coordinators) {
    const p = c.pane ? byId.get(c.pane) : undefined
    if (p && fits(c, p)) held.add(p.id)
  }
  // First each coordinator's conversation, then (the panes it found taken too) its space.
  const found = new Map<LinkedCoordinator, LivePane>()
  for (const m of machines) for (const c of m.coordinators) {
    const now = c.pane ? byId.get(c.pane) : undefined
    if ((now && fits(c, now)) || !c.agentSession) continue
    const where = machineOf(c.pane ?? c.workspace)
    const hits = (bySession.get(c.agentSession) ?? []).filter(p => machineOf(p.id) === where && !held.has(p.id))
    if (hits.length === 1) found.set(c, hits[0]!)
  }
  for (const p of found.values()) held.add(p.id)
  const resolve = (c: LinkedCoordinator): LinkedCoordinator => {
    const hit = found.get(c)
    if (hit) return { ...c, pane: hit.id, workspace: hit.workspace }
    const now = c.pane ? byId.get(c.pane) : undefined
    if ((now && fits(c, now)) || !c.agentSession) return c
    const stranger = Boolean(c.workspace) && panes.some(p => p.workspace === c.workspace && p.agent && !held.has(p.id) && !fits(c, p))
    const pane = now ? null : c.pane
    const workspace = stranger ? null : c.workspace
    return pane === c.pane && workspace === c.workspace ? c : { ...c, pane, workspace }
  }
  const out = machines.map((m) => {
    const coordinators = m.coordinators.map(resolve)
    return coordinators.some((c, i) => c !== m.coordinators[i]) ? { ...m, coordinators } : m
  })
  return out.some((m, i) => m !== machines[i]) ? out : machines
}

// ---------------------------------------------------------------- grouping
// The home list follows Herdr's own sidebar: a repo's group is Herdr's
// worktree group (the spaces that share its `repo_key`): the repo's own space
// (its main checkout, the plain shell herdr-projects keeps there) heads it, and
// the spaces of its linked worktrees, the tasks', hang under it. The board adds
// what Herdr does not know: which space is which task (id, title, progress),
// and the repo's project coordinator.

export interface Member {
  row: Row
  // The board's task in it; none: a worktree space of the repo the board does not own.
  task: LinkedTask | null
  // The machine whose board has that task (its Board link).
  board?: string
  role: PaneRole
  letter?: string
  // The task's space as one row (its Agent, Reviewer, Planner… tabs): the
  // helper at work in it, its reviewer while a review runs (or its planner),
  // whose pane the row shows and whose tab opens first. `kind`: its program.
  focus?: { id: string, role: PaneRole, kind: string }
}
export interface ProjectSection {
  id: string // Herdr's repo_key, else `repo:<name>`
  repo: string // its name, as the board calls it (else Herdr's)
  key: string // its tasks' key (`WHR`), else ''
  info: RepoInfo | null // branch and how far behind, when known
  // The repo's own space (main checkout): the group's header. null: not open.
  space: Row | null
  coordinator: Row | null
  // Its project coordinator runs in another section (another machine or
  // session): the pane to open.
  remote: { pane: string, machine: string } | null
  // Most urgent first (your turn, working, ready), Herdr's order on a tie.
  members: Member[]
  // Agents only (the repo's shell is no state).
  sum: { blocked: number, working: number, ready: number, total: number }
  state: RowGroup
}
export interface BoardSections {
  // The machine's Coordinator, then its machine coordinator.
  coordinators: { row: Row, level: CoordinatorLevel }[]
  projects: ProjectSection[]
  // Rows that are neither the board's nor in a repo group: listed as before.
  others: Row[]
}

const rowPanes = (r: Row) => (r.kind === 'space' ? r.panes : [r.pane])
const rowSpace = (r: Row) => (r.kind === 'space' ? r.workspace.id : r.lead.workspace)
const paneRow = (p: Pane): Row => ({ kind: 'pane', key: p.id, pane: p, lead: p })
const LEVEL_ORDER: CoordinatorLevel[] = ['top', 'machine', 'project']
const GROUP_ORDER: RowGroup[] = ['blocked', 'working', 'ready']
const hasAgent = (r: Row) => rowPanes(r).some(p => p.agent)

// A section's rows (one machine, or the only one) sorted out with Herdr's
// spaces (`workspaces`) and every board's links. `live`: the pane ids Herdr
// shows now, everywhere (a coordinator's pane elsewhere is a "Coordinated
// from" link only while it is there).
// herdr-projects keeps its coordinators as tabs of one space ("herdr-projects",
// or "chat"): such a space is split into one row per coordinator, and its other
// agents, if any, are listed as before.
export function boardSections(
  rows: Row[],
  workspaces: Pick<Workspace, 'id' | 'repo' | 'repoName' | 'worktree' | 'machine' | 'path'>[],
  machines: MachineLinks[],
  live: ReadonlySet<string>,
  // The board (base machine) of a machine or named session's key.
  baseOf: (machine: string) => string = k => k,
): BoardSections {
  const wsOf = new Map(workspaces.map(w => [w.id, w]))
  const coordByPane = new Map<string, LinkedCoordinator>()
  const coordBySpace = new Map<string, LinkedCoordinator>()
  const coordBoard = new Map<LinkedCoordinator, string>()
  const taskByPane = new Map<string, { task: LinkedTask, role: PaneRole, letter?: string }>()
  const boardOf = new Map<LinkedTask, string>()
  const taskBySpace = new Map<string, LinkedTask>()
  // A repo's branch and behind count, per board: the same repo name on two machines is two checkouts.
  const repoInfo = new Map<string, RepoInfo>()
  const infoKey = (board: string, repo: string) => `${board}|${repo}`
  for (const m of machines) {
    for (const c of m.coordinators) {
      coordBoard.set(c, m.machine)
      if (c.pane) coordByPane.set(c.pane, c)
      if (c.workspace && !coordBySpace.has(c.workspace)) coordBySpace.set(c.workspace, c)
    }
    for (const t of m.tasks) {
      boardOf.set(t, m.machine)
      for (const p of t.panes) if (!taskByPane.has(p.id)) taskByPane.set(p.id, { task: t, role: p.role, letter: p.letter })
      if (t.workspace && !taskBySpace.has(t.workspace)) taskBySpace.set(t.workspace, t)
    }
    for (const r of m.repos || []) repoInfo.set(infoKey(m.machine, r.repo), r)
  }
  const out: BoardSections = { coordinators: [], projects: [], others: [] }
  const sectionBoard = rows[0] ? baseOf(machineOf(rows[0].lead.id)) : ''

  // 1. Who each row is: a coordinator, a task's agent, or neither.
  type TaskHit = { task: LinkedTask, role: PaneRole, letter?: string, focus?: Member['focus'] }
  type Sorted = { row: Row, coord?: LinkedCoordinator, task?: TaskHit }
  const sorted: Sorted[] = []
  for (const row of rows) {
    const panes = rowPanes(row)
    const coordPanes = panes.filter(p => coordByPane.has(p.id))
    // Coordinators by their panes: one row each; the space's other agents stay listed.
    if (coordPanes.length && row.kind === 'space' && (coordPanes.length > 1 || panes.some(p => p.agent && !coordByPane.has(p.id)))) {
      for (const p of coordPanes) sorted.push({ row: paneRow(p), coord: coordByPane.get(p.id) })
      for (const p of panes) if (p.agent && !coordByPane.has(p.id)) sorted.push({ row: paneRow(p) })
      continue
    }
    // A coordinator alone in its space (or known by its space): the whole row.
    const coord = (coordPanes[0] && coordByPane.get(coordPanes[0].id)) || coordBySpace.get(rowSpace(row))
    if (coord) { sorted.push({ row, coord }); continue }
    // A task's space is one row, whatever helpers it holds (agent, reviewer,
    // planner, attempts, each in its own tab). A space shared by several tasks
    // gives each task a row of its own (its panes); its other agents stay listed.
    const linkedPanes = panes.filter(p => taskByPane.has(p.id))
    const tasksHere = [...new Set(linkedPanes.map(p => taskByPane.get(p.id)!.task))]
    if (row.kind === 'space' && tasksHere.length > 1) {
      for (const task of tasksHere) {
        const own = panes.filter(p => taskByPane.get(p.id)?.task === task)
        sorted.push(taskRow(own.length === 1 ? paneRow(own[0]!) : subRow(row, own, `${row.key}|${task.id}`), task, taskByPane.get(own[0]!.id)!))
      }
      for (const p of panes) if (p.agent && !taskByPane.has(p.id)) sorted.push({ row: paneRow(p) })
      continue
    }
    const hit = linkedPanes[0] ? taskByPane.get(linkedPanes[0].id) : undefined
    const task = hit?.task || taskBySpace.get(rowSpace(row))
    if (!task) { sorted.push({ row }); continue }
    sorted.push(taskRow(row, task, hit && hit.task === task ? hit : { task, role: 'worker' }))
  }

  // 2. A repo's group id: Herdr's repo_key, learnt from its tasks' spaces and its
  // main checkout's folder; `repo:<name>` while Herdr shows none of its spaces.
  const idOfName = new Map<string, string>()
  const nameOfId = new Map<string, string>()
  const learn = (name: string, id: string | undefined) => {
    if (!id || idOfName.has(name)) return
    idOfName.set(name, id)
    if (!nameOfId.has(id)) nameOfId.set(id, name)
  }
  for (const s of sorted) if (s.task) learn(s.task.task.repo, wsOf.get(rowSpace(s.row))?.repo)
  const checkoutOf = new Map<string, string>()
  const pathKey = (p: string) => p.replace(/\/+$/, '')
  for (const r of machines.find(m => m.machine === sectionBoard)?.repos || []) {
    // That board's own checkout, in Herdr's spaces of that machine.
    const w = workspaces.find(x => x.repo && !x.worktree && baseOf(x.machine || '') === sectionBoard && (x.repo === r.root || x.repo === `${r.root}/.git`))
    learn(r.repo, w?.repo)
    // A plain shell may have no Git metadata, or retain the old repo key
    // after a move. Match the board's current checkout on this machine only.
    for (const x of workspaces) {
      if (x.worktree || baseOf(x.machine || '') !== sectionBoard) continue
      const ownRows = rows.filter(row => rowSpace(row) === x.id)
      const paths = x.path ? [x.path] : ownRows.flatMap(row => rowPanes(row).map(p => p.cwd).filter((p): p is string => Boolean(p)))
      if (paths.length && paths.every(p => pathKey(p) === pathKey(r.root))) checkoutOf.set(x.id, r.repo)
    }
  }
  const groupId = (name: string) => idOfName.get(name) || `repo:${name}`
  const groups = new Map<string, ProjectSection & { board: string }>()
  const group = (id: string, name: string, board: string) => {
    let g = groups.get(id)
    if (!g) {
      g = { id, repo: name, board, key: '', info: null, space: null, coordinator: null, remote: null, members: [], sum: { blocked: 0, working: 0, ready: 0, total: 0 }, state: 'ready' }
      groups.set(id, g)
      out.projects.push(g)
    }
    return g
  }
  // Only the board's repos have a group: those of a task or a project coordinator
  // shown here. Any other space, worktree or not, stays listed as before.
  const owned = new Set<string>()
  for (const s of sorted) {
    if (s.task) owned.add(groupId(s.task.task.repo))
    else if (s.coord?.level === 'project') owned.add(groupId(s.coord.repo!))
  }

  // 3. Placed in Herdr's order.
  for (const s of sorted) {
    if (s.coord) {
      if (s.coord.level !== 'project') { out.coordinators.push({ row: s.row, level: s.coord.level }); continue }
      const g = group(groupId(s.coord.repo!), s.coord.repo!, coordBoard.get(s.coord) ?? sectionBoard)
      if (!g.coordinator) { g.coordinator = s.row; continue }
      out.others.push(s.row)
      continue
    }
    if (s.task) {
      const t = s.task
      const board = boardOf.get(t.task) ?? sectionBoard
      const g = group(groupId(t.task.repo), t.task.repo, board)
      g.members.push({ row: s.row, task: t.task, board, role: t.role, ...(t.role === 'attempt' && t.letter ? { letter: t.letter } : {}), ...(t.focus ? { focus: t.focus } : {}) })
      continue
    }
    // The repo's own space (main checkout) heads its group.
    const w = wsOf.get(rowSpace(s.row))
    const checkout = w && checkoutOf.get(w.id)
    const repoId = checkout ? groupId(checkout) : w?.repo
    if (w && repoId && !w.worktree && owned.has(repoId)) {
      const g = group(repoId, checkout || nameOfId.get(repoId) || w.repoName || repoId, sectionBoard)
      if (!g.space) { g.space = s.row; continue }
    }
    out.others.push(s.row)
  }
  out.coordinators.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level))
  const mine = new Set<string>()
  for (const row of rows) for (const p of rowPanes(row)) mine.add(p.id)
  for (const g of groups.values()) {
    // The checkout of the board whose tasks these are.
    g.info = repoInfo.get(infoKey(g.board, g.repo)) || null
    g.key = g.members.map(m => m.task && /^([A-Z][A-Z0-9]{1,4})-\d/.exec(m.task.key)?.[1]).find(Boolean) || ''
    // Stable sort: most urgent first, Herdr's order on a tie.
    g.members = g.members.map((m, i) => ({ m, i })).sort((a, b) => GROUP_ORDER.indexOf(rowGroup(a.m.row)) - GROUP_ORDER.indexOf(rowGroup(b.m.row)) || a.i - b.i).map(x => x.m)
    if (!g.coordinator) {
      // Coordinated from elsewhere: a project coordinator of that repo that Herdr shows, outside this section.
      const far = machines.flatMap(m => m.coordinators).find(c => c.level === 'project' && c.repo === g.repo && c.pane && live.has(c.pane) && !mine.has(c.pane))
      if (far?.pane) g.remote = { pane: far.pane, machine: machineOf(far.pane) }
    }
    const seen = new Set<string>()
    for (const m of g.members) {
      if (m.task) {
        if (seen.has(m.task.id)) continue
        seen.add(m.task.id)
      }
      if (!hasAgent(m.row)) continue
      g.sum.total++
      g.sum[m.task?.group ? taskStat(m.task.group) : rowGroup(m.row)]++
    }
    for (const r of [...(g.space ? [g.space] : []), ...(g.coordinator ? [g.coordinator] : [])]) {
      if (!hasAgent(r)) continue
      g.sum.total++
      g.sum[rowGroup(r)]++
    }
    g.state = g.sum.blocked ? 'blocked' : g.sum.working ? 'working' : 'ready'
  }
  return out
}

// The helper at work among a task's panes that `here` holds: its reviewer
// (a review, the plan's, the Picker), else its planner.
export function taskHelper(task: Pick<LinkedTask, 'panes'>, here: (id: string) => boolean): LinkedTask['panes'][number] | null {
  return task.panes.find(p => p.role === 'reviewer' && here(p.id)) || task.panes.find(p => p.role === 'planner' && here(p.id)) || null
}
// The pane a task's row shows: one that waits for you, else its helper at
// work (`focus`), else the most urgent.
export function shownPane<P extends Pick<Pane, 'id' | 'agent' | 'status'>>(panes: P[], focus?: string | null): P | null {
  const lead = leadPane(panes)
  if (!lead || (lead.agent && lead.status === 'blocked')) return lead
  return panes.find(p => p.id === focus && p.agent) ?? lead
}
// A task's row: led by the pane it shows, with its helper at work (`focus`),
// even when that helper's pane is all that is left open of the task.
function taskRow(row: Row, task: LinkedTask, hit: { role: PaneRole, letter?: string }): { row: Row, task: { task: LinkedTask, role: PaneRole, letter?: string, focus?: Member['focus'] } } {
  const panes = rowPanes(row)
  const here = new Map(panes.map(p => [p.id, p]))
  const h = taskHelper(task, id => here.has(id))
  const focus = h ? { id: h.id, role: h.role, kind: h.kind || here.get(h.id)!.agent || '' } : undefined
  const shown = row.kind === 'space' ? shownPane(panes, focus?.id) : null
  // A space's row is the task's (role worker); a lone pane keeps its role (an attempt's letter).
  const role = row.kind === 'space' || focus ? 'worker' : hit.role
  return { row: shown ? relead(row, shown) : row, task: { task, role, ...(role === 'attempt' && hit.letter ? { letter: hit.letter } : {}), ...(focus ? { focus } : {}) } }
}
// The part of a space that holds one task's panes (a space several tasks share).
function subRow(row: Extract<Row, { kind: 'space' }>, keep: Pane[], key: string): Row {
  const ids = new Set(keep.map(p => p.id))
  const tabs = row.tabs.map(e => ({ ...e, panes: e.panes.filter(p => ids.has(p.id)) })).filter(e => e.panes.length)
  const lead = leadPane(keep)!
  const n = (st: string) => keep.filter(p => p.agent && p.status === st).length
  return { kind: 'space', key, workspace: row.workspace, tabs, panes: keep, lead, leadTab: tabs.find(e => e.panes.includes(lead))!, sum: { blocked: n('blocked'), working: n('working'), done: n('done'), agents: keep.filter(p => p.agent).length } }
}
// A space row led by another of its panes (its state, its tab's mini-map).
function relead(row: Row, lead: Pane): Row {
  if (row.kind !== 'space' || row.lead.id === lead.id) return row
  return { ...row, lead, leadTab: row.tabs.find(e => e.panes.some(p => p.id === lead.id)) ?? row.leadTab }
}

// Pane IDs can change while a kept task workspace stays open. Explicit pane
// ownership wins; workspace fallback mirrors boardSections, including remote IDs.
export function taskLinks(machines: MachineLinks[], live: Pick<Pane, 'id' | 'workspace'>[]) {
  const panes = new Map<string, { task: LinkedTask, machine: string }>()
  const spaces = new Map<string, { task: LinkedTask, machine: string }>()
  for (const m of machines) for (const task of m.tasks) {
    const link = { task, machine: m.machine }
    for (const p of task.panes) if (!panes.has(p.id)) panes.set(p.id, link)
    if (task.workspace && !spaces.has(task.workspace)) spaces.set(task.workspace, link)
  }
  // boardSections splits a workspace with several explicitly linked tasks:
  // unlinked agents remain independent. With one task, its whole row belongs
  // to it, even when only its pane (rather than its workspace) was linked.
  const liveSpaces = new Map<string, { task: LinkedTask, machine: string } | null>()
  for (const p of live) {
    const link = panes.get(p.id)
    if (!link) continue
    if (!liveSpaces.has(p.workspace)) liveSpaces.set(p.workspace, link)
    else if (liveSpaces.get(p.workspace)?.task !== link.task) liveSpaces.set(p.workspace, null)
  }
  return (p: Pick<Pane, 'id' | 'workspace'>) => panes.get(p.id)
    ?? (liveSpaces.has(p.workspace) ? liveSpaces.get(p.workspace) ?? undefined : spaces.get(p.workspace))
}

export type HomeStat = 'blocked' | 'working' | 'ready'

// WORKING means the Board's working group (including reviews and checks).
export function taskStat(group: TaskGroup): HomeStat {
  if (group === 'needs' || group === 'ready') return 'blocked'
  return group === 'working' ? 'working' : 'ready'
}

// One representative pane per task, including helpers in separate spaces.
export function countedPanes<P extends Pick<Pane, 'id' | 'agent' | 'status' | 'workspace'>>(panes: P[], machines: MachineLinks[]): P[] {
  const taskOf = taskLinks(machines, panes)
  const byTask = new Map<string, { t: LinkedTask, list: P[] }>()
  const out: P[] = []
  for (const p of panes) {
    const link = taskOf(p)
    if (!link) { out.push(p); continue }
    const t = link.task
    const k = `${link.machine}|${t.id}`
    const e = byTask.get(k)
    if (e) e.list.push(p)
    else byTask.set(k, { t, list: [p] })
  }
  for (const { t, list } of byTask.values()) {
    const ids = new Set(list.map(p => p.id))
    const shown = shownPane(list, taskHelper(t, id => ids.has(id))?.id)
    if (shown) out.push(shown)
  }
  return out
}

// What a task's row says of its stage, beyond its state: under review (the
// work, the plan, the attempts: the Picker) or planning, with the helper's
// program; several attempts at once.
export type MemberStage = { what: 'review' | 'plan-review' | 'pick' | 'planning', by: string } | { what: 'attempts', n: number }
export function memberStage(m: Pick<Member, 'task' | 'focus' | 'row'>): MemberStage | null {
  if (!m.task) return null
  const f = m.focus
  if (f?.role === 'reviewer') return { what: m.task.review === 'pick' ? 'pick' : m.task.review === 'plan' ? 'plan-review' : 'review', by: f.kind }
  if (f?.role === 'planner') return { what: 'planning', by: f.kind }
  const here = new Set(rowPanes(m.row).map(p => p.id))
  const n = m.task.panes.filter(p => p.role === 'attempt' && here.has(p.id)).length
  return n > 1 ? { what: 'attempts', n } : null
}

// The board's tasks whose agents a set of spaces holds (what closing them stops).
export function tasksIn(spaces: string[], panes: Pick<Pane, 'id' | 'workspace'>[], machines: MachineLinks[]): LinkedTask[] {
  const set = new Set(spaces)
  const inside = new Set(panes.filter(p => set.has(p.workspace)).map(p => p.id))
  const out: LinkedTask[] = []
  for (const m of machines) for (const t of m.tasks) {
    if ((t.workspace && set.has(t.workspace)) || t.panes.some(p => inside.has(p.id))) out.push(t)
  }
  return out
}

// What a card of the board says (app/components/AgentCard.vue `board`).
// `coordinator`: a coordinator's card (its role's icon, its last message).
// `stage`: the task's stage beyond its state (`Under review · codex`); `tab`:
// the tab its row opens, whatever tab was opened last (its reviewer's while a review runs).
// `activity`: in Working, whether an agent runs or it waits for CI or its turn.
// `lead`: the head row of a repo group, named after the repo (its project
// coordinator's, or the repo's own space when it has no coordinator here).
// `icon`, `hint`: a coordinator's own icon and what it is for (coordinatorKind).
export interface BoardCard { identity?: TaskAgentIdentity, group?: TaskGroup, activity?: TaskActivity | null, tag: string, name?: string, progress?: number | null, since?: number | null, msg?: string, stage?: string, tab?: string, onBoard?: () => void, taskRef?: { machine: string, id: string }, coordinator?: boolean, lead?: boolean, icon?: string, hint?: string }

// What a member's card says before its title: `WHR-2`, `WHR-2 · review`, `WHR-2 · A`.
export function memberTag(m: Pick<Member, 'task' | 'role' | 'letter'>, review: string): string {
  if (!m.task) return ''
  if (m.role === 'reviewer') return `${m.task.key} · ${review}`
  if (m.role === 'attempt' && m.letter) return `${m.task.key} · ${m.letter}`
  return m.task.key
}

// Time on a task as Herdr's sidebar shows it: `45s`, `17m`, `2h05`, `3d`.
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}`
  return `${Math.floor(h / 24)}d`
}

// `<branch>\t<behind>` (server/utils/boardLinks.ts REPO_GIT_SCRIPT).
export function parseRepoGit(text: string): Pick<RepoInfo, 'branch' | 'behind'> {
  const [b = '', n = ''] = (text.split('\n')[0] || '').split('\t')
  const branch = /^[\w./-]{1,120}$/.test(b.trim()) ? b.trim() : ''
  const behind = /^\d{1,7}$/.test(n.trim()) ? Number(n.trim()) : null
  return { branch, behind }
}
