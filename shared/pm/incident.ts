// Why agents are gone (WHR-185): the engine decides the cause from facts it
// read (herdr-core's machines and terminals, the account's limit data), never
// a guess, and records it as an incident per machine. No fact that decides:
// 'unknown', said as such.
import type { Run, Task } from './run'
import type { Quota } from '../types'
import { limitState } from '../quotaLimit'

export type Cause = 'offline' | 'restart' | 'killed' | 'out-of-memory' | 'limit' | 'unknown'

// A terminal as herdr-core gives it (terminal.list), and the last lines it printed when read.
export interface TerminalFacts { state?: string, exit_code?: number | null, signal?: number | null, reason?: string | null, finished_ms?: number | null, lastLines?: string }
// A machine as herdr-core sees it: state from terminal.list's machines (the
// local one is always 'connected'), coreStartedAt only when known (the local core).
// live: wherdr's agents still running there (terminal.list), when known.
export interface MachineFacts { key: string, label: string, state: string, since?: number | null, why?: string | null, coreStartedAt?: number, live?: number }
// An unended run whose agent is not running: terminal undefined = not found.
export interface GoneAgent { run: Pick<Run, 'id' | 'task' | 'role' | 'program' | 'machine' | 'startedAt'>, terminal?: TerminalFacts }
// The account's limit data at a time: what it says when the account was at its limit, else null.
export type LimitAt = (program: string, machine: string, at: number) => string | null

export interface Incident {
  id: string
  at: number
  machine: string // machine key, '' = the wherdr host
  label: string
  cause: Cause
  evidence: string[] // the facts it used
  tasks: string[]
  runs: string[]
  told?: number // its Incident wake queued (incidentWake.ts)
}

// A task whose agent an incident took (recovery.ts): waits (the engine resumes
// it once the cause is gone) while `run` is still its run; n: times in a row
// for this cause; resumedAt: the engine's last resume.
export interface Recovery { incident: string, cause: Cause, machine: string, label: string, run?: string, at: number, n: number, waits?: true, resumedAt?: number }
// Waiting for the engine to resume it, not for the user.
export const recovering = (t: Pick<Task, 'state' | 'run' | 'recovery' | 'stopped' | 'waitKind'>) =>
  t.state === 'waiting' && !t.waitKind && !t.stopped && !!t.recovery?.waits && t.recovery.run === t.run

// Stopped again right after the engine resumed it: the engine wakes the coordinator itself, once.
export const escalated = (t: Pick<Task, 'state' | 'run' | 'recovery'>) =>
  t.state === 'waiting' && !!t.recovery && !t.recovery.waits && t.recovery.n > 1 && t.recovery.run === t.run

export const CAUSE_TEXT: Record<Cause, string> = {
  'offline': 'the machine is offline or unreachable (its herdr-core does not answer)',
  'restart': 'herdr-core or wherdr restarted (or the machine rebooted)',
  'killed': 'the agent was killed or crashed',
  'out-of-memory': 'the agent was killed: out of memory',
  'limit': 'the account reached its limit',
  'unknown': 'unknown: the facts read do not decide',
}

// herdr-core's reasons that mean its own stop, a restart or the host shutting down.
const RESTART_REASONS = ['stopped_by_restart', 'server_stop', 'host_shutdown', 'holder_lost']
const OOM_RE = /out of memory|heap out of memory|oom[- ]?kill|cannot allocate memory/i
const iso = (t: number) => new Date(t).toISOString()

function one(g: GoneAgent, m: MachineFacts, allGone: boolean, limitAt: LimitAt): { cause: Cause, fact: string } {
  const t = g.terminal, who = `${g.run.task} ${g.run.role}`
  if (!t) {
    if (m.coreStartedAt && m.coreStartedAt > g.run.startedAt)
      return { cause: 'restart', fact: `${who}: terminal not found; herdr-core on ${m.label} started at ${iso(m.coreStartedAt)}, after the agent (${iso(g.run.startedAt)})` }
    if (allGone) return { cause: 'restart', fact: `${who}: terminal not found, like every other agent's on ${m.label} (none of wherdr's agents runs there now)` }
    return { cause: 'unknown', fact: `${who}: terminal not found${m.coreStartedAt ? `, herdr-core on ${m.label} running since before the agent started` : ''}` }
  }
  const end = t.finished_ms ?? Date.now()
  if (t.reason && RESTART_REASONS.includes(t.reason)) return { cause: 'restart', fact: `${who}: herdr-core ended its terminal (${t.reason}) at ${iso(end)}` }
  const limit = limitAt(g.run.program, g.run.machine, end)
  if (limit) return { cause: 'limit', fact: `${who}: ended at ${iso(end)}; ${limit}` }
  const how = t.signal != null ? `signal ${t.signal}` : t.exit_code != null ? `exit code ${t.exit_code}` : t.reason ? `reason ${t.reason}` : ''
  if (t.lastLines && OOM_RE.test(t.lastLines)) return { cause: 'out-of-memory', fact: `${who}: ended (${how || 'no code'}) at ${iso(end)}, its last output says out of memory` }
  if (t.signal != null || (t.exit_code != null && t.exit_code !== 0) || t.reason === 'killed' || t.reason === 'signaled')
    return { cause: 'killed', fact: `${who}: ended with ${how} at ${iso(end)}` }
  return { cause: 'unknown', fact: `${who}: ended${how ? ` with ${how}` : ''} at ${iso(end)}, nothing says why` }
}

// The incidents of these gone agents: one per machine and cause.
export function diagnose(gone: GoneAgent[], machines: MachineFacts[], limitAt: LimitAt, now: number): Omit<Incident, 'id'>[] {
  const out: Omit<Incident, 'id'>[] = []
  for (const key of [...new Set(gone.map(g => g.run.machine))]) {
    const mine = gone.filter(g => g.run.machine === key)
    const m = machines.find(x => x.key === key) ?? { key, label: key || 'this machine', state: 'unknown' }
    const add = (cause: Cause, list: GoneAgent[], evidence: string[]) =>
      out.push({ at: now, machine: key, label: m.label, cause, evidence, tasks: [...new Set(list.map(g => g.run.task))], runs: list.map(g => g.run.id) })
    if (m.state !== 'connected') {
      add('offline', mine, [`herdr-core on ${m.label} does not answer: ${m.state}${m.since ? ` since ${iso(m.since)}` : ''}${m.why ? ` (${m.why})` : ''}`])
      continue
    }
    // Every agent's terminal of the machine gone at once: none missing found, and none still running there.
    const allGone = mine.length > 1 && mine.every(g => !g.terminal) && m.live === 0
    const each = mine.map(g => ({ g, ...one(g, m, allGone, limitAt) }))
    for (const cause of [...new Set(each.map(e => e.cause))]) {
      const these = each.filter(e => e.cause === cause)
      add(cause, these.map(e => e.g), these.map(e => e.fact))
    }
  }
  return out
}

// The limit data of an account's quota reading at a time: limited, or a window at 100 %.
export function limitText(q: { at: number, limited?: { resetsAt: number | null }, credits?: Quota['credits'], five: { used: number, resetsAt: number | null } | null, week: { used: number, resetsAt: number | null } | null } | null, at: number, maxAge = 15 * 60_000): string | null {
  if (!q || Math.abs(q.at - at) > maxAge) return null
  const after = (r: number | null) => r == null || r > at
  const until = (r: number | null) => (r == null ? '' : `, it resets at ${iso(r)}`)
  if (limitState(q, at) === 'reached') return `the account's reading at ${iso(q.at)} says it hit its limit${until(q.limited!.resetsAt)}`
  for (const [w, name] of [[q.five, '5-hour'], [q.week, 'weekly']] as const)
    if (w && w.used >= 100 && after(w.resetsAt)) return `the account's reading at ${iso(q.at)} has its ${name} window at ${Math.round(w.used)} %${until(w.resetsAt)}`
  return null
}

// Open: some task it hit is still on the board, not done, and still on a run the incident took
// (once started again it has a new run: closed for good, whatever it waits for later).
type TaskState = Pick<Task, 'id' | 'state' | 'step' | 'run'>
export const isOpen = (i: Incident, tasks: TaskState[]) =>
  i.tasks.some((id) => { const t = tasks.find(x => x.id === id); return !!t && !t.step?.done && !!t.run && i.runs.includes(t.run) })

// The line a task waits with.
export const incidentLine = (i: Pick<Incident, 'cause' | 'label'>) => `The agent's terminal is gone: ${CAUSE_TEXT[i.cause]} (${i.label})`

// What the coordinator reads.
export const incidentView = (i: Incident, tasks: TaskState[]) =>
  ({ id: i.id, at: iso(i.at), machine: i.label, cause: i.cause, why: CAUSE_TEXT[i.cause], evidence: i.evidence, tasks: i.tasks, agents: i.runs, open: isOpen(i, tasks) })
