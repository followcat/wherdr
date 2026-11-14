// Workspaces (docs/workspaces.md): a project of kind "workspace" (no git, its
// path a root folder such as ~/work, shown in tab group `group`) whose
// coordinator runs a set of linked repositories. Each repository it works on
// is a member project (`workspace: <its key>`, no coordinator of its own),
// which takes the workspace's `shared` settings unless it lists the field in
// `overrides`. effectiveProject is the one place that resolves them.
import type { WorkflowError } from './workflow'
import { checkPrefs, checkSetup, defaultWorkflow, type Prefs, type Template, type WorktreeSetup } from './workflow'
import type { Strategy } from './placement'
import { KEY_RE, cleanProjectUpdate, type Project, type ProjectUpdate } from './project'

// A workspace's settings, which its members take. machines: the machines
// beside the workspace's own; clones: the clone root on each (a member's
// clone there is <root>/<its repo path>); paused: of those machines.
export interface WorkspaceShared {
  machines?: string[]
  clones?: Record<string, string>
  paused?: string[]
  placement?: Strategy
  base?: string
  branchName?: string
  prefs?: Prefs // agents, models and reviewer fallback of the members' tasks
  worktree?: WorktreeSetup
  archiveAfter?: number
  deleteBranch?: false
}

// The fields a member may set itself (`overrides`); 'machines' covers its
// machines, clones and paused ones.
export const SHARED_FIELDS = ['machines', 'placement', 'base', 'branchName', 'prefs', 'worktree', 'archiveAfter', 'deleteBranch'] as const
export type SharedField = typeof SHARED_FIELDS[number]
const isSharedField = (f: unknown): f is SharedField => (SHARED_FIELDS as readonly unknown[]).includes(f)

// The only task type a workspace holds (its sub-tasks are its members' tasks).
export const FEATURE = 'feature'

export const isWorkspace = (p: Pick<Project, 'kind'> | undefined) => p?.kind === 'workspace'
export const workspaceOf = (member: Pick<Project, 'workspace'>, list: Project[]) =>
  member.workspace ? list.find(p => p.key === member.workspace && isWorkspace(p)) : undefined

// A workspace's members (none for any other project).
export const membersOf = (key: string, list: Project[]) =>
  isWorkspace(list.find(p => p.key === key)) ? list.filter(p => p.workspace === key) : []
// Whose coordinator handles a project: a member's workspace, else its own.
export const coordinatorKey = (key: string, list: Project[]) => {
  const p = list.find(x => x.key === key)
  return p && workspaceOf(p, list) ? p.workspace! : key
}
// The projects a coordinator handles (its own, and a workspace's members):
// one autopilot, whose limits count all their tasks.
export const handledBy = (key: string, list: Project[]) => list.filter(p => p.key === key || membersOf(key, list).includes(p))

const defined = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
const trim = (p: string) => p.replace(/\/+$/, '')

// The workspace's clone root on a machine: its own path at home, else shared.clones.
const rootOn = (ws: Project, machine: string) => (machine === ws.machine ? ws.path : ws.shared?.clones?.[machine])

// The member's repository path under the workspace's root (payroll-api for
// ~/work/payroll-api), else its folder's name.
export function repoPath(member: Pick<Project, 'machine' | 'path'>, ws: Project) {
  const root = rootOn(ws, member.machine), path = trim(member.path)
  return root && path.startsWith(`${trim(root)}/`) ? path.slice(trim(root).length + 1) : path.split('/').pop()!
}

// The member's machines from the workspace's: its home first, then each one
// with a clone root, its clone under that root.
function sharedMachines(member: Project, ws: Project): Pick<Project, 'machines' | 'clones' | 'paused'> {
  const repo = repoPath(member, ws)
  const others = [ws.machine, ...(ws.shared?.machines ?? [])].filter((m, i, all) => m !== member.machine && all.indexOf(m) === i && rootOn(ws, m))
  // A machine the workspace paused stays paused for the member, its home included.
  const paused = (ws.shared?.paused ?? []).filter(m => m === member.machine || others.includes(m))
  return { ...(others.length ? { machines: [member.machine, ...others], clones: Object.fromEntries(others.map(m => [m, `${trim(rootOn(ws, m)!)}/${repo}`])) } : {}), ...(paused.length ? { paused } : {}) }
}

// The settings in force for a project: a member's override wins, else the
// workspace's shared value (none: the usual default). Any other project as is.
export function effectiveProject(member: Project, ws: Project | undefined): Project {
  if (!member.workspace || !ws || !isWorkspace(ws)) return member
  const own = new Set(member.overrides ?? []), s = ws.shared ?? {}
  const { machines, clones, paused, placement, base, branchName, archiveAfter, deleteBranch, ...rest } = member
  const pick = <K extends 'placement' | 'base' | 'branchName' | 'archiveAfter' | 'deleteBranch'>(k: K) => (own.has(k) ? member[k] : s[k])
  return {
    ...rest,
    ...(own.has('machines') ? defined({ machines, clones, paused }) : sharedMachines(member, ws)),
    ...defined({ placement: pick('placement'), base: pick('base'), branchName: pick('branchName'), archiveAfter: pick('archiveAfter'), deleteBranch: pick('deleteBranch') }),
  }
}

export const effectiveProjects = (list: Project[]) => list.map(p => effectiveProject(p, workspaceOf(p, list)))

// The workflow a member runs: its own file (`saved`) when it has one, else
// its workspace's (`shared`, workflows/<WS>.json), else the default; with the
// workspace's agents and worktree setup unless it overrides them, and the
// workspace's guards, which its own only harden. Any other project: its own.
export function effectiveWorkflow(key: string, saved: Template | null, member: Project | undefined, ws: Project | undefined, shared: Template | null = null): Template {
  const id = key.toLowerCase()
  if (!member?.workspace || !ws || !isWorkspace(ws)) return saved ?? defaultWorkflow(key)
  const t = saved ?? (shared ? { ...ownWorkflow(shared), id } : defaultWorkflow(key))
  const own = new Set(member.overrides ?? [])
  const { prefs, worktree, workspaceGuards: _, ...rest } = t
  return {
    ...rest,
    ...defined({ prefs: own.has('prefs') ? prefs : ws.shared?.prefs ?? prefs, worktree: own.has('worktree') ? worktree : ws.shared?.worktree }),
    ...(shared?.guards ? { workspaceGuards: shared.guards } : {}),
  }
}

// A workflow as it is saved or shown for editing: without its workspace's guards.
export function ownWorkflow(t: Template): Template {
  const { workspaceGuards: _, ...own } = t
  return own
}

// A member's overrides once an update applies: each shared field it sets
// becomes its own; a base or branch name of '' clears it (back to the shared one).
export function memberOverrides(member: Project, update: ProjectUpdate): Pick<Project, 'overrides'> {
  if (!member.workspace) return {}
  const own = new Set(member.overrides ?? [])
  const set = (f: SharedField, on: boolean) => (on ? own.add(f) : own.delete(f))
  if (update.machines || update.clones || update.paused) set('machines', true)
  for (const f of ['placement', 'archiveAfter', 'deleteBranch'] as const) if (update[f] !== undefined) set(f, true)
  for (const f of ['base', 'branchName'] as const) if (update[f] !== undefined) set(f, update[f] !== '')
  return own.size ? { overrides: SHARED_FIELDS.filter(f => own.has(f)) } : {}
}

// A member's overrides once its workflow is saved: its agents or worktree
// setup become its own when they differ from the workspace's, and go back to
// the workspace's when they are the same or left out.
export function workflowOverrides(member: Project, ws: Project | undefined, t: Pick<Template, 'prefs' | 'worktree'>): Pick<Project, 'overrides'> {
  if (!member.workspace) return {}
  const own = new Set(member.overrides ?? [])
  for (const f of ['prefs', 'worktree'] as const) {
    const differs = t[f] !== undefined && JSON.stringify(t[f]) !== JSON.stringify(ws?.shared?.[f])
    if (differs) own.add(f)
    else own.delete(f)
  }
  return own.size ? { overrides: SHARED_FIELDS.filter(f => own.has(f)) } : {}
}

// What the store refuses in a project list: a workspace with git, or in a
// workspace; a member of a project that is not a workspace; an unknown override.
// A member names one workspace (a string), so a project is in one at most.
export function workspaceErrors(list: Project[]): string[] {
  const errors: string[] = []
  for (const p of list) {
    if (isWorkspace(p) && p.git !== false) errors.push(`Workspace ${p.key} is a folder without git`)
    if (p.workspace === undefined) continue
    if (typeof p.workspace !== 'string' || !workspaceOf(p, list)) errors.push(`${p.key} names no existing workspace`)
    if (isWorkspace(p)) errors.push(`Workspace ${p.key} cannot be in a workspace`)
    if ((p.overrides ?? []).some(f => !isSharedField(f))) errors.push(`${p.key} overrides an unknown field`)
  }
  return errors
}

// Why a workspace refuses a task of this type ('' when it takes it).
export const workspaceTaskError = (p: Pick<Project, 'kind'>, type: string) =>
  isWorkspace(p) && type !== FEATURE ? 'A workspace holds features only: add the task to one of its projects' : ''

// A workspace's shared settings, checked as the General tab's fields are.
export function cleanShared(raw: unknown): { shared?: WorkspaceShared, errors: WorkflowError[] } {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const { prefs, worktree, ...fields } = o
  const { update, errors } = cleanProjectUpdate(Object.fromEntries(Object.entries(fields).filter(([k]) => isSharedField(k) || k === 'clones' || k === 'paused')))
  checkPrefs(prefs, 'prefs', errors)
  checkSetup(worktree, errors)
  if (errors.length || !update) return { errors: errors.map(e => ({ ...e, path: `shared.${e.path}` })) }
  const { deleteBranch, base, branchName, ...kept } = update
  return { errors, shared: defined({ ...kept, base: base || undefined, branchName: branchName || undefined, deleteBranch: deleteBranch === false ? false as const : undefined, prefs: prefs as Prefs | undefined, worktree: worktree as WorktreeSetup | undefined }) }
}

// A new project's workspace fields: { kind: 'workspace', group?, shared? } or
// { workspace: <key> } (a member, which keeps only its key, name, machine, path and workspace).
export function cleanWorkspaceFields(raw: unknown): { fields: Pick<Project, 'kind' | 'group' | 'shared' | 'workspace'>, errors: WorkflowError[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: WorkflowError[] = []
  if (o.workspace !== undefined) {
    const key = typeof o.workspace === 'string' ? o.workspace.trim().toUpperCase() : ''
    if (!KEY_RE.test(key)) errors.push({ path: 'workspace', message: 'a workspace\'s key' })
    if (o.kind !== undefined) errors.push({ path: 'kind', message: 'a workspace cannot be in a workspace' })
    return { fields: { workspace: key }, errors }
  }
  if (o.kind === undefined) return { fields: {}, errors }
  if (o.kind !== 'workspace') errors.push({ path: 'kind', message: 'workspace, or none' })
  if (o.group !== undefined && !(typeof o.group === 'string' && o.group.length <= 64)) errors.push({ path: 'group', message: 'a tab group id' })
  const { shared, errors: bad } = o.shared === undefined ? { shared: undefined, errors: [] } : cleanShared(o.shared)
  return { fields: defined({ kind: 'workspace' as const, group: o.group as string | undefined, shared }), errors: [...errors, ...bad] }
}
