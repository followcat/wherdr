// The summary line of a repo group on the home list, under its coordinator:
// "4 TASKS · 1 YOUR TURN · 1 LIMIT". It counts the tasks' rows only (the
// coordinator has its own row and state above it), so it says the same thing
// folded or not.
import { type Member, taskStat } from '../../shared/boardLinks'
import type { TaskGroup } from '../../shared/projectsTasks'
import { rowGroup } from '../../shared/spaces'

// The Board's group a task's row shows. Null for a row without a task.
export function memberGroup(m: Member): TaskGroup | null {
  return m.task?.group ?? null
}

export interface TaskSummary { tasks: number, blocked: number, working: number, limit: number }

export function taskSummary(members: Member[]): TaskSummary {
  const s: TaskSummary = { tasks: 0, blocked: 0, working: 0, limit: 0 }
  const seen = new Set<string>()
  for (const m of members) {
    if (m.task) {
      const key = `${m.board ?? ''}|${m.task.id}`
      if (seen.has(key)) continue
      seen.add(key)
    }
    s.tasks++
    // As its row says it: the Board's group, else its agents' state.
    const g = memberGroup(m)
    const stat = g ? taskStat(g) : rowGroup(m.row)
    if (stat === 'blocked') s.blocked++
    else if (stat === 'working') s.working++
    // The pane the row shows: the one its card tags with "Quota" (a provider quota, not a task limit).
    if (m.row.lead.usageLimit) s.limit++
  }
  return s
}

export type SummaryPart = { key: 'tasks' | 'blocked' | 'working' | 'limit', text: string }

// The parts of the line, in reading order; a count of zero is left out
// (except the number of tasks).
export function summaryParts(s: TaskSummary, tl: (en: string, fr: string) => string): SummaryPart[] {
  const parts: SummaryPart[] = [{
    key: 'tasks',
    text: !s.tasks ? tl('No tasks', 'Aucune tâche') : s.tasks === 1 ? tl('1 task', '1 tâche') : tl(`${s.tasks} tasks`, `${s.tasks} tâches`),
  }]
  if (s.blocked) parts.push({ key: 'blocked', text: tl(`${s.blocked} your turn`, `${s.blocked} à toi`) })
  if (s.working) parts.push({ key: 'working', text: tl(`${s.working} working`, `${s.working} en cours`) })
  if (s.limit) parts.push({ key: 'limit', text: s.limit === 1 ? tl('1 quota', '1 quota') : tl(`${s.limit} quotas`, `${s.limit} quotas`) })
  return parts
}
