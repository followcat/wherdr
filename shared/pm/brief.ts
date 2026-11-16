// Alfred's brief (`wherdr alfred brief`): the facts of a project since a time,
// read from its tasks, with no model call. Pure: the server
// (server/utils/alfredBrief.ts) adds coordinators, machines, quotas, incidents.
import type { Quota } from '../types'
import type { Task } from './run'
import { taskStatus } from './autopilot'
import { STUCK_LONG_MS } from './health'
import { current } from './pacing'

// A brief with no earlier one of its scope and no --since covers a day.
export const BRIEF_DAY_MS = 86_400_000
// A quota window this used (%), or its account limited, is near its limit.
export const QUOTA_NEAR = 80

const firstLine = (s?: string) => s?.split('\n')[0]?.trim() || undefined
const doneAt = (t: Task) => t.marks?.findLast(m => m.done)?.at

// What a waiting task waits for: its step's badge (Merge, Review…), a question
// or a block (stopped: who stopped it and why).
export function waitsFor(t: Task): string | undefined {
  if (t.stopped) return `block: ${firstLine(t.stopped.why) ?? 'stopped'}`
  if (t.state === 'waiting') return `${t.waitKind ?? 'question'}${t.waiting ? `: ${firstLine(t.waiting)}` : ''}`
  return t.step?.yourTurn?.badge
}

export interface ProjectFacts {
  merged: { id: string, title: string }[]
  waiting: { id: string, title: string, what: string }[]
  stuck: { id: string, title: string, why: string, hours: number }[]
}

// One project's tasks (with their shown ids) since `since`.
export function projectFacts(tasks: Task[], since: number, now: number): ProjectFacts {
  const facts: ProjectFacts = { merged: [], waiting: [], stuck: [] }
  for (const t of tasks) {
    const status = taskStatus(t), at = doneAt(t)
    if (status === 'done') {
      if (!t.step?.abandoned && at !== undefined && at >= since) facts.merged.push({ id: t.id, title: t.title })
      continue
    }
    const what = waitsFor(t)
    if (what && (status === 'waiting' || status === 'ready' || t.stopped)) facts.waiting.push({ id: t.id, title: t.title, what })
    else if (status === 'stalled' && t.stall && now - t.stall.since >= STUCK_LONG_MS)
      facts.stuck.push({ id: t.id, title: t.title, why: firstLine(t.stall.reason) ?? t.stall.cause, hours: Math.floor((now - t.stall.since) / 3_600_000) })
  }
  return facts
}

// The windows of a quota at or over QUOTA_NEAR, or its limit hit.
export function quotaNear(q: Quota | null, now: number): string[] {
  if (!q) return []
  if (q.limited && (q.limited.resetsAt === null || q.limited.resetsAt > now)) return ['limited']
  return ([['5h', q.five], ['week', q.week]] as const).flatMap(([name, w]) => {
    const used = current(w, now)?.used
    return used !== undefined && used >= QUOTA_NEAR ? [`${name} ${Math.round(used)}% used`] : []
  })
}
