// How much of a machine a task needs: light, standard or heavy. The user and
// the coordinator see the class; placement uses its estimate.
import { shotStep, typeSteps, type Task } from './run'
import type { Template, Weight } from './workflow'

import { WEIGHTS } from './workflow'
import { shotsMissing } from './shots'
import type { PlannedStep } from './steps'

export { WEIGHTS, isWeight, type Weight } from './workflow'

// Starting estimates (memory in MB, cores) until measured peaks replace them.
// light: docs, a study, a small fix. standard: unit tests and typecheck.
// heavy: a build, e2e or screenshots.
export const WEIGHT_DEFAULTS: Record<Weight, { mb: number, cores: number }> = {
  light: { mb: 700, cores: 0.25 },
  standard: { mb: 1800, cores: 1 },
  heavy: { mb: 4000, cores: 2 },
}

// Where the class came from: the task, its type, or read from its steps.
export type WeightFrom = 'task' | 'type' | 'screenshots' | 'no code' | 'steps'

// First match wins: the task's own weight, its type's, then its steps: a
// worker step with screenshots is heavy, a type that lands no code (no commit,
// link or git action: a study) is light, any other is standard. Never from the title.
export function weightOf(t: Template | null | undefined, task: Pick<Task, 'type' | 'weight'>): { weight: Weight, from: WeightFrom } {
  if (task.weight) return { weight: task.weight, from: 'task' }
  const tt = t?.taskTypes[task.type]
  if (tt?.weight) return { weight: tt.weight, from: 'type' }
  if (!t || !tt) return { weight: 'standard', from: 'steps' }
  if (shotStep(t, task.type)) return { weight: 'heavy', from: 'screenshots' }
  const code = typeSteps(t, task.type).some(s => s.action || s.evidence?.some(e => e === 'commit' || e === 'link'))
  return code ? { weight: 'standard', from: 'steps' } : { weight: 'light', from: 'no code' }
}

// A worker started again in its worktree (a catch-up, red CI, a send-back, the
// step it is woken for) is weighed by what it does, not by its type: only a
// step that still lacks its screenshots takes them (the task's own weight);
// any other merges the base, fixes and runs related tests: standard at most.
export function reviveWeight(task: Weight, step: PlannedStep | undefined, shots: StepShots): Weight {
  if (step && shotsMissing(step, shots?.[step.id]).length) return task
  return task === 'light' ? 'light' : 'standard'
}
type StepShots = NonNullable<Task['step']>['shots']

const FROM_TEXT: Record<WeightFrom, string> = { 'task': 'set on the task', 'type': 'its task type', 'screenshots': 'screenshots', 'no code': 'no code', 'steps': 'its steps' }
// "heavy (screenshots)": what task show and the Add task sheet say.
export const weightText = (w: { weight: Weight, from: WeightFrom }) => `${w.weight} (${FROM_TEXT[w.from]})`

// "light ≈ 0.7 GB, 0.25 core (default) · standard ≈ 1.8 GB, 1 core (default) · heavy ≈ 3.2 GB, 2 cores (from 5 runs)":
// what placement counts per weight, learned from measured peaks (peaks.ts) once there are enough.
export const weightsLine = (est: Record<Weight, { mb: number, cores: number, runs?: number }> = WEIGHT_DEFAULTS) => WEIGHTS.map((w) => {
  const e = est[w]
  return `${w} ≈ ${(e.mb / 1024).toFixed(1)} GB, ${e.cores} ${e.cores > 1 ? 'cores' : 'core'} (${e.runs ? `from ${e.runs} runs` : 'default'})`
}).join(' · ')
