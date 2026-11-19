// A workspace's features (docs/workspaces.md#features): a task of the
// workspace (`kind: 'feature'`) that runs no agent; its sub-tasks are
// ordinary tasks of its members (`feature: <WS-n>`), one per repository,
// ordered by `after` across the workspace's projects. `feature split` adds
// them all in one call; the feature's state is derived from them.
import { afterIds, mergeAfterIds } from './advance'
import { parseFiles } from './files'
import { parsePlanPath, parseRefs } from './planRefs'
import { coordinatorKey } from './workspace'
import type { Project } from './project'
import type { Task } from './run'

export type FeatureCommand =
  | { name: 'feature add', title: string, description?: string }
  | { name: 'feature split', task: string, from?: string } // the plan comes as the call's input (JSON), or from the file --from names
  | { name: 'feature close', task: string, reason?: string, anyway?: true }

export const FEATURE_COMMANDS = [
  { usage: 'feature add "<title>" [--description "<text>"]', does: 'add a feature to the workspace: it runs no agent; split it into sub-tasks of its repositories with feature split' },
  { usage: 'feature split <feature> [--from <path>] < plan.json', does: 'in one call: adopt the repositories it needs, add one sub-task per repository, chain them and start those that wait for nothing; all or nothing. The plan, on stdin or in the file --from names (a path under the workspace\'s root): {"order": "<why this order, one line>", "plan"?: "<the spec\'s tasks.md, its path under the root>", "tasks": [{"repo" (its path under the root, or a member\'s key), "title", "type", "description"?, "files"?: [...], "refs"?: ["T010", "T011"], "after"?: [<repo of the plan>, <task>…], "mergeAfter"?: [<repo of the plan>, <task>…]}]}: after orders the starts, mergeAfter the merges (its PR merges once those are done). plan and refs: the lines (`- [ ] T010 …`) of that tasks.md each sub-task covers; wherdr ticks them itself once the sub-task is done (put refs on every entry when the plan comes from a tasks.md; refs need plan). Later changes: task add --feature [--refs T1,T2], task edit --after/--merge-after' },
  { usage: 'feature close <feature> [--reason "<one sentence>"] [--anyway]', does: 'close a feature once each of its sub-tasks is done or abandoned: it shows as done. A feature with a plan file is refused while lines of it are still unticked (they are listed): ask the user, then add --anyway' },
]

const TASK_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/
const usage = (i: number) => ({ error: `usage: wherdr pm ${FEATURE_COMMANDS[i]!.usage}` })

// `feature …` words (after `feature`) → a command, or why not.
export function parseFeature(words: string[], flags: Record<string, string>): FeatureCommand | { error: string } {
  const [verb, ...rest] = words
  if (verb === 'add') {
    const title = rest.join(' ').trim(), description = flags.description?.trim()
    if (!title || title.length > 200) return usage(0)
    if (description && description.length > 20000) return { error: '--description is 20000 characters at most' }
    return { name: 'feature add', title, ...(description ? { description } : {}) }
  }
  const [task, extra] = rest
  if (verb === 'split') {
    const from = flags.from?.trim()
    if (flags.from !== undefined && (!from || from.length > 1024 || /[\x00-\x1f]/.test(from))) return { error: '--from is the path of a plan file under the workspace\'s root' }
    return task && TASK_RE.test(task) && !extra ? { name: 'feature split', task, ...(from ? { from } : {}) } : usage(1)
  }
  if (verb !== 'close' || !task || !TASK_RE.test(task) || extra) return usage(2)
  const reason = flags.reason?.trim()
  if (reason !== undefined && (!reason || reason.length > 300 || reason.includes('\n'))) return { error: '--reason is one sentence (300 characters at most)' }
  return { name: 'feature close', task, ...(reason ? { reason } : {}), ...(flags.anyway ? { anyway: true as const } : {}) }
}

export interface PlanTask { repo: string, title: string, type: string, description: string, files: string[], refs: string[], after: string[], mergeAfter: string[] }
export interface Plan { order: string, tasks: PlanTask[], file?: string } // file: the plan file (tasks.md) under the root, whose lines the tasks' refs name

// The split's JSON → its sub-tasks in start order (each after the plan's
// repositories it names), or why not: a repository twice, an unknown one, a cycle.
export function parsePlan(raw: unknown): Plan | { error: string } {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  const order = str(o.order)
  if (!order || order.length > 300 || order.includes('\n')) return { error: 'plan.order: why this order, one line (300 characters at most)' }
  if (!Array.isArray(o.tasks) || !o.tasks.length || o.tasks.length > 20) return { error: 'plan.tasks: 1 to 20 sub-tasks, one per repository' }
  const tasks: PlanTask[] = []
  for (const [i, x] of (o.tasks as Record<string, unknown>[]).entries()) {
    const list = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : [])
    const refs = parseRefs(x?.refs)
    if ('error' in refs) return { error: `plan.tasks[${i}].refs: ${refs.error}` }
    const t = { repo: str(x?.repo), title: str(x?.title), type: str(x?.type), description: str(x?.description).slice(0, 20000), files: parseFiles(x?.files), refs, after: list(x?.after), mergeAfter: list(x?.mergeAfter) }
    if (!t.repo || !t.type || !t.title || t.title.length > 200) return { error: `plan.tasks[${i}]: repo, title (1 to 200 characters) and type are required` }
    if (t.refs.length && o.plan === undefined) return { error: `plan.tasks[${i}].refs: refs name lines of a plan file: add "plan": "<its path under the root>"` }
    if (tasks.some(y => y.repo === t.repo)) return { error: `plan.tasks[${i}]: ${t.repo} twice: one sub-task per repository` }
    tasks.push(t)
  }
  const file = o.plan === undefined ? undefined : parsePlanPath(o.plan)
  if (typeof file === 'object') return file
  const repos = new Set(tasks.map(t => t.repo))
  for (const k of ['after', 'mergeAfter'] as const) {
    const bad = tasks.flatMap(t => t[k]).find(a => !repos.has(a) && !TASK_RE.test(a))
    if (bad) return { error: `plan.tasks[].${k}: ${bad} is neither a repository of the plan nor a task` }
  }
  // Start order: each task once those of the plan it waits for are placed.
  // Never a cycle, through after and mergeAfter together: a task waits to be
  // done for both, so any such cycle blocks every task in it.
  const ranked = (links: (t: PlanTask) => string[], what: string) => {
    const sorted: PlanTask[] = []
    while (sorted.length < tasks.length) {
      const next = tasks.find(t => !sorted.includes(t) && links(t).every(a => !repos.has(a) || sorted.some(s => s.repo === a)))
      if (!next) return { error: `plan: a cycle in ${what} (${tasks.filter(t => !sorted.includes(t)).map(t => t.repo).join(', ')})` }
      sorted.push(next)
    }
    return sorted
  }
  const sorted = ranked(t => t.after, 'after')
  if ('error' in sorted) return sorted
  const both = ranked(t => [...t.after, ...t.mergeAfter], 'after and mergeAfter')
  return 'error' in both ? both : { order, tasks: sorted, ...(file ? { file } : {}) }
}

// Why `after` (or `mergeAfter`) may not link this task (self: its id, once it
// exists) to these: a task outside its project's workspace (or project), a
// feature, or a cycle through after and mergeAfter together (each blocks it).
export function afterRefusal(project: string, ids: string[], tasks: Pick<Task, 'id' | 'project' | 'after' | 'mergeAfter' | 'kind'>[], projects: Project[], self?: string, field: 'after' | 'mergeAfter' = 'after'): string | undefined {
  const group = coordinatorKey(project, projects)
  const out = ids.find(id => !tasks.some(t => t.id === id && t.kind !== 'feature' && coordinatorKey(t.project, projects) === group))
  if (out) return `tasks of the same project or workspace, comma-separated (not ${out})`
  if (!self) return undefined
  const seen = new Set<string>(), todo = [...ids]
  for (let id = todo.pop(); id; id = todo.pop()) {
    if (id === self) return `${self} would wait for itself: a cycle in ${field}`
    if (seen.has(id)) continue
    seen.add(id)
    const t = tasks.find(x => x.id === id) ?? {}
    todo.push(...afterIds(t), ...mergeAfterIds(t))
  }
  return undefined
}

export type FeatureState = 'todo' | 'working' | 'waiting' | 'done'
export const subTasks = (feature: Pick<Task, 'id'>, tasks: Task[]) => tasks.filter(t => t.feature === feature.id)
const ended = (t: Task) => !!t.step?.done || !!t.step?.abandoned

// Never stored: done once closed; waiting for you while an open sub-task is
// under Your turn; working once one started or ended (until it is closed); else to do.
export function featureState(feature: Task, tasks: Task[]): FeatureState {
  if (feature.closed) return 'done'
  const subs = subTasks(feature, tasks)
  if (subs.some(t => !ended(t) && (t.step?.yourTurn || t.stopped || t.state === 'waiting'))) return 'waiting'
  return subs.some(t => ended(t) || t.step?.started || t.state === 'working') ? 'working' : 'todo'
}

// Why the feature may not be closed: a sub-task neither done nor abandoned.
export function closeRefusal(feature: Task, tasks: Task[]): string | undefined {
  if (feature.closed) return `${feature.id} is already closed`
  const open = subTasks(feature, tasks).filter(t => !ended(t)).map(t => t.id)
  return open.length ? `${open.join(', ')} still open: close the feature once each sub-task is done or abandoned` : undefined
}
