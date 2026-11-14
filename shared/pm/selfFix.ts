// Blocks the engine fixes on its own, without waking the coordinator: a PR in
// conflict with or behind its base (an update, the conflict handed to the
// worker), a push refused because the branch is behind its remote (synced,
// then pushed again), an action interrupted by a restart (run again), a
// stalled agent (nudged, then restarted). Each try is counted per task, step
// and block; after SELF_FIX_TRIES the coordinator is woken once, with what
// was tried. Pure: server/utils/pmMechanic.ts and pmStall.ts make the tries.
import type { Task } from './run'

export type Block = 'conflict' | 'push' | 'interrupted' | 'stall'
export const SELF_FIX_TRIES = 2
// After the last try, before the coordinator is woken: the try's result lands
// (a restarted agent gets the time a nudged one had).
export const SELF_FIX_GRACE_MS = 2 * 60_000
const STALL_GRACE_MS = 10 * 60_000
// A block the engine had nothing more to try on for this long: the coordinator's too.
export const SELF_FIX_IDLE_MS = 15 * 60_000

const BLOCK_TEXT: Record<Block, string> = {
  conflict: 'its PR conflicts with or is behind its base',
  push: 'a push was refused: the branch is behind its remote',
  interrupted: 'an action was interrupted before its result was known',
  stall: 'its agent is stalled',
}
// The engine's move that is a try on each block (pmMechanic.ts); the stall's are pmStall.ts's.
export const FIX_MOVE: Partial<Record<Block, string>> = { conflict: 'catch-up', push: 'sync-push', interrupted: 'retry-action' }

// The block the engine fixes that the task is in now, if any.
export function blockOf(t: Pick<Task, 'step' | 'stall' | 'stopped' | 'state'>): Block | undefined {
  const s = t.step
  if (!s?.started || s.done || t.stopped || t.state !== 'working') return
  const err = s.yourTurn?.reason === 'action' ? s.yourTurn.error ?? s.yourTurn.badge : ''
  if (/was interrupted before its result was known/.test(err)) return 'interrupted'
  if (/fast-forward|\(fetch first\)/i.test(err)) return 'push'
  if (/conflicts with|is behind/i.test(err)) return 'conflict'
  if (t.stall) return 'stall'
}

const stepKey = (t: Pick<Task, 'step'>) => `${t.step?.at ?? 0}:${t.step?.since ?? 0}`
// The record of this block in the task's current step, if any.
export const fixOf = (t: Pick<Task, 'step' | 'selfFix'>, b: Block) =>
  t.selfFix?.step === stepKey(t) && t.selfFix.block === b ? t.selfFix : undefined

// The block seen (what: undefined) or one more try made: the task's record.
export const noteFix = (t: Pick<Task, 'step' | 'selfFix'>, b: Block, now: number, what?: string): NonNullable<Task['selfFix']> => {
  const f = fixOf(t, b)
  return { step: stepKey(t), block: b, tried: [...(f?.tried ?? []), ...(what ? [what] : [])], at: what || !f ? now : f.at }
}
export const mayTry = (t: Pick<Task, 'step' | 'selfFix'>, b: Block) => (fixOf(t, b)?.tried.length ?? 0) < SELF_FIX_TRIES

// The engine still owns the task's block: no 'stuck' wake for it (autopilot.ts).
export const engineOwns = (t: Task) => { const b = blockOf(t); return !!b && !fixOf(t, b)?.woke }

// The coordinator's wake once the engine gives up, with what it tried; undefined: not now.
// Called only when the engine has no move for the task this tick.
export function escalation(t: Task, now: number): string | undefined {
  const b = blockOf(t), f = b && fixOf(t, b)
  if (!b || !f || f.woke) return
  const grace = f.tried.length < SELF_FIX_TRIES ? SELF_FIX_IDLE_MS : b === 'stall' ? STALL_GRACE_MS : SELF_FIX_GRACE_MS
  if (now - f.at < grace) return
  const tried = f.tried.length ? `the engine tried ${f.tried.join('; ')}, without success` : 'the engine had nothing to try on it'
  return `${t.id} (${t.title}): stuck: ${BLOCK_TEXT[b]}; ${tried}.`
}
