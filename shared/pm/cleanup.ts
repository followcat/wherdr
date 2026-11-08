// Removing a finished task's worktree. Merged and done: its worktree and its
// local branch go. Archived: its worktree goes, its branch stays. Pure: which
// worktree may go and why not; server/utils/pmCleanup.ts runs git.
import type { Run, Task } from './run'

export type Cleanup = 'worktree+branch' | 'worktree'

// What a task's end allows: nothing while it is not done.
export const cleanupOf = (task: Task): Cleanup | undefined =>
  !task.step?.done ? undefined : task.step.abandoned ? 'worktree' : 'worktree+branch'

// dir is root itself or deeper, with no '..' or '.' segment to climb out.
export function underRoot(dir: string, root: string) {
  const r = root.replace(/\/+$/, '')
  if (!r.startsWith('/') || !dir.startsWith(`${r}/`)) return false
  return dir.slice(r.length + 1).split('/').every(s => s !== '' && s !== '.' && s !== '..')
}

// Why the task's worktree may not be looked at, before any git: a task not
// done, an agent still running on it, a folder outside the pm worktrees.
export function cleanupRefusal(task: Task, runs: Run[], dir: string, root: string): string | undefined {
  if (!cleanupOf(task)) return `${task.id} is not done or archived`
  if (runs.some(r => r.task === task.id && r.state !== 'ended')) return 'an agent still runs on it'
  if (!underRoot(dir, root)) return 'its worktree is not under the pm worktrees folder'
}

// What the probe found in the worktree. listed: git knows it as a worktree of
// the project. dirty: changed or untracked files. unique: commits on its HEAD
// or branch that no remote branch and no other local branch has.
export interface Facts { exists: boolean, listed: boolean, dirty: number, unique: number }

// Why the worktree stays (or, already gone, its branch), or undefined: it may go.
export function factsRefusal(f: Facts): string | undefined {
  if (f.exists && !f.listed) return 'the folder is not a worktree of the project'
  if (f.exists && f.dirty) return `${f.dirty} uncommitted change${f.dirty > 1 ? 's' : ''}`
  if (f.unique) return `${f.unique} commit${f.unique > 1 ? 's' : ''} neither pushed nor merged`
}

// The probe's output: one line, `exists listed dirty unique` as 0/1 and counts.
export function parseFacts(out: string): Facts | undefined {
  const n = out.trim().split('\n').pop()?.trim().split(/\s+/).map(Number) ?? []
  if (n.length !== 4 || n.some(x => !Number.isInteger(x) || x < 0)) return undefined
  return { exists: n[0] === 1, listed: n[1] === 1, dirty: n[2]!, unique: n[3]! }
}
