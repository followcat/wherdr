// The card of a task the board leaves out (archived: shared/pm/archive.ts), for
// a task sheet opened by a link, a notification or a chat's task card. Read once
// per id from GET /api/pm/archived?id=, again after an action in a task's sheet;
// the last card stays shown while it is read again.
import type { Card } from '#shared/pm/board'

const known = reactive(new Map<string, Card | null>())
const asking = new Set<string>()
function ask(id: string) {
  if (asking.has(id)) return
  asking.add(id)
  api<{ card: Card | null }>(`/api/pm/archived?id=${encodeURIComponent(id)}`)
    .then(r => known.set(id, r.card), () => { if (!known.has(id)) known.set(id, null) })
    .finally(() => asking.delete(id))
}
// A card already in hand (a row of the archived sheet): no read.
export const keepArchivedCard = (c: Card) => { known.set(c.id, c) }

// id: the task asked for; missing: the board is read and does not have it.
export function useArchivedCard(id: () => string | null, missing: () => boolean) {
  watchEffect(() => { const v = id(); if (v && missing() && !known.has(v)) ask(v) })
  watch(taskSheetTick, () => { for (const v of known.keys()) ask(v) })
  return computed(() => { const v = id(); return v && missing() ? known.get(v) ?? null : null })
}
