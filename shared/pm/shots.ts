// Screenshots as a step's evidence: the agent uploads its images to wherdr
// (POST /api/pm/shot), each one for the task's current step, before or after
// the change. A step whose evidence has screenshots does not end without them.
import type { ShotMode, Step } from './workflow'
import type { PlannedStep, StepState } from './steps'

export type ShotPhase = 'before' | 'after'
// rework: the commit the review passed, for a shot taken after new commits since.
// commit: the task's head when a shot of the result was uploaded (unknown when it could not be read).
// replaced: the file of the shot it redoes (kept in earlierShots).
export interface Shot { file: string, phase: ShotPhase, at: number, rework?: string, commit?: string, replaced?: string }

export const SHOT_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }
export const SHOT_FILE_RE = /^[a-f0-9]{12}\.(png|jpg|webp)$/
export const MAX_SHOTS = 24 // per step
export const SHOT_MAX_BYTES = 10 * 1024 * 1024
export const SHOT_TOKEN_HEADER = 'x-wherdr-shot-token'
// Heads the list of screenshots a send-back points at, after the user's own note.
export const POINTED_SHOTS = 'Screenshots the user points at:'

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

// A shot of the result taken before the step's newest commit (shotsHead): still
// shown, marked as from an earlier commit (the worker retakes only what changed).
export const earlierCommit = (s: Shot, head?: string) => s.phase === 'after' && !!s.commit && !!head && s.commit !== head

// What changed since the user's last look (their last send-back): its note, and
// each shot uploaded since, beside the version it redoes when it redoes one.
export function sinceLastLook(state: StepState | undefined, step: string): { note: string, pairs: { before?: Shot, after: Shot }[] } | undefined {
  const back = state?.lastBack
  if (!back) return
  const earlier = state.earlierShots?.[step] ?? []
  const pairs = (state.shots?.[step] ?? []).filter(s => s.at > back.at).map((s) => {
    const before = s.replaced ? earlier.find(e => e.file === s.replaced) : undefined
    return { ...(before ? { before } : {}), after: s }
  })
  return { note: back.note, pairs }
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
// step before it take new ones. replaces: the file of the shot this one redoes,
// which takes its place (the old one goes to the earlier ones); the others stay
// shown. Without it, the shot joins the set. It drops the user's approval of
// the merge: they approved the screens they saw, not this one.
export function addShot(plan: PlannedStep[], state: StepState | undefined, shot: Shot, since?: string, replaces?: string): { state: StepState } | { refused: string } {
  const open = state?.started && !state.done ? plan[state.at] : undefined
  if (!state || !open) return { refused: 'The task has no open step' }
  const rework = since && !needsShots(open) ? plan.slice(0, state.at).findLast(s => s.holder === 'worker' && needsShots(s)) : undefined
  const step = rework ?? open
  if (!needsShots(step)) return { refused: `Step "${step.id}" asks for no screenshots` }
  if (shot.phase === 'before' && shotMode(step) === 'after') return { refused: `Step "${step.id}" asks for screenshots of the result only` }
  if (rework) shot = { ...shot, rework: since }
  let list = state.shots?.[step.id] ?? [], earlier = state.earlierShots
  if (replaces) {
    const old = list.find(s => s.file === replaces)
    if (!old || old.phase !== shot.phase) return { refused: `Step "${step.id}" has no ${shot.phase} screenshot ${replaces} to replace` }
    shot = { ...shot, replaced: old.file }
    list = list.map(s => (s === old ? shot : s))
    earlier = { ...earlier, [step.id]: [...(earlier?.[step.id] ?? []), old].slice(-MAX_SHOTS * 2) }
  }
  else if (list.length >= MAX_SHOTS) return { refused: `Step "${step.id}" has ${MAX_SHOTS} screenshots already` }
  else list = [...list, shot]
  const shotsHead = shot.commit ? { shotsHead: { ...state.shotsHead, [step.id]: shot.commit } } : {}
  return { state: { ...state, shots: { ...state.shots, [step.id]: list }, ...(earlier ? { earlierShots: earlier } : {}), ...shotsHead, approved: undefined, ...(state.approved ? { lookAgain: { why: 'new screenshots since your approval', at: shot.at } } : {}) } }
}
