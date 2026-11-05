// Guards: the rules the user sets on branches. They come from several levels
// and the strictest wins, so a task type or a task can only make them stricter.
import { MERGE_BY, type Guards, type MergeBy } from './workflow'

// Broadest first. The user's own settings and the project set guards; a task
// type and a task may add to them.
export const GUARD_LEVELS = ['user', 'project', 'task-type', 'task'] as const
export type GuardSource = typeof GUARD_LEVELS[number] | 'builtin'

export interface Sourced<T> { value: T, source: GuardSource }
export interface ResolvedGuards {
  protected: Sourced<string>[]
  merge: { protected: Sourced<MergeBy>, others: Sourced<MergeBy> }
}

// Used only where no level says anything.
export const DEFAULT_MERGE: Record<'protected' | 'others', MergeBy> = { protected: 'user', others: 'engine' }

const strictness = (m: MergeBy) => MERGE_BY.indexOf(m)

export function combineGuards(levels: { source: typeof GUARD_LEVELS[number], guards?: Guards }[]): ResolvedGuards {
  const ordered = [...levels].sort((a, b) => GUARD_LEVELS.indexOf(a.source) - GUARD_LEVELS.indexOf(b.source))
  const out: ResolvedGuards = {
    protected: [],
    merge: {
      protected: { value: DEFAULT_MERGE.protected, source: 'builtin' },
      others: { value: DEFAULT_MERGE.others, source: 'builtin' },
    },
  }
  const set = { protected: false, others: false }
  for (const { source, guards } of ordered) {
    for (const branch of guards?.protected ?? [])
      if (!out.protected.some(p => p.value === branch)) out.protected.push({ value: branch, source })
    for (const k of ['protected', 'others'] as const) {
      const v = guards?.merge?.[k]
      if (!v) continue
      // The user or the project may replace the default; past that, and for a
      // task type or a task always, a level only hardens.
      const chooses = !set[k] && (source === 'user' || source === 'project')
      if (chooses || strictness(v) > strictness(out.merge[k].value)) out.merge[k] = { value: v, source }
      if (chooses) set[k] = true
    }
  }
  return out
}

export const isProtected = (g: ResolvedGuards, branch: string) => g.protected.some(p => p.value === branch)

// May `by` merge into `branch`? The user always may; the engine only where
// the guard says engine.
export function mayMerge(g: ResolvedGuards, branch: string, by: MergeBy): boolean {
  const rule = isProtected(g, branch) ? g.merge.protected : g.merge.others
  return by === 'user' || rule.value === 'engine'
}
