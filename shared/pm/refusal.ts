// A failed step action ("Merge: merge: 2 check(s) failed", see steps.ts) said
// for people, on the card and in the task sheet: what went wrong and what
// happens next, never a command. The raw error stays in the step state: it is
// for the engine, and the commands go to the agent in what the engine sends it.
import type { TaskLogEntry } from './run'
import type { StepState } from './steps'

// The engine's catch-up asked the agent to bring its PR up to date
// (server/utils/pmMechanic.ts) since the step began: 'updating' while the
// engine still reads the PR in conflict or behind (prNow, every minute),
// 'updated' once it does not, and the user is asked to press again.
export type Told = 'updating' | 'updated'
export interface ToldOf { log?: TaskLogEntry[], state?: { since?: number }, prNow?: string }
export function agentCatchingUp(c: ToldOf): Told | undefined {
  const sent = c.log?.some(e => e.by === 'engine' && e.at >= (c.state?.since ?? 0) && /^catch-up: (sent to the agent|started the worker again)/.test(e.text))
  if (sent) return /^(conflict|behind)/.test(c.prNow ?? '') ? 'updating' : 'updated'
}

// short: the card's status line. long: the sheet, with what to do next.
// told: where the agent's catch-up stands; waits: nothing for the user to do yet.
export interface Said { short: string, long: string, waits?: true }
const KNOWN: [RegExp, (m: RegExpMatchArray, told?: Told) => Said][] = [
  [/the PR head is not the task's commit/, () => ({
    short: 'The PR is not at the task\'s latest commit',
    long: 'The PR on GitHub is not at the task\'s latest commit: its branch moved (often the agent fixing a conflict or a check). Press again once the PR has the new commits.',
  })],
  [/(\d+) check\(s\) failed/, m => ({ short: 'checks failed', long: `${m[1]} check(s) failed on the PR: the agent is asked to fix them. Press again once they are green.` })],
  [/checks still running|waiting for check/, () => ({ short: 'checks still running', long: 'The PR\'s checks have not finished. Press again once they are green.' })],
  // "the PR conflicts with v3" (pmActions.ts), "conflict with v3 in a.ts" (the catch-up), GitHub's own words.
  [/conflicts? with (?!its )([\w./-]+)|conflict|not mergeable|cannot be cleanly created/i, (m, told) => {
    const base = m[1] ?? 'its target branch', short = `The PR conflicts with ${base}`
    if (told === 'updating') return { short: `${short}: the agent is updating it`, long: `${short}: the agent is updating it. Press again once it is done.`, waits: true }
    if (told === 'updated') return { short: `The agent brought the PR up to date with ${base}`, long: `The agent brought the PR up to date with ${base}: press again to merge.` }
    return { short, long: `${short}: the engine brings it up to date, or asks the agent to. Press again once it is.` }
  }],
  [/base branch policy prohibits the merge|review is required|required status check/i, () => ({
    short: 'GitHub\'s branch rules refuse the merge',
    long: 'GitHub\'s rules for the target branch refuse the merge for now (a review or a check they require). Press again once they allow it.',
  })],
  [/no open PR for this task/, () => ({ short: 'no open PR', long: 'This task has no open PR to merge: the PR step has to open one first.' })],
]
// A shell command in an unknown error (GitHub's "Run the following…" hint): never shown.
const COMMAND = /&&|\b(gh|git) [a-z-]+ /

export function refusalSaid(text: string, told?: Told): Said {
  for (const [re, say] of KNOWN) {
    const m = text.match(re)
    if (m) return say(m, told)
  }
  if (COMMAND.test(text)) {
    const what = /\bmerge: /.test(text) ? 'GitHub refused the merge' : 'The step\'s action failed'
    return { short: what, long: `${what}. Press again, or ask the coordinator to look at the task.` }
  }
  // An engine reason already in words: on the card without its "merge: " prefix.
  return { short: text.replace(/^[\w-]+: /, ''), long: text }
}

// Who can end a failed action, read from its error. code: the branch or PR needs
// work its worker does (a conflict, red checks, a refused push, new commits to
// review). outside: nothing in the code is wrong (herdr-core or a machine refused
// the call, the network, a timeout, the Git host's 5xx or rate limit, a machine
// offline): Try again only. unknown: Try again first, the agent second.
export type ActionFix = 'code' | 'outside' | 'unknown'
const CODE_FIX = /conflicts? with|is behind|not mergeable|cannot be cleanly created|check\(s\) failed|refused|rejected\]|fast-forward|\(fetch first\)|since the review|head is not the task's commit|commits the task's worktree never had/i
const OUTSIDE_FIX = /herdr-core|unreachable|offline|machine_unknown|timed out|did not respond|interrupted|(?:HTTP|status|error)[ :]*5\d\d\b|bad gateway|service unavailable|could not resolve host|connection (reset|refused|timed out|closed)|remote end hung up|RPC failed|early EOF|rate limit|unreadable PR details/i
export function actionFix(error: string | undefined): ActionFix {
  if (!error) return 'unknown'
  if (OUTSIDE_FIX.test(error)) return 'outside'
  return CODE_FIX.test(error) ? 'code' : 'unknown'
}

// A thrown error as an action's reason: herdr-core's stable kind and hint kept
// beside its message ("herdr-core rejected the request (unavailable: …)"), so the
// card says a cause, and actionFix reads it as outside the code.
export function thrownReason(e: unknown): string {
  const { message, kind, hint } = (e ?? {}) as { message?: string, kind?: unknown, hint?: unknown }
  const text = message || 'the action failed'
  const why = [typeof kind === 'string' && kind !== 'rpc' ? kind : '', typeof hint === 'string' ? hint : ''].filter(Boolean).join(': ')
  return why && !text.includes(why) ? `${text} (${why})` : text
}

// The card's call to the user, in words (the board, its Your turn lane, the
// decisions): a refused action says what went wrong, and there is none while
// the agent fixes it (back once the PR is clean).
export function turnText(c: ToldOf & { yourTurn?: string, state?: StepState }): string | undefined {
  const y = c.state?.yourTurn
  if (!c.yourTurn || y?.reason !== 'action' || !y.error || !y.badge.endsWith(`: ${y.error}`)) return c.yourTurn
  const said = refusalSaid(y.error, agentCatchingUp(c))
  return said.waits ? undefined : `${y.badge.slice(0, -(y.error.length + 2))}: ${said.short}`
}
