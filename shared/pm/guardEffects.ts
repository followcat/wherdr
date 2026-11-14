// What a project's guards do, for the Guards tab: what each task type adds to
// them, and who merges at each step that merges (combineGuards + planSteps).
// Pure: the tab passes the guards being edited, so the lines follow at once.
import { combineGuards } from './guards'
import { planSteps, type PlannedStep } from './steps'
import type { Task } from './run'
import type { Guards, MergeBy, Template } from './workflow'

// A task type that hardens the project's guards.
export interface TypeEffect { type: string, protects: string[], merge: Partial<Record<'protected' | 'others', MergeBy>> }
// A step that merges into a branch, and who does it.
export interface StepEffect { type: string, step: string, into: string, by: MergeBy }

export function guardEffects(t: Template, guards: Guards, base?: string): { types: TypeEffect[], steps: StepEffect[] } {
  const draft: Template = { ...t, guards }
  const project = combineGuards([{ source: 'project', guards }])
  const types: TypeEffect[] = []
  const steps: StepEffect[] = []
  for (const [type, tt] of Object.entries(t.taskTypes)) {
    const g = combineGuards([{ source: 'project', guards }, { source: 'task-type', guards: tt.guards }])
    const merge: TypeEffect['merge'] = {}
    for (const k of ['protected', 'others'] as const)
      if (g.merge[k].source === 'task-type' && g.merge[k].value !== project.merge[k].value) merge[k] = g.merge[k].value
    const protects = g.protected.filter(p => p.source === 'task-type').map(p => p.value)
    if (protects.length || Object.keys(merge).length) types.push({ type, protects, merge })

    let prBase: string | undefined
    for (const s of planSteps(draft, { type }, base)) {
      const a = s.action
      if (a?.kind === 'github.pr') prBase = a.base
      const into = a?.kind === 'git.land' ? a.target : a?.kind === 'github.merge' ? prBase : undefined
      if (into) steps.push({ type, step: s.id, into, by: s.guarded ? 'user' : 'engine' })
    }
  }
  return { types, steps }
}

// The branch a planned step merges into (a landing's target, a PR merge's base), or undefined.
const mergeInto = (plan: PlannedStep[], i: number) => {
  const a = plan[i]?.action
  return a?.kind === 'git.land' ? a.target : a?.kind === 'github.merge' ? plan.slice(0, i).findLast(s => s.action?.kind === 'github.pr')?.action?.base : undefined
}

// A task waiting at a merge its guard refused, that the new guards give the
// engine: the branch it may now merge into, or undefined. before/after: the
// task's plan under the old and the new guards.
export function freedMerge(task: Pick<Task, 'state' | 'stopped' | 'step'>, before: PlannedStep[], after: PlannedStep[]): string | undefined {
  const s = task.step
  if (task.state !== 'working' || task.stopped || !s?.started || s.done || s.acting || s.yourTurn?.reason !== 'action') return
  const was = before[s.at], now = after[s.at]
  return was?.guarded && now && !now.guarded && now.ends === 'action' && now.id === was.id ? mergeInto(after, s.at) : undefined
}
