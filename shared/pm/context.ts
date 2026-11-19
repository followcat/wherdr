// Context folders: read-only snapshots of other members of a task's workspace,
// each at its base branch, that a worker or reviewer may read (docs/workspaces.md).
// Pure rules: which members a setting names, what the agent is told, which
// snapshots may go. server/utils/pmLaunch.ts makes them, pmCleanup.ts removes them.
import type { Project } from './project'
import type { Run, Task } from './run'
import type { ContextSpec, Template } from './workflow'
import { projectOf, shownKey } from './projectKey'
import { membersOf, repoPath, workspaceOf } from './workspace'
import { cleanupOf, underRoot } from './cleanup'

// A snapshot a run reads: the member, its repository path under the workspace's
// root, the commit and the folder (shared by every task on the machine).
// how: not-fetched (origin's branch could not be fetched: the clone's copy of it) or
// local (the clone has no origin); none: fetched just now.
// changed: the shared snapshot had been changed since it was made, and was built again.
export interface ContextFolder { member: string, repo: string, sha: string, dir: string, how?: 'not-fetched' | 'local', changed?: true }

// A task's own setting wins over its task type's.
export const taskContext = (t: Template | null | undefined, task: Pick<Task, 'type' | 'context'>): ContextSpec | undefined =>
  task.context ?? t?.taskTypes[task.type]?.context

const NOT_IN_WORKSPACE = 'the project is not in a workspace'

// The members a setting names for a task of `p`: every other member of its
// workspace ('all'), or the ones listed. What it cannot give is skipped, each with its reason.
// list: the projects, as the store gives them (effective settings).
export function contextMembers(spec: ContextSpec, p: Project, list: Project[]): { members: Project[], skipped: { key: string, why: string }[] } {
  const ws = workspaceOf(p, list)
  if (!ws) return { members: [], skipped: spec === 'all' || spec.length ? [{ key: spec === 'all' ? spec : spec.join(','), why: NOT_IN_WORKSPACE }] : [] }
  const members: Project[] = [], skipped: { key: string, why: string }[] = []
  const take = (m: Project) => { if (m.git === false) skipped.push({ key: shownKey(m), why: 'not a git repository' }); else members.push(m) }
  if (spec === 'all') {
    for (const m of membersOf(ws.key, list)) if (m.key !== p.key) take(m)
    return { members, skipped }
  }
  for (const key of spec) {
    const m = projectOf(list, key)
    if (!m || m.workspace !== ws.key) skipped.push({ key, why: `not a member of ${shownKey(ws)}` })
    else if (m.key === p.key) skipped.push({ key, why: 'the task\'s own project' })
    else if (!members.includes(m)) take(m)
  }
  return { members, skipped }
}

// A setting asked for a task (task add, task edit): refused outside a workspace's
// member project and for a project that is not another member of it; else the
// setting with each key as the project's stored key.
export function checkTaskContext(spec: ContextSpec, p: Project, list: Project[]): { context: ContextSpec } | { error: string } {
  if (!workspaceOf(p, list)) return { error: 'Context folders are for a member project of a workspace: this project is not in one' }
  if (spec === 'all') return { context: spec }
  const { skipped } = contextMembers(spec, p, list)
  if (skipped.length) return { error: `Context: ${skipped.map(s => `${s.key}: ${s.why}`).join('; ')}` }
  return { context: spec.map(k => projectOf(list, k)!.key) }
}

// Where the snapshots of every member are, and those of one member, on a machine.
export const contextBase = (home: string, pm: string) => `${home}/${pm}/context`
export const contextRoot = (home: string, pm: string, member: string) => `${contextBase(home, pm)}/${member}`

// The snapshot script's arguments (CONTEXT_SCRIPT): the member's clone, the
// folder of its snapshots, its base branch ('' the repository's default), the commit an earlier start pinned.
export const contextArgs = (clone: string, root: string, base = '', pin = '') => [clone, root, base, pin]

const short = (f: ContextFolder) => `${f.sha.slice(0, 7)}${f.how ? ` (${f.how === 'local' ? 'local branch' : 'not fetched'})` : ''}`

// The instructions' section: the folders, and the rule.
export function contextSection(folders: ContextFolder[]): string[] {
  if (!folders.length) return []
  return [
    '## Context (read only)', '',
    'These folders hold other repositories of the workspace, each at its base branch as of the commit shown. They are read only: change nothing in them. Read only; cite path:line from these folders.', '',
    ...folders.map(f => `- ${f.member}: ${f.repo} @ ${short(f)}, in ${f.dir}`), '',
  ]
}

// The task log's one line for a start: what it got, and what it skipped.
export function contextLine(folders: ContextFolder[], skipped: { key: string, why: string }[]) {
  const got = folders.map(f => `${f.member} @ ${short(f)}${f.changed ? ' (it had been changed: built again)' : ''}`).join(', ') || 'none'
  return `context: ${got}${skipped.length ? ` (skipped ${skipped.map(s => `${s.key}: ${s.why}`).join('; ')})` : ''}`
}

// The snapshots a run is told of, by member: its worker's and its reviewer's latest.
const latest = (runs: Run[], task: string, role: Run['role']) => runs.filter(r => r.task === task && r.role === role).sort((a, b) => b.startedAt - a.startedAt)[0]

// Snapshot folders under `root` on `machine` that no task still needs: those no
// unfinished task's latest worker or reviewer run reads there. Anything not under root stays.
export function staleSnapshots(found: string[], root: string, machine: string, tasks: Task[], runs: Run[]): string[] {
  const used = new Set<string>()
  for (const t of tasks) {
    if (cleanupOf(t)) continue
    for (const role of ['worker', 'reviewer'] as const) {
      const r = latest(runs, t.id, role)
      if (r?.machine === machine) for (const f of r.context ?? []) used.add(f.dir)
    }
  }
  return found.filter(d => underRoot(d, root) && !used.has(d))
}
