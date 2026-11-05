// The coordinator's wake queue (DATA_DIR/projects/wakes.jsonl). Pure: the
// server (server/utils/pmWakes.ts) reads the queue, feeds it what herdr-core
// says of the coordinator, and carries out what comes back.
//
// A wake waits until the coordinator is idle and the user has not written for
// a minute; its pending reasons go as one "Autopilot:" message. Delivered, it
// is open until the coordinator acks it, stays idle 2 min, quits, or 1 h
// passes; no other wake goes while one is open, except the user's "run now".
// Not acked within 15 min (and its turn over): delivered once more, then the user is told.

export interface Wake {
  id: string
  coordinator: string // project key
  reasons: string[]
  createdAt: number
  deliveredAt?: number
  ackedAt?: number
  tries: number // deliveries so far
  idleSince?: number // first tick seen idle since delivery
  endedAt?: number
  ended?: 'ack' | 'idle' | 'quit' | 'timeout' | 'unanswered' | 'merged'
  now?: true // the user's "run now"
}

export const WAKE = { QUIET_MS: 60_000, ACK_MS: 15 * 60_000, IDLE_MS: 2 * 60_000, TIMEOUT_MS: 3_600_000, TRIES: 2 } as const

const mine = (q: Wake[], c: string) => q.filter(w => w.coordinator === c)
const pendingOf = (q: Wake[], c: string) => mine(q, c).find(w => w.deliveredAt === undefined && !w.ended)
const isOpen = (w: Wake) => w.deliveredAt !== undefined && w.endedAt === undefined

// New reasons join the coordinator's pending wake, or start one. Returns the changed wake.
export function enqueue(q: Wake[], coordinator: string, reasons: string[], now: number, id: string, runNow = false): Wake {
  const p = pendingOf(q, coordinator)
  const add = (old: string[]) => [...old, ...reasons.filter(r => !old.includes(r))]
  if (p) return { ...p, reasons: add(p.reasons), ...(runNow ? { now: true as const } : {}) }
  return { id, coordinator, reasons: add([]), createdAt: now, tries: 0, ...(runNow ? { now: true as const } : {}) }
}

// The text the coordinator gets: its reasons, and how to say it handled them.
export const wakeText = (w: Wake) => [
  `Autopilot: wake ${w.id}${w.tries > 1 ? ` (again: no ack after ${WAKE.ACK_MS / 60_000} min)` : ''}`,
  ...w.reasons,
  `When you have handled this, run: wherdr pm ack ${w.id}`,
].join('\n\n')

// What herdr-core says of the coordinator's terminal on this tick.
export type CoordStatus = 'idle' | 'working' | 'gone'
export interface TickInput { status: CoordStatus, lastUserAt?: number, now: number }
// changed: wakes to save. deliver: send now. notify: tell the user it does not answer.
export interface TickResult { changed: Wake[], deliver?: Wake, notify?: Wake }

// One tick for one coordinator: open wakes end, missed acks come back once,
// then the next pending wake goes if the coordinator may get it now.
export function tickWakes(q: Wake[], coordinator: string, { status, lastUserAt, now }: TickInput): TickResult {
  const changed = new Map<string, Wake>()
  const cur = () => mine(q, coordinator).map(w => changed.get(w.id) ?? w)
  const put = (w: Wake) => { changed.set(w.id, w); return w }
  let notify: Wake | undefined
  for (const w of cur()) {
    if (isOpen(w)) {
      const idleSince = status === 'idle' ? w.idleSince ?? now : undefined
      const end = status === 'gone' ? 'quit' as const
        : idleSince !== undefined && now - idleSince >= WAKE.IDLE_MS ? 'idle' as const
        : now - w.deliveredAt! >= WAKE.TIMEOUT_MS ? 'timeout' as const : undefined
      if (end) put({ ...w, idleSince, endedAt: now, ended: end })
      else if (idleSince !== w.idleSince) put({ ...w, idleSince })
    }
  }
  // No ack within 15 min, its turn over: once more (with what waits meanwhile), then the user.
  for (const w of cur()) {
    if (w.deliveredAt === undefined || isOpen(w) || w.ackedAt !== undefined || w.ended === 'unanswered' || now - w.deliveredAt < WAKE.ACK_MS) continue
    if (w.tries >= WAKE.TRIES || status === 'gone') { notify = put({ ...w, endedAt: w.endedAt ?? now, ended: 'unanswered' }); continue }
    const other = pendingOf(cur(), coordinator)
    if (other) put({ ...other, ended: 'merged', endedAt: now })
    put({ ...w, deliveredAt: undefined, idleSince: undefined, endedAt: undefined, ended: undefined, reasons: [...w.reasons, ...(other?.reasons ?? []).filter(r => !w.reasons.includes(r))], ...(other?.now ? { now: true as const } : {}) })
  }
  // Never in the middle of a turn; not within a minute of the user's message,
  // nor over an open wake, unless the user asked to run now.
  const next = pendingOf(cur(), coordinator)
  let deliver: Wake | undefined
  if (next && status === 'idle' && (next.now || ((lastUserAt === undefined || now - lastUserAt >= WAKE.QUIET_MS) && !cur().some(isOpen)))) {
    for (const w of cur().filter(isOpen)) put({ ...w, endedAt: now, ended: w.ackedAt !== undefined ? 'ack' : 'idle' })
    deliver = put({ ...next, deliveredAt: now, tries: next.tries + 1, idleSince: undefined, now: undefined })
  }
  return { changed: [...changed.values()], ...(deliver ? { deliver } : {}), ...(notify ? { notify } : {}) }
}

// `wherdr pm ack <id>…`: the coordinator's own delivered wakes only.
export function ackWakes(q: Wake[], coordinator: string, ids: string[], now: number): { changed: Wake[], unknown: string[] } {
  const changed: Wake[] = [], unknown: string[] = []
  for (const id of ids) {
    const w = q.find(x => x.id === id && x.coordinator === coordinator && (x.deliveredAt !== undefined || x.tries > 0))
    if (!w) { unknown.push(id); continue }
    if (w.ackedAt === undefined) changed.push({ ...w, ackedAt: now, endedAt: w.endedAt ?? now, ended: w.ended === 'unanswered' ? w.ended : w.ended ?? 'ack' })
  }
  return { changed, unknown }
}

// Is the coordinator's current turn a wake? Only while a delivered wake is open.
export const inWake = (q: Wake[], coordinator: string) => mine(q, coordinator).some(isOpen)

// Last record per id wins (the file is append-only); old ended wakes dropped.
export function readQueue(lines: string[], now: number, keepMs = 86_400_000): Wake[] {
  const byId = new Map<string, Wake>()
  for (const l of lines) {
    try { const w = JSON.parse(l) as Wake; if (w && typeof w.id === 'string' && typeof w.coordinator === 'string') byId.set(w.id, w) } catch { /* a cut line */ }
  }
  return [...byId.values()].filter(w => w.endedAt === undefined || now - w.endedAt < keepMs)
}
