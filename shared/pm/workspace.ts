// Workspaces (docs/workspaces.md): a project of kind "workspace" (no git, its
// path a root folder such as ~/work, shown in tab group `group`) whose
// coordinator runs a set of linked repositories. Each repository it works on
// is a member project (`workspace: <its key>`, no coordinator of its own),
// which takes the workspace's `shared` settings unless it lists the field in
// `overrides`. effectiveProject is the one place that resolves them.
import type { WorkflowError } from './workflow'
import { checkPrefs, checkSetup, defaultWorkflow, type Prefs, type Template, type WorktreeSetup } from './workflow'
import type { Strategy } from './placement'
import type { Task } from './run'
import type { OnStateChange } from './onState'
import { KEY_RE, cleanProjectUpdate, type Project, type ProjectUpdate } from './project'
import { ROOT_REPO, underRoot } from './workspaceAdopt'

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
  commitMessage?: string
  onStateChange?: OnStateChange
  prefs?: Prefs // agents, models and reviewer fallback of the members' tasks
  worktree?: WorktreeSetup
  archiveAfter?: number
  deleteBranch?: false
  // Files under the root whose text every member task's worker and reviewer
  // get (workspaceInstructions); missing: AGENTS.md, else CLAUDE.md; []: none.
  instructionsFiles?: string[]
  // false: the root's skills (workspaceSkills) reach no member task.
  rootSkills?: false
}

// The fields a member may set itself (`overrides`); 'machines' covers its
// machines, clones and paused ones.
export const SHARED_FIELDS = ['machines', 'placement', 'base', 'branchName', 'commitMessage', 'onStateChange', 'prefs', 'worktree', 'archiveAfter', 'deleteBranch', 'instructionsFiles'] as const
export type SharedField = typeof SHARED_FIELDS[number]
export const isSharedField = (f: unknown): f is SharedField => (SHARED_FIELDS as readonly unknown[]).includes(f)

// The only task type a workspace holds (its sub-tasks are its members' tasks).
export const FEATURE = 'feature'

export const isWorkspace = (p: Pick<Project, 'kind'> | undefined) => p?.kind === 'workspace'
export const workspaceOf = (member: Pick<Project, 'workspace'>, list: Project[]) =>
  member.workspace ? list.find(p => p.key === member.workspace && isWorkspace(p)) : undefined

// The first message of a new workspace's coordinator: it offers to build the map.
export const WORKSPACE_FIRST = 'You were just started on a new workspace. Run `wherdr pm map list` now, then in this first reply offer the user to build the map from it: list the repositories it found, and write a line (`map set`) for each one they confirm.'

// A new workspace (Settings › Projects › Add workspace, `wherdr alfred workspace
// add`): roots, the clone root on each machine, its home machine first.
export interface WorkspaceForm { key: string, name?: string, group?: string, roots: [machine: string, root: string][] }
export function workspaceInput(f: WorkspaceForm) {
  const [[machine, path] = ['', ''], ...others] = f.roots
  return {
    key: f.key, ...(f.name ? { name: f.name } : {}), machine, path, kind: 'workspace' as const, ...(f.group ? { group: f.group } : {}),
    ...(others.length ? { shared: { machines: others.map(([m]) => m), clones: Object.fromEntries(others) } } : {}),
  }
}

// The workspace instructions files a member's tasks take, read from the
// workspace's root on its home machine: the member's own list when it
// overrides them, else the workspace's; `first`: the default, only the first
// one found counts and a missing one says nothing. None: not a member, or turned off.
export const DEFAULT_INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md']
export const INSTRUCTIONS_CAP = 16000 // characters kept of each file
export function workspaceInstructions(member: Project, list: Project[]): { machine: string, root: string, paths: string[], first?: true } | undefined {
  const ws = workspaceOf(member, list)
  // The root's own repository: its worktrees already hold the root's files.
  if (!ws || isRootMember(member, ws)) return undefined
  const own = (member.overrides ?? []).includes('instructionsFiles'), set = own ? member.instructionsFiles ?? [] : ws.shared?.instructionsFiles
  if (set && !set.length) return undefined
  return { machine: ws.machine, root: ws.path, paths: set ?? DEFAULT_INSTRUCTIONS, ...(set ? {} : { first: true as const }) }
}

// The root's skills folder a member task's worktree on `machine` links (one
// link per skill, linkSkills in pmLaunch.ts): <root there>/.claude/skills,
// `~` read as `home`; off: turned off (the links made before go). None: not a
// member, the root's own repository (its worktree holds them), or no root on that machine.
export const SKILLS_DIR = '.claude/skills'
export function workspaceSkills(member: Project, list: Project[], machine: string, home: string): { dir: string, off?: true } | undefined {
  const ws = workspaceOf(member, list)
  if (!ws || isRootMember(member, ws)) return undefined
  const root = rootOn(ws, machine)
  return root ? { dir: `${trim(root).replace(/^~(?=\/|$)/, () => home)}/${SKILLS_DIR}`, ...(ws.shared?.rootSkills === false ? { off: true as const } : {}) } : undefined
}

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

// The workspace's machines, clone roots and paused machines: its shared
// settings first, else its own fields (where its sheet's Machines saves them).
const wsMachines = (ws: Project) => ({ machines: ws.shared?.machines ?? ws.machines ?? [], clones: ws.shared?.clones ?? ws.clones, paused: ws.shared?.paused ?? ws.paused ?? [] })
// The workspace's clone root on a machine: its own path at home, else its clones'.
const rootOn = (ws: Project, machine: string) => (machine === ws.machine ? ws.path : wsMachines(ws).clones?.[machine])

// The member's repository path under the workspace's root (payroll-api for
// ~/work/payroll-api; ROOT_REPO for the root's own repository), else its folder's name.
export function repoPath(member: Pick<Project, 'machine' | 'path'>, ws: Project) {
  const root = rootOn(ws, member.machine), path = trim(member.path)
  if (root && path === trim(root)) return ROOT_REPO
  return root && path.startsWith(`${trim(root)}/`) ? path.slice(trim(root).length + 1) : path.split('/').pop()!
}

// The member that is the workspace's root's own repository.
export const isRootMember = (member: Pick<Project, 'machine' | 'path'>, ws: Project) => repoPath(member, ws) === ROOT_REPO

// The member's machines from the workspace's: its home first, then each one
// with a clone root, its clone under that root.
function sharedMachines(member: Project, ws: Project): Pick<Project, 'machines' | 'clones' | 'paused'> {
  const repo = repoPath(member, ws)
  const others = [ws.machine, ...wsMachines(ws).machines].filter((m, i, all) => m !== member.machine && all.indexOf(m) === i && rootOn(ws, m))
  // A machine the workspace paused stays paused for the member, its home included.
  const paused = wsMachines(ws).paused.filter(m => m === member.machine || others.includes(m))
  return { ...(others.length ? { machines: [member.machine, ...others], clones: Object.fromEntries(others.map(m => [m, underRoot(rootOn(ws, m)!, repo)])) } : {}), ...(paused.length ? { paused } : {}) }
}

// The settings in force for a project: a member's override wins, else the
// workspace's shared value (none: the usual default). Any other project as is.
export function effectiveProject(member: Project, ws: Project | undefined): Project {
  if (!member.workspace || !ws || !isWorkspace(ws)) return member
  const own = new Set(member.overrides ?? []), s = ws.shared ?? {}
  const { machines, clones, paused, placement, base, branchName, commitMessage, onStateChange, archiveAfter, deleteBranch, ...rest } = member
  const pick = <K extends 'placement' | 'base' | 'branchName' | 'commitMessage' | 'onStateChange' | 'archiveAfter' | 'deleteBranch'>(k: K) => (own.has(k) ? member[k] : s[k])
  return {
    ...rest,
    ...(own.has('machines') ? defined({ machines, clones, paused }) : sharedMachines(member, ws)),
    ...defined({ placement: pick('placement'), base: pick('base'), branchName: pick('branchName'), commitMessage: pick('commitMessage'), onStateChange: pick('onStateChange'), archiveAfter: pick('archiveAfter'), deleteBranch: pick('deleteBranch') }),
  }
}

// The shared settings a workspace once kept on itself (before they went in
// `shared`, where its members read them); lift / sink move them out of and back into it.
export const MOVED_FIELDS = ['base', 'branchName', 'placement', 'archiveAfter', 'deleteBranch'] as const
type Moved = typeof MOVED_FIELDS[number]
// A workspace with these fields in `shared` gets them on itself (updateProject works there), any other as is.
export function liftShared(ws: Project): Project {
  if (!isWorkspace(ws)) return ws
  return { ...ws, ...defined(Object.fromEntries(MOVED_FIELDS.map(f => [f, ws.shared?.[f]]))) }
}
// A workspace's fields on itself go into `shared` (the ones missing leave it).
export function sinkShared(ws: Project): Project {
  if (!isWorkspace(ws)) return ws
  const out = { ...ws } as Project & Partial<Record<Moved, unknown>>, shared = { ...ws.shared } as Record<string, unknown>
  for (const f of MOVED_FIELDS) { shared[f] = out[f]; delete out[f] }
  const kept = defined(shared) as WorkspaceShared
  const { shared: _, ...rest } = out
  return { ...rest, ...(Object.keys(kept).length ? { shared: kept } : {}) }
}
// Migration: a workspace that kept them on itself and has none in `shared` (the keys moved).
export const needsSink = (p: Project) => isWorkspace(p) && MOVED_FIELDS.some(f => p[f] !== undefined) && !MOVED_FIELDS.some(f => p.shared?.[f] !== undefined)

export const effectiveProjects = (list: Project[]) => list.map(p => effectiveProject(p, workspaceOf(p, list)))

// The agents and worktree setup a workspace gives its members: its shared
// settings first, else its own workflow file (`shared`), where its sheet saves its worktree setup.
export const sharedSetup = (ws: Project | undefined, shared: Template | null = null): Pick<Template, 'prefs' | 'worktree'> =>
  defined({ prefs: ws?.shared?.prefs ?? shared?.prefs, worktree: ws?.shared?.worktree ?? shared?.worktree })

// The workflow a member runs: its own file (`saved`) when it has one, else
// its workspace's (`shared`, workflows/<WS>.json), else the default; with the
// workspace's agents and worktree setup unless it overrides them, and the
// workspace's guards, which its own only harden. Any other project: its own.
export function effectiveWorkflow(key: string, saved: Template | null, member: Project | undefined, ws: Project | undefined, shared: Template | null = null, agent?: { program?: string, model?: string }): Template {
  const id = key.toLowerCase()
  if (!member?.workspace || !ws || !isWorkspace(ws)) return saved ?? defaultWorkflow(key, agent)
  const t = saved ?? (shared ? { ...ownWorkflow(shared), id } : defaultWorkflow(key, agent))
  const own = new Set(member.overrides ?? [])
  const { prefs, worktree, workspaceGuards: _, ...rest } = t
  return {
    ...rest,
    // Its own ones: from its file, else the ones set in its General tab (member.prefs, member.worktree).
    // Else the workspace's, wherever it keeps them (sharedSetup).
    ...defined({ prefs: own.has('prefs') ? (saved ? prefs : member.prefs ?? prefs) : sharedSetup(ws, shared).prefs ?? prefs, worktree: own.has('worktree') ? (saved ? worktree : member.worktree) : sharedSetup(ws, shared).worktree }),
    ...(shared?.guards ? { workspaceGuards: shared.guards } : {}),
  }
}

// A workflow as it is saved or shown for editing: without its workspace's guards.
export function ownWorkflow(t: Template): Template {
  const { workspaceGuards: _, ...own } = t
  return own
}

// A member's overrides once an update applies: each shared field it sets
// becomes its own; a base, branch name or commit message of '' clears it (back to the shared one).
export function memberOverrides(member: Project, update: ProjectUpdate): Pick<Project, 'overrides'> {
  if (!member.workspace) return {}
  const own = new Set(member.overrides ?? [])
  const set = (f: SharedField, on: boolean) => (on ? own.add(f) : own.delete(f))
  if (update.machines || update.clones || update.paused) set('machines', true)
  for (const f of ['placement', 'archiveAfter', 'deleteBranch'] as const) if (update[f] !== undefined) set(f, true)
  for (const f of ['base', 'branchName', 'commitMessage', 'onStateChange'] as const) if (update[f] !== undefined) set(f, update[f] !== '')
  // null: the workspace's again; [] turns them off; a list replaces them.
  if (update.instructionsFiles !== undefined) set('instructionsFiles', update.instructionsFiles !== null)
  return own.size ? { overrides: SHARED_FIELDS.filter(f => own.has(f)) } : {}
}

// A member back on its workspace's value for one field (its sheet's "Use
// <workspace>'s"): its own value and that override removed, the others kept.
export function followShared(member: Project, field: SharedField): Project {
  const out = { ...member } as Record<string, unknown>
  for (const k of field === 'machines' ? ['machines', 'clones', 'paused'] : [field]) delete out[k]
  const own = (member.overrides ?? []).filter(f => f !== field)
  delete out.overrides
  return { ...out, ...(own.length ? { overrides: own } : {}) } as unknown as Project
}

// A member whose own workflow is removed: its agents and worktree setup are its workspace's again.
export function backToWorkspace(member: Project): Project {
  const { prefs: _p, worktree: _w, overrides, ...rest } = member
  const own = (overrides ?? []).filter(f => f !== 'prefs' && f !== 'worktree')
  return { ...rest, ...(own.length ? { overrides: own } : {}) }
}

// A member's overrides once its workflow is saved: its agents or worktree
// setup become its own when they differ from the workspace's, and go back to
// the workspace's when they are the same or left out.
export function workflowOverrides(member: Project, ws: Project | undefined, t: Pick<Template, 'prefs' | 'worktree'>, shared: Template | null = null): Pick<Project, 'overrides'> {
  if (!member.workspace) return {}
  const own = new Set(member.overrides ?? []), theirs = sharedSetup(ws, shared)
  for (const f of ['prefs', 'worktree'] as const) {
    const differs = t[f] !== undefined && JSON.stringify(t[f]) !== JSON.stringify(theirs[f])
    if (differs) own.add(f)
    else own.delete(f)
  }
  return own.size ? { overrides: SHARED_FIELDS.filter(f => own.has(f)) } : {}
}

// What the store refuses in a project list: a workspace stored with git (its
// root may be a git repository, which is then a member, never the workspace), or in a
// workspace; a member of a project that is not a workspace; an unknown override.
// A member names one workspace (a string), so a project is in one at most.
export function workspaceErrors(list: Project[]): string[] {
  const errors: string[] = []
  for (const p of list) {
    if (isWorkspace(p) && p.git !== false) errors.push(`Workspace ${p.key} is stored without git (git: false): a git repository at its root is a member project`)
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
  // On state change is the user's own, from the project sheet (pmProject.ts): never in a new workspace's fields.
  const { deleteBranch, base, branchName, commitMessage, onStateChange: _os, instructionsFiles, rootSkills: _rs, ...kept } = update
  return { errors, shared: defined({ ...kept, instructionsFiles: instructionsFiles ?? undefined, base: base || undefined, branchName: branchName || undefined, commitMessage: commitMessage || undefined, deleteBranch: deleteBranch === false ? false as const : undefined, prefs: prefs as Prefs | undefined, worktree: worktree as WorktreeSetup | undefined }) }
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

// Why a project may not be removed, or undefined. A workspace with members:
// they would lose its shared settings and coordinator, and a workspace added
// later under its key would take them back. A project with open tasks (not
// done, abandoned or closed): their agents would never be stopped, the tasks
// chained after them would wait forever, and a project added later under its
// key would take them over.
export function removeRefusal(key: string, list: Project[], tasks: Pick<Task, 'id' | 'project' | 'step' | 'closed'>[]): string | undefined {
  const members = membersOf(key, list)
  if (members.length) return `Workspace ${key} still has projects ${members.map(m => m.key).join(', ')}: remove them first`
  const open = tasks.filter(t => t.project === key && !t.closed && !t.step?.done && !t.step?.abandoned).map(t => t.id)
  if (open.length) return `${key} has open tasks (${open.slice(0, 5).join(', ')}${open.length > 5 ? `, and ${open.length - 5} more` : ''}): finish, abandon or close them first`
}
