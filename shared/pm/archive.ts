// Done tasks leave the board's Done column some days after they are done: the
// engine archives them (server/utils/pmStop.ts, archiveDone). An archived task
// keeps everything, its branch and PR included; only the board hides it, and
// the Done column's footer opens the list of them (ArchivedSheet.vue).
import type { Task } from './run'

// The choices of a project's General tab; 0: never.
export const ARCHIVE_DAYS = [1, 3, 7, 14, 30, 0] as const
export const DEFAULT_ARCHIVE_DAYS = 7
const DAY = 86_400_000

export const archiveDays = (p: { archiveAfter?: number } | undefined) => p?.archiveAfter ?? DEFAULT_ARCHIVE_DAYS

// When it was done: its done mark, else its last log line; an unarchive starts the wait again.
export function doneAt(t: Task): number {
  const mark = t.marks?.findLast(m => m.done)?.at ?? t.log?.at(-1)?.at ?? t.createdAt
  return Math.max(mark, t.unarchived ?? 0)
}

// Done, not archived yet, done for longer than the project's delay.
export const archiveDue = (t: Task, days: number, now: number) =>
  !!t.step?.done && !t.archived && days > 0 && now - doneAt(t) >= days * DAY

export const archivedText = (days: number) => `archived after ${days} day${days > 1 ? 's' : ''} done`

// The archived sheet's search: title, id (stored or shown) or a tag, any case.
export function archivedMatch(c: { id: string, shown: string, title: string, tags: string[] }, q: string) {
  const s = q.trim().toLowerCase()
  return !s || [c.id, c.shown, c.title, ...c.tags].some(x => x.toLowerCase().includes(s))
}
