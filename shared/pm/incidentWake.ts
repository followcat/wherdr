// The Incident wake (WHR-187): once the engine's resumes after an incident
// settle, the coordinators get one wake with its facts: the cause and its
// evidence, what was resumed, what still waits and why, what needs someone.
// Pure: server/utils/pmRecovery.ts sends it, once per incident.
import { afterIds } from './advance'
import { CAUSE_TEXT, escalated, recovering, type Incident } from './incident'
import type { Task, WaitKind } from './run'

// The rule every coordinator and Alfred follow before explaining a stop.
export const CAUSE_RULE = 'Never state a cause you did not read. Before you explain why a task stopped or agents are gone, run `wherdr pm incidents`, `wherdr pm autopilot show` and `wherdr pm read <task>`; if those facts do not decide, say the cause is unknown and what you checked.'

// The same incident is told within this time of being recorded, or never (an old one, before an update).
export const TELL_WITHIN_MS = 60 * 60_000

const WAIT_TEXT: Record<WaitKind, string> = { question: 'a question for the user', permission: 'a permission request', auth: 'a sign-in' }
const iso = (t: number) => new Date(t).toISOString()
const list = (xs: string[]) => xs.join('; ')

// Why a task of the incident still waits for the engine.
function waitWhy(t: Task, i: Incident, tasks: Task[]): string {
  const before = afterIds(t).filter(id => tasks.some(x => x.id === id && recovering(x)))
  if (before.length) return `waits for ${before.join(', ')} to resume first`
  if (t.held) return t.held
  if (t.recovery!.cause === 'offline') return `${t.recovery!.label} still offline`
  if (t.recovery!.cause === 'limit') {
    const until = i.evidence.find(e => e.startsWith(`${t.id} `))?.match(/resets at (\S+)/)?.[1]
    return `the account's limit${until ? ` until ${until}` : ', until its reading says it reset'}`
  }
  return 'its turn to resume'
}

// The wake's lines for one coordinator: its project's tasks, or every one (project undefined: Alfred).
export function incidentReasons(i: Incident, tasks: Task[], project?: string): string[] {
  const mine = i.tasks.map(id => tasks.find(t => t.id === id)).filter((t): t is Task => !!t && (!project || t.project === project))
  const resumed: string[] = [], waits: string[] = [], you: string[] = [], user: string[] = [], done: string[] = []
  for (const t of mine) {
    if (t.step?.done) done.push(t.id)
    else if (recovering(t) && t.recovery!.incident === i.id) waits.push(`${t.id} (${waitWhy(t, i, tasks)})`)
    else if (escalated(t)) you.push(`${t.id} (stopped again right after the engine resumed it: start it again once the cause is fixed, or tell the user)`)
    else if (t.state === 'waiting' && t.waitKind) user.push(`${t.id} (${WAIT_TEXT[t.waitKind]})`)
    else if (t.step?.yourTurn) user.push(`${t.id} (${t.step.yourTurn.badge})`)
    else if (t.state === 'waiting') user.push(`${t.id} (${t.waiting ?? 'waits'})`)
    else if (t.run && !i.runs.includes(t.run)) resumed.push(t.id)
    else waits.push(`${t.id} (${t.waiting ?? t.state})`)
  }
  return [
    `Incident ${i.id} on ${i.label} at ${iso(i.at)}: ${CAUSE_TEXT[i.cause]}. Evidence (read by the engine): ${list(i.evidence.slice(0, 6))}${i.evidence.length > 6 ? `; and ${i.evidence.length - 6} more (wherdr pm incidents)` : ''}.`,
    `Resumed: ${resumed.length ? resumed.join(', ') : 'none'}.`,
    ...(waits.length ? [`Still waits (the engine resumes it by itself): ${list(waits)}.`] : []),
    ...(you.length ? [`Needs you: ${list(you)}.`] : []),
    ...(user.length ? [`Needs the user: ${list(user)}.`] : []),
    ...(done.length ? [`Done meanwhile: ${done.join(', ')}.`] : []),
    `Tell the user this cause, as the engine found it, never another: ${CAUSE_RULE}`,
  ]
}

// Incidents to tell now: not told yet, recent, and no resume of theirs still under way (busy: in this tick).
export const toTell = (incidents: Incident[], busy: Set<string>, now: number) =>
  incidents.filter(i => !i.told && !busy.has(i.id) && now - i.at < TELL_WITHIN_MS)
