// A project's settings (the project sheet): what it holds, and its changes.
// Guards are changed by the user or by Alfred only: a project coordinator's
// token is refused, and a workflow save (the user's or a coordinator's
// proposal) may not touch them.
import { MAIN, sameGuards } from '../../shared/pm/coordinator'
import { projectPlace } from '../../shared/pm/places'
import { freedMerge } from '../../shared/pm/guardEffects'
import { allowedMachines, cleanProjectUpdate, type Project } from '../../shared/pm/project'
import { taskPlan } from '../../shared/pm/run'
import { ownWorkflow } from '../../shared/pm/workspace'
import { PREF_KEYS, checkSetup, isDefaultWorkflow, type Guards, type Prefs, type Template, type WorkflowError, type WorktreeSetup } from '../../shared/pm/workflow'
import { HerdrError } from './herdr'
import { alfredTokenOk, scopeOf } from './pmCoordinator'
import type { CoreAdminDeps } from './coreCreate'
import { archiveDone, startAction } from './pmBoard'
import { lastReadiness } from './pmReady'
import type { PmStore } from './pmStore'

const bearer = (authorization: unknown) => String(authorization || '').replace(/^Bearer\s+/i, '')

// Who changes the guards: the user's session (no token), or Alfred with one
// of its tokens (`wherdr alfred`, or the main coordinator's `wherdr pm`).
// Any other token, a project coordinator's first, is refused.
export async function guardsAuthor(store: PmStore, authorization: unknown): Promise<'user' | 'Alfred'> {
  const token = bearer(authorization)
  if (!token) return 'user'
  const scope = await scopeOf(store, token)
  if (scope === MAIN || await alfredTokenOk(store, token)) return 'Alfred'
  if (scope) throw new HerdrError('forbidden', `A project coordinator never changes guards: the user does it in ${projectPlace(scope, 'guards', true)}`)
  throw new HerdrError('forbidden', 'Guards are changed by the user or by Alfred only')
}

async function workflowOf(store: PmStore, key: unknown) {
  const p = await store.project(key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = await store.workflow(p.key)
  if (!t) throw new HerdrError('not_found', 'The project has no workflow: ask its coordinator to propose one')
  return { p, t }
}

// GET /api/pm/project?key=: one load for the project sheet. A member without
// its own workflow gets its workspace's, the one its tasks follow, with
// `inherited` naming the workspace (its first saved change becomes its own).
export async function projectView(store: PmStore, key: string) {
  const p = await store.project(key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const proposal = (await store.coordinator(p.key))?.proposal
  // ready: each other allowed machine's last readiness check ('' ready, its failures otherwise; none never checked).
  const ready = Object.fromEntries(allowedMachines(p).slice(1).flatMap(m => { const r = lastReadiness(p.key, m); return r === undefined ? [] : [[m, r]] }))
  const saved = await store.savedWorkflow(p.key)
  const shared = !saved && p.workspace ? await store.workflow(p.key) : null
  const inherited = shared && !isDefaultWorkflow(shared) ? ownWorkflow(shared) : null
  return {
    project: p, workflow: saved ?? inherited, ...(inherited ? { inherited: p.workspace } : {}), log: await store.workflowLog(p.key), ready,
    ...(proposal ? { proposal: { diff: proposal.diff, at: proposal.at, base: proposal.base, ...(proposal.said ? { said: proposal.said } : {}) } } : {}),
  }
}

// { name?, base?, prefs? }: prefs (worker and reviewer agents) live in the workflow.
// authorization: the request's; with a token (a coordinator, Alfred) the On state change command is refused.
export async function updateProject(store: PmStore, key: unknown, body: Record<string, unknown>, authorization?: unknown) {
  if ((body.onStateChange !== undefined || body.follow === 'onStateChange') && bearer(authorization)) throw new HerdrError('forbidden', 'Only the user sets the On state change command, in the project\'s settings')
  // { follow: <field> }: a member takes its workspace's value of that field again.
  if (body.follow !== undefined) {
    const project = await store.followWorkspace(key, body.follow)
    if (body.follow === 'archiveAfter') await archiveDone(store)
    return { project }
  }
  const { update, errors } = cleanProjectUpdate(body)
  if (!update) throw new HerdrError('bad_input', errors.map(e => `${e.path}: ${e.message}`).join('; '))
  // A member without a workflow of its own: its agents and worktree setup are
  // kept on it (overrides), never a copy of its workspace's workflow.
  const p = await store.project(key)
  const member = !!p?.workspace && !(await store.savedWorkflow(p.key))
  if (body.prefs !== undefined) {
    const { t } = await workflowOf(store, key)
    const prefs = cleanPrefs(body.prefs)
    const { prefs: _old, ...rest } = t
    if (member) await store.setMemberSetup(key, { prefs })
    else await store.saveWorkflow(t.id.toUpperCase(), Object.keys(prefs).length ? { ...rest, prefs } : rest)
  }
  if (body.worktree !== undefined) {
    if (!member) await saveWorktreeSetup(store, key, body.worktree)
    else {
      const w = cleanSetup(body.worktree), errors: WorkflowError[] = []
      checkSetup(w, errors)
      if (errors.length) throw new HerdrError('bad_input', errors.map(e => `${e.path}: ${e.message}`).join('; '))
      await store.setMemberSetup(key, { worktree: w as WorktreeSetup })
    }
  }
  const project = await store.updateProject(key, update)
  // A shorter delay archives at once what it now covers.
  if (update.archiveAfter !== undefined) await archiveDone(store)
  return { project }
}

// The workflow's worktree block, from the General tab: empty fields dropped
// (but `share: []`, which shares no folder), none left removes it.
const cleanSetup = (raw: unknown) => Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([k, v]) => (Array.isArray(v) ? v.length || k === 'share' : v !== '' && v !== undefined && v !== null)))
// An empty value goes back to the default.
function cleanPrefs(body: unknown): Prefs {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  return Object.fromEntries(PREF_KEYS.flatMap(k => (typeof raw[k] === 'string' && raw[k] ? [[k, raw[k]]] : []))) as Prefs
}
async function saveWorktreeSetup(store: PmStore, key: unknown, raw: unknown) {
  const { p, t } = await workflowOf(store, key)
  const w = cleanSetup(raw)
  const { worktree: _old, ...rest } = t
  const next = Object.keys(w).length ? { ...rest, worktree: w as WorktreeSetup } : rest
  await store.saveWorkflow(p.key, next) // checked there
}

// A member back on its workspace's workflow: its own file removed (logged).
export async function resetMemberWorkflow(store: PmStore, key: unknown) {
  const p = await store.project(key)
  if (!p?.workspace) throw new HerdrError('refused', 'Only a workspace\'s project follows its workspace\'s workflow')
  if (!(await store.savedWorkflow(p.key))) throw new HerdrError('refused', `${p.key} already follows workspace ${p.workspace}'s workflow`)
  return { project: await store.setTemplate(p.key, '') }
}

// The user's save of the workflow: everything but the guards.
export async function saveProjectWorkflow(store: PmStore, key: unknown, next: unknown) {
  const { p, t } = await workflowOf(store, key)
  if (!sameGuards(t, next as Template)) throw new HerdrError('refused', `Guards are saved in ${projectPlace(p.key, 'guards')}, not with the workflow`)
  return { workflow: await store.saveWorkflow(p.key, next, { by: 'user' }) }
}

// The project's own guards (each task type's stay in its workflow). With
// deps, the merges they now give the engine are tried again at once (retryFreedMerges).
export async function saveProjectGuards(store: PmStore, key: unknown, guards: unknown, by: 'user' | 'Alfred', deps?: CoreAdminDeps) {
  const { p, t } = await workflowOf(store, key)
  const { guards: _old, ...rest } = t
  const next = guards && typeof guards === 'object' && Object.keys(guards).length ? { ...rest, guards: guards as Guards } : rest
  const workflow = await store.saveWorkflow(p.key, next, { by })
  if (deps) void retryFreedMerges({ ...deps, store }, p, t, next).catch(() => {})
  return { workflow }
}

// Each task of the project waiting at a merge its old guards refused and the
// new ones give the engine: the log says why, then the engine runs the step
// again, as its minute tick would for a merge it may do.
export async function retryFreedMerges(deps: CoreAdminDeps & { store: PmStore }, p: Project, before: Template, after: Template) {
  for (const task of (await deps.store.tasks()).filter(x => x.project === p.key)) {
    const into = freedMerge(task, taskPlan(before, task, p), taskPlan(after, task, p))
    if (!into) continue
    await deps.store.logTask(task, 'engine', `guards changed: the engine may now merge into ${into}, so it tries the step again`)
    startAction(deps, task.id, () => {})
  }
}
