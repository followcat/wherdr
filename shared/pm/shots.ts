// Screenshots as a step's evidence: the agent uploads its images to wherdr
// (POST /api/pm/shot), each one for the task's current step, before or after
// the change. A step whose evidence has screenshots does not end without them.
import type { ShotMode, Step } from './workflow'
import type { PlannedStep, StepState } from './steps'

export type ShotPhase = 'before' | 'after'
// rework: the commit the review passed, for a shot taken after new commits since.
export interface Shot { file: string, phase: ShotPhase, at: number, rework?: string }

export const SHOT_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
export const SHOT_FILE_RE = /^[a-f0-9]{12}\.(png|jpg|webp)$/
export const MAX_SHOTS = 24 // per step
export const SHOT_MAX_BYTES = 10 * 1024 * 1024
export const SHOT_TOKEN_HEADER = 'x-wherdr-shot-token'

// The body is an image of the declared type (its first bytes), not any bytes.
export function isImage(data: Uint8Array, ext: string) {
  const at = (i: number, bytes: number[]) => bytes.every((b, k) => data[i + k] === b)
  const ascii = (t: string) => [...t].map(c => c.charCodeAt(0))
  if (ext === 'png') return at(0, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  if (ext === 'jpg') return at(0, [0xFF, 0xD8, 0xFF])
  if (ext === 'webp') return at(0, ascii('RIFF')) && at(8, ascii('WEBP'))
  return false
}

export const shotMode = (s: Pick<Step, 'screenshots'>): ShotMode => s.screenshots ?? 'after'
export const needsShots = (s: Pick<Step, 'evidence'>) => !!s.evidence?.includes('screenshots')
export const shotUrl = (task: string, file: string) => `/api/pm/shot?task=${encodeURIComponent(task)}&file=${encodeURIComponent(file)}`

// The phases a step still lacks a screenshot of.
export function shotsMissing(step: Pick<Step, 'evidence' | 'screenshots'>, shots: Shot[] = []): ShotPhase[] {
  if (!needsShots(step)) return []
  const need: ShotPhase[] = shotMode(step) === 'before-after' ? ['before', 'after'] : ['after']
  return need.filter(p => !shots.some(s => s.phase === p))
}

// What the holder is told to give, or what is still missing.
export const shotsText = (phases: ShotPhase[]) =>
  phases.length === 2 ? 'screenshots before and after the change' : `screenshots ${phases[0] === 'before' ? 'before' : 'of the result'}`

// The gallery's rows: before and after paired in upload order, or the after shots alone.
export function shotRows(shots: Shot[], mode: ShotMode): { before?: Shot, after?: Shot }[] {
  const after = shots.filter(s => s.phase === 'after')
  if (mode === 'after') return after.map(a => ({ after: a }))
  const before = shots.filter(s => s.phase === 'before')
  return Array.from({ length: Math.max(before.length, after.length) }, (_, i) => ({
    ...(before[i] ? { before: before[i] } : {}), ...(after[i] ? { after: after[i] } : {}),
  }))
}

// A new screenshot for the task's current step: refused unless that step,
// open and held by an agent, asks for one of this phase. since: the commit the
// review passed, when the task's head moved after it (reworkSince): a step that
// takes no screenshots (the merge, the re-review) lets the worker's screenshot
// step before it take the new set, which replaces the shown one. It drops the
// user's approval of the merge: they approved the screens they saw, not this one.
export function addShot(plan: PlannedStep[], state: StepState | undefined, shot: Shot, since?: string): { state: StepState } | { refused: string } {
  const open = state?.started && !state.done ? plan[state.at] : undefined
  if (!state || !open) return { refused: 'The task has no open step' }
  const rework = since && !needsShots(open) ? plan.slice(0, state.at).findLast(s => s.holder === 'worker' && needsShots(s)) : undefined
  const step = rework ?? open
  if (!needsShots(step)) return { refused: `Step "${step.id}" asks for no screenshots` }
  if (shot.phase === 'before' && shotMode(step) === 'after') return { refused: `Step "${step.id}" asks for screenshots of the result only` }
  let list = state.shots?.[step.id] ?? [], earlier = state.earlierShots
  if (rework) {
    shot = { ...shot, rework: since }
    // The first shot of this rework: the shown set goes to the earlier ones.
    if (list.some(s => s.rework !== since)) {
      earlier = { ...earlier, [step.id]: [...(earlier?.[step.id] ?? []), ...list].slice(-MAX_SHOTS * 2) }
      list = []
    }
  }
  if (list.length >= MAX_SHOTS) return { refused: `Step "${step.id}" has ${MAX_SHOTS} screenshots already` }
  return { state: { ...state, shots: { ...state.shots, [step.id]: [...list, shot] }, ...(earlier ? { earlierShots: earlier } : {}), approved: undefined } }
}
