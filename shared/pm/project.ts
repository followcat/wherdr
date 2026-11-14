// A managed project: a folder (git, unless git: false) on a machine reached through herdr-core,
// and its own workflow (DATA_DIR/projects/workflows/<KEY>.json), which its tasks follow. Stored in DATA_DIR/projects/projects.json.
import type { WorkflowError } from './workflow'
import type { Task } from './run'
import type { RepoVisibility } from './visibility'
import { isProjectColor, type ProjectColor } from './projectKey'
import { PAUSED, isStrategy, type Strategy } from './placement'
import { branchNameError } from './branchName'
import { ARCHIVE_DAYS } from './archive'
import { cleanReach, type Reach } from './reach'
import type { SharedField, WorkspaceShared } from './workspace'

export interface Project {
  key: string // the fixed id (see projectKey.ts): task ids are <key>-<n>: WHR-344
  label?: string // the key shown and edited, when it is not the id
  aliases?: string[] // the keys shown before: they still resolve
  color?: ProjectColor // its badge's color, from the palette
  name: string
  coordinatorName?: string // its coordinator's name; missing: the project's name (projectCoordinatorName)
  machine: string // herdr-core machine key, '' = the wherdr host
  path: string // its clone on the home machine
  // The machines its tasks may run on; missing: only its own (the home machine,
  // which keeps the coordinator, the repo's settings and visibility).
  machines?: string[]
  clones?: Record<string, string> // machine key → its clone of the repo, for each allowed machine but home
  // Allowed machines switched off for this project: no new task goes there
  // (tasks already there go on); their clone and settings stay.
  paused?: string[]
  placement?: Strategy // how its tasks spread over those machines; missing: strongest
  git?: false // a folder without git: its coordinator works in it, no task worktree
  // Working branch: tasks start from it, and a step's PR, land or check uses it
  // when the step names no branch. Default: the repo's current branch, no default.
  base?: string
  branchName?: string // its tasks' branch template (branchName.ts); missing: task/{id}
  // The library template (or example) its workflow was copied from: information
  // only, never followed. None: no workflow yet, no task can start.
  from?: { template: string, version: number }
  visibility?: RepoVisibility // public repository: guardrails for its coordinator and tasks
  archiveAfter?: number // days a done task stays in Done before it is archived, 0 never; missing: 7 (archive.ts)
  deleteBranch?: false // keep each task's remote branch after its merge; missing: deleted when safe (pmActions.ts)
  reach?: Reach[] // other projects its coordinator may read or act on (reach.ts); missing: none
  // A workspace (workspace.ts): git false, path its root folder, in tab group
  // `group`, its members take `shared`. A member names its workspace's key and
  // the shared fields it sets itself; read it through effectiveProject.
  kind?: 'workspace'
  group?: string
  shared?: WorkspaceShared
  workspace?: string
  overrides?: SharedField[]
  addedAt: number
}

// template: a library template id or example:<id>, copied into the project's workflow.
export type ProjectInput = Omit<Project, 'addedAt' | 'from' | 'label' | 'aliases' | 'kind' | 'group' | 'shared' | 'workspace' | 'overrides'> & { template?: string }
export interface TemplateInfo { id: string, version?: number }
// GET /api/pm/overview
export interface PmOverview { enabled: boolean, projects: Project[], templates: TemplateInfo[], tasks?: Task[] }

export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
// A branch name git takes, without the odd cases (.., @{, spaces, ~^:?*[\).
const BRANCH_RE = /^(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/

export const isBranch = (b: string) => BRANCH_RE.test(b)
// Any branch name git takes (git check-ref-format --branch), for a branch that
// exists already, e.g. feature/c++, of any length: no control or space ~^:?*[\, no .., @{, //,
// no part starting with . or ending in .lock, not @, not ending in / or .
export const isGitBranch = (b: string) => b !== '' && b !== '@' && !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-/]|[/.]$|(^|\/)\.|\.lock(\/|$)/.test(b)
export const isTemplateId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)

const KEY_HINT = '2 to 10 letters or digits, starting with a letter'
export interface ProjectUpdate { name?: string, coordinatorName?: string, base?: string, key?: string, color?: ProjectColor, machines?: string[], clones?: Record<string, string>, paused?: string[], placement?: Strategy, branchName?: string, archiveAfter?: number, deleteBranch?: boolean, reach?: Reach[] }

// A project's coordinator is named after the project unless the user named it.
export const projectCoordinatorName = (p: { name: string, coordinatorName?: string }) => p.coordinatorName || p.name

// The machines a project's tasks may run on, its home machine first.
export const allowedMachines = (p: Pick<Project, 'machine' | 'machines'>) => [p.machine, ...(p.machines ?? []).filter(m => m !== p.machine)]
export const isPaused = (p: Pick<Project, 'paused'>, machine: string) => !!p.paused?.includes(machine)
export { PAUSED }

// A machine that some project allows, paused in every project that allows it (Settings › Machines).
export function pausedEverywhere(projects: Pick<Project, 'machine' | 'machines' | 'paused'>[], machine: string) {
  const allowing = projects.filter(p => allowedMachines(p).includes(machine))
  return allowing.length > 0 && allowing.every(p => isPaused(p, machine))
}

// The project's clone on a machine, a leading ~ made that machine's home (the
// shell does not expand a quoted one): undefined when that machine is not allowed or has none.
export function cloneOn(p: Pick<Project, 'machine' | 'machines' | 'path' | 'clones'>, machine: string, home: string) {
  const path = machine === p.machine ? p.path : allowedMachines(p).includes(machine) ? p.clones?.[machine] : undefined
  return path?.replace(/^~(?=\/|$)/, () => home)
}

// The machine a task starts on (a key; the reason when refused). A task stays
// where it first started (its worktree, branch and reports are there): resume,
// retry and reviewer go back; a task started before machines were saved is on
// its project's, paused or not. A new one goes to the machine asked for, else
// home, else the first one not paused; never to a paused one.
export function taskMachine(task: Pick<Task, 'machine' | 'run'>, p: Pick<Project, 'machine' | 'machines' | 'paused'>, asked?: string): { machine: string } | { refused: string } {
  const sticky = task.machine ?? (task.run ? p.machine : undefined)
  if (sticky !== undefined) return asked === undefined || asked === sticky ? { machine: sticky } : { refused: 'This task already started on another machine: it stays there' }
  if (asked === undefined) {
    const free = allowedMachines(p).find(m => !isPaused(p, m))
    return free !== undefined ? { machine: free } : { refused: `Every machine of the project is ${PAUSED}: switch one on in the project's settings` }
  }
  if (!allowedMachines(p).includes(asked)) return { refused: 'This machine is not allowed for the project: allow it in the project\'s settings' }
  return isPaused(p, asked) ? { refused: `This machine is ${PAUSED}: switch it on in the project's settings` } : { machine: asked }
}

// An allowed machine by its name (as `autopilot show` and the board name it) or key.
export function machineNamed(p: Pick<Project, 'machine' | 'machines'>, known: { key: string, label: string }[], name: string): { machine: string } | { refused: string } {
  const allowed = allowedMachines(p).map(key => ({ key, label: known.find(m => m.key === key)?.label ?? key }))
  const m = allowed.find(x => x.label.toLowerCase() === name.toLowerCase()) ?? allowed.find(x => x.key === name)
  return m ? { machine: m.key } : { refused: `No machine named ${name} among the project's: ${allowed.map(x => x.label).join(', ')}` }
}

const badFolder = (path: unknown) => typeof path !== 'string' || !/^(\/|~(\/|$))/.test(path) || path.length > 1024 || path.includes('\0')

// The allowed machines once an update applies: each one but home needs a clone
// path; a paused one stays paused while allowed. Returns the fields to store
// (none: only the home machine), or the errors.
export function machinesOf(p: Pick<Project, 'machine' | 'machines' | 'clones' | 'paused'>, update: Pick<ProjectUpdate, 'machines' | 'clones' | 'paused'>) {
  const machines = allowedMachines({ machine: p.machine, machines: update.machines ?? p.machines })
  const given = { ...p.clones, ...update.clones }
  const errors: WorkflowError[] = machines.slice(1).filter(m => !given[m]).map(m => ({ path: `clones.${m}`, message: 'the clone\'s folder on that machine' }))
  const clones = Object.fromEntries(machines.slice(1).map(m => [m, given[m]!]))
  const paused = (update.paused ?? p.paused ?? []).filter(m => machines.includes(m))
  return { errors, machines: machines.length > 1 ? machines : undefined, clones: machines.length > 1 ? clones : undefined, paused: paused.length ? paused : undefined }
}

// The fields the user changes on a project (General tab): name, its coordinator's name ('' clears it), base ('' clears it), key, color,
// the allowed machines and their clones (checked against the project by machinesOf), the placement strategy.
export function cleanProjectUpdate(raw: unknown): { update?: ProjectUpdate, errors: WorkflowError[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: WorkflowError[] = [], update: ProjectUpdate = {}
  // `key` names the project; `newKey` is its new shown key.
  if (o.newKey !== undefined) {
    const key = typeof o.newKey === 'string' ? o.newKey.trim().toUpperCase() : ''
    if (!KEY_RE.test(key)) errors.push({ path: 'key', message: KEY_HINT })
    else update.key = key
  }
  if (o.color !== undefined) {
    if (!isProjectColor(o.color)) errors.push({ path: 'color', message: 'not a palette color' })
    else update.color = o.color
  }
  if (o.name !== undefined) {
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name || name.length > 80) errors.push({ path: 'name', message: '1 to 80 characters' })
    else update.name = name
  }
  // '' goes back to the project's name.
  if (o.coordinatorName !== undefined) {
    const name = typeof o.coordinatorName === 'string' ? o.coordinatorName.trim() : null
    if (name === null || name.length > 80) errors.push({ path: 'coordinatorName', message: 'up to 80 characters' })
    else update.coordinatorName = name
  }
  if (o.base !== undefined) {
    const base = typeof o.base === 'string' ? o.base.trim() : null
    if (base === null || (base && !BRANCH_RE.test(base))) errors.push({ path: 'base', message: 'invalid branch name' })
    else update.base = base
  }
  if (o.branchName !== undefined) {
    const tpl = typeof o.branchName === 'string' ? o.branchName.trim() : ''
    const why = tpl && branchNameError(tpl)
    if (why) errors.push({ path: 'branchName', message: why })
    else update.branchName = tpl
  }
  const isKey = (m: unknown): m is string => typeof m === 'string' && m.length <= 64
  if (o.machines !== undefined) {
    if (!Array.isArray(o.machines) || o.machines.length > 16 || !o.machines.every(isKey)) errors.push({ path: 'machines', message: 'a list of machine keys' })
    else update.machines = [...new Set(o.machines)]
  }
  if (o.paused !== undefined) {
    if (!Array.isArray(o.paused) || o.paused.length > 17 || !o.paused.every(isKey)) errors.push({ path: 'paused', message: 'a list of machine keys' })
    else update.paused = [...new Set(o.paused)]
  }
  if (o.placement !== undefined) {
    if (!isStrategy(o.placement)) errors.push({ path: 'placement', message: 'strongest, balance or home' })
    else update.placement = o.placement
  }
  if (o.archiveAfter !== undefined) {
    if (!(ARCHIVE_DAYS as readonly unknown[]).includes(o.archiveAfter)) errors.push({ path: 'archiveAfter', message: `one of ${ARCHIVE_DAYS.join(', ')} (0: never)` })
    else update.archiveAfter = o.archiveAfter as number
  }
  if (o.deleteBranch !== undefined) {
    if (typeof o.deleteBranch !== 'boolean') errors.push({ path: 'deleteBranch', message: 'true or false' })
    else update.deleteBranch = o.deleteBranch
  }
  if (o.reach !== undefined) {
    const r = cleanReach(o.reach)
    if (r.error) errors.push({ path: 'reach', message: r.error })
    else update.reach = r.reach
  }
  if (o.clones !== undefined) {
    const entries = o.clones && typeof o.clones === 'object' && !Array.isArray(o.clones) ? Object.entries(o.clones) : null
    if (!entries || entries.length > 16) errors.push({ path: 'clones', message: 'machine key → folder' })
    else for (const [m, path] of entries) {
      if (!isKey(m) || badFolder(path)) errors.push({ path: `clones.${m}`, message: 'an absolute folder path' })
      else (update.clones ??= {})[m] = (path as string).trim()
    }
  }
  return errors.length ? { errors } : { update, errors }
}

// Checks a project to add; returns its clean form or the errors.
export function cleanProjectInput(raw: unknown): { project?: ProjectInput, errors: WorkflowError[] } {
  const errors: WorkflowError[] = []
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  const key = str('key').toUpperCase()
  if (!KEY_RE.test(key)) errors.push({ path: 'key', message: KEY_HINT })
  const name = str('name') || key
  if (name.length > 80) errors.push({ path: 'name', message: 'at most 80 characters' })
  if (typeof o.machine !== 'string' || o.machine.length > 64) errors.push({ path: 'machine', message: 'unknown machine' })
  const path = str('path')
  if (!path.startsWith('/') && !path.startsWith('~')) errors.push({ path: 'path', message: 'an absolute folder path' })
  else if (path.length > 1024 || path.includes('\0')) errors.push({ path: 'path', message: 'invalid folder' })
  const base = str('base')
  if (base && !isBranch(base)) errors.push({ path: 'base', message: 'invalid branch name' })
  if (o.color !== undefined && !isProjectColor(o.color)) errors.push({ path: 'color', message: 'not a palette color' })
  const template = str('template')
  if (template && !isTemplateId(template.replace(/^example:/, ''))) errors.push({ path: 'template', message: 'invalid template id' })
  if (errors.length) return { errors }
  return {
    errors,
    project: { key, name, machine: o.machine as string, path, ...(base ? { base } : {}), ...(isProjectColor(o.color) ? { color: o.color } : {}), ...(template ? { template } : {}) },
  }
}
