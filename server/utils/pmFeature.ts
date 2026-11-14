// `wherdr pm feature split <WS-n>` (shared/pm/feature.ts): the plan checked
// whole first (repositories resolved, adoptions checked, types and links),
// the repositories it needs adopted, its sub-tasks added in one store write
// (store.splitFeature: all or none), then those that wait for nothing
// started. A failure after the adoptions drops the members just adopted.
import { afterRefusal, parsePlan, subTasks } from '../../shared/pm/feature'
import { isWorkspace, membersOf, repoPath } from '../../shared/pm/workspace'
import { renderMap } from '../../shared/pm/workspaceMap'
import { storedTaskId } from '../../shared/pm/projectKey'
import type { Project } from '../../shared/pm/project'
import type { Task } from '../../shared/pm/run'
import type { CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import { addAdopted, checkAdoption } from './pmAdopt'
import { writeMapFile } from './pmMap'
import type { PmStore } from './pmStore'

type Deps = CoreAdminDeps & { store: PmStore }

export async function splitFeature(deps: Deps, ws: Project | undefined, feature: Task, input: unknown, { by, origin }: { by: string, origin: 'user' | 'coordinator' }, start: (t: Task) => Promise<unknown>) {
  if (!ws || !isWorkspace(ws) || feature.kind !== 'feature') throw new HerdrError('bad_input', `${feature.id} is not a workspace's feature`)
  let raw: unknown
  try { raw = JSON.parse(String(input ?? '')) } catch { throw new HerdrError('bad_input', 'The plan is not valid JSON (on stdin)') }
  const plan = parsePlan(raw)
  if ('error' in plan) throw new HerdrError('bad_input', plan.error)
  const { store } = deps
  const all = await store.tasks(), list = await store.projects()
  if (feature.closed || subTasks(feature, all).length) throw new HerdrError('refused', feature.closed ? `${feature.id} is closed` : `${feature.id} is already split: add a sub-task with task add --feature ${feature.id}`)
  const members = membersOf(ws.key, list)
  const memberAt = (repo: string) => members.find(m => m.key === repo || repoPath(m, ws) === repo)
  // Each task's repository: a member, else one to adopt (checked now, symlinks resolved); once each.
  const where: ({ key: string } | { repo: string, path: string })[] = []
  for (const t of plan.tasks) {
    const m = memberAt(t.repo), checked = m ? undefined : await checkAdoption(deps, ws, list, { name: 'repo adopt', repo: t.repo })
    const at = m ?? (checked && memberAt(checked.repo)) ?? checked!
    if (where.some(w => ('key' in w && 'key' in at ? w.key === at.key : 'repo' in w && 'repo' in at && w.repo === at.repo))) throw new HerdrError('bad_input', `${t.repo}: its repository twice: one sub-task per repository`)
    where.push('key' in at ? { key: at.key } : at)
  }
  // Every task type and link checked before anything changes: a new member runs the workspace's workflow.
  for (const [i, t] of plan.tasks.entries()) {
    const w = where[i]!, types = (await store.workflow('key' in w ? w.key : ws.key))?.taskTypes
    if (types && !Object.hasOwn(types, t.type)) throw new HerdrError('bad_input', `${t.repo}: no task type "${t.type}": ${Object.keys(types).join(', ')}`)
    for (const k of ['after', 'mergeAfter'] as const) {
      const outside = afterRefusal(ws.key, t[k].filter(a => !plan.tasks.some(x => x.repo === a)).map(a => storedTaskId(list, a) ?? a), all, list)
      if (outside) throw new HerdrError('bad_input', `${t.repo}: ${k}: ${outside}`)
    }
  }
  const adopted: { key: string, repo: string }[] = []
  try {
    // Tracked once saved: a failure in the rest of its adoption (log, map) drops it too.
    for (const w of where) if ('repo' in w) await addAdopted(deps, ws, w, by, key => adopted.push({ key, repo: w.repo }))
    const keyOf = (w: typeof where[number]) => ('key' in w ? w.key : adopted.find(a => a.repo === w.repo)!.key)
    const index = (repo: string) => plan.tasks.findIndex(t => t.repo === repo)
    const { feature: split, tasks } = await store.splitFeature(feature.id, plan.tasks.map((t, i) => ({
      project: keyOf(where[i]!), title: t.title, type: t.type, description: t.description, files: t.files, origin, addedBy: ws.key,
      after: t.after.filter(a => index(a) < 0).join(','), afterIndex: t.after.map(index).filter(x => x >= 0),
      mergeAfter: t.mergeAfter.filter(a => index(a) < 0).join(','), mergeAfterIndex: t.mergeAfter.map(index).filter(x => x >= 0),
    })), plan.order, by)
    // A start that fails leaves its sub-task to do, as task start would: the split stays.
    const started: string[] = [], notStarted: Record<string, string> = {}
    for (const t of tasks.filter(x => !x.after)) await start(t).then(() => started.push(t.id), (e: Error) => { notStarted[t.id] = e.message })
    return { feature: split, tasks: tasks.map(t => ({ id: t.id, project: t.project, title: t.title, ...(t.after ? { after: t.after } : {}), ...(t.mergeAfter ? { mergeAfter: t.mergeAfter } : {}) })), ...(adopted.length ? { adopted: adopted.map(a => a.key) } : {}), started, ...(Object.keys(notStarted).length ? { notStarted } : {}) }
  } catch (e) {
    await dropAdopted(deps, ws, adopted, by, feature.id)
    throw e
  }
}

// A refused split leaves no member behind: each one it adopted removed, its map line as before.
async function dropAdopted(deps: Deps, ws: Project, adopted: { key: string, repo: string }[], by: string, feature: string) {
  if (!adopted.length) return
  const { store } = deps
  for (const a of adopted) {
    await store.removeProject(a.key).catch(() => {})
    await store.logProject(ws.key, { by, text: `removed project ${a.key} (${a.repo}) again: the split of ${feature} was refused` }).catch(() => {})
  }
  const keys = new Set(adopted.map(a => a.key))
  const file = await store.changeMap(ws.key, f => ({ ...f, entries: f.entries.map(({ project, ...e }) => (project && !keys.has(project) ? { ...e, project } : e)) })).catch(() => null)
  if (file?.entries.some(e => adopted.some(a => a.repo === e.repo))) await writeMapFile(deps, ws, renderMap(ws, file)).catch(() => {})
}
