// How long a task took: the time in each step, the time it waited for the
// user (apart from the agents' time), review rounds and CI fixes. The store
// adds a mark on each write where the task's step or turn changes (withMark);
// the board computes from those marks. Older tasks have none: their total runs
// from their first agent run.
import type { PlannedStep } from './steps'
import type { Run, Task } from './run'

// From `at` on, the task was in step `step` (its index); you: waiting for the user; done: finished.
export interface Mark { at: number, step: number, you?: true, done?: true }
const MAX_MARKS = 200

export const waitsForUser = (t: Task) => !!t.step?.yourTurn || t.state === 'waiting' || !!t.stopped

// The task as the store writes it: `marks` (the ones on disk) and a new mark if its step or turn changed.
export function withMark(t: Task, marks: Mark[] | undefined, now: number): Task {
  const s = t.step
  const list = marks ?? []
  if (!s?.started) return list.length ? { ...t, marks: list } : t
  const m: Mark = { at: now, step: s.at, ...(s.done ? { done: true as const } : waitsForUser(t) ? { you: true as const } : {}) }
  const last = list.at(-1)
  const same = last && last.step === m.step && !!last.you === !!m.you && !!last.done === !!m.done
  return { ...t, marks: same || last?.done ? list : [...list, m].slice(-MAX_MARKS) }
}

export interface Times {
  steps: { id: string, ms: number }[] // agent and engine time per step, waits for the user apart, in plan order
  waited: number // ms spent waiting for the user
  start?: number // its first agent run, or its first mark
  total?: number // start to done, once done
  rounds: number // review rounds: each pass through a verdict step
  ciFixes: number // red CI sent back to the agent
}

export function timesOf(task: Task, plan: PlannedStep[], runs: Run[], now: number): Times {
  const s = task.step
  const marks = task.marks ?? []
  const end = s?.done ? (marks.find(m => m.done)?.at ?? s.since ?? now) : now
  const per = new Map<number, number>()
  let waited = 0
  marks.forEach((m, i) => {
    if (m.done) return
    const ms = Math.max(0, Math.min(marks[i + 1]?.at ?? end, end) - m.at)
    if (m.you) waited += ms
    else per.set(m.step, (per.get(m.step) ?? 0) + ms)
  })
  const first = Math.min(...runs.filter(r => r.task === task.id).map(r => r.startedAt), marks[0]?.at ?? Infinity)
  const start = Number.isFinite(first) ? first : undefined
  const reached = s?.done ? plan.length : (s?.started ? s.at + 1 : 0)
  return {
    steps: plan.flatMap((p, i) => (per.has(i) ? [{ id: p.id, ms: per.get(i)! }] : [])),
    waited,
    ...(start !== undefined ? { start } : {}),
    ...(s?.done && !s.abandoned && start !== undefined ? { total: Math.max(0, end - start) } : {}),
    rounds: plan.slice(0, reached).reduce((n, p) => n + (p.ends === 'verdict' ? (s?.rounds[p.id] ?? 0) + 1 : 0), 0),
    ciFixes: Object.keys(task.mech ?? {}).filter(k => k.startsWith('red:')).length,
  }
}

// '<1 min', '12 min', '1 h 5 min', '2 d 3 h'.
export function spent(ms: number): string {
  const m = Math.floor(ms / 60_000)
  if (m < 1) return '<1 min'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`
}

// The card's time: '12 min in review' while it works, '42 min' once done.
export function cardTime(c: { phase: string, step?: string, state?: { since?: number }, times?: Times }, now: number): string | undefined {
  if (c.phase === 'done') return c.times?.total !== undefined ? spent(c.times.total) : undefined
  if (c.phase === 'working' && c.step && c.state?.since !== undefined) return `${spent(now - c.state.since)} in ${c.step}`
}

// The sheet's line: 'work 25 min · review 9 min · waited for you 1 h · 2 review rounds · 1 CI fix · 42 min in all'.
export function timesText(x: Times): string {
  const plural = (n: number, one: string) => `${n} ${one}${n > 1 ? 's' : ''}`
  return [
    ...x.steps.map(p => `${p.id} ${spent(p.ms)}`),
    ...(x.waited >= 60_000 ? [`waited for you ${spent(x.waited)}`] : []),
    ...(x.rounds ? [plural(x.rounds, 'review round')] : []),
    ...(x.ciFixes ? [plural(x.ciFixes, 'CI fix').replace('fixs', 'fixes')] : []),
    ...(x.total !== undefined ? [`${spent(x.total)} in all`] : []),
  ].join(' · ')
}
