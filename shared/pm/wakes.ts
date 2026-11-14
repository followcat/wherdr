// The coordinator's wake queue (DATA_DIR/projects/wakes.jsonl). Pure: the
// server (server/utils/pmWakes.ts) reads the queue, feeds it what herdr-core
// says of the coordinator, and carries out what comes back.
//
// A wake waits until the coordinator is idle and the user has not written for
// a minute; its pending reasons go as one message whose first line names its
// kind (Autopilot, Step check, Engine, Health check, Incident). Delivered, it
// is open until the coordinator acks it, stays idle 2 min, quits, or 1 h
// passes; no other wake goes while one is open, except the user's "run now".
// Not acked within 15 min (and its turn over): delivered once more, then the user is told.
import { FIXES_PER_STEP, FIX_KINDS, FIX_TEXT, inHours, type Autopilot } from './autopilot'

// Who sends it: the autopilot (its schedule, events, the user's "run now"), a
// step the coordinator holds (its start, recheck or timeout), the engine giving
// up on a block, the health check, or an incident (incidentWake.ts, about: its
// id). Old wakes without one: the autopilot.
export type WakeKind = 'autopilot' | 'step' | 'engine' | 'health' | 'incident'
export const WAKE_LABEL: Record<WakeKind, string> = { autopilot: 'Autopilot', step: 'Step check', engine: 'Engine', health: 'Health check', incident: 'Incident' }

export interface Wake {
  id: string
  coordinator: string // project key
  kind?: WakeKind
  about?: string // a step check's task and step: "CO-1 (deploy)"
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
const same = (a: Pick<Wake, 'kind' | 'about'>, b: Pick<Wake, 'kind' | 'about'>) => (a.kind ?? 'autopilot') === (b.kind ?? 'autopilot') && a.about === b.about
const pendings = (q: Wake[], c: string) => mine(q, c).filter(w => w.deliveredAt === undefined && !w.ended)
const pendingOf = (q: Wake[], c: string, like?: Pick<Wake, 'kind' | 'about'>) => pendings(q, c).find(w => !like || same(w, like))
const isOpen = (w: Wake) => w.deliveredAt !== undefined && w.endedAt === undefined

// New reasons join the coordinator's pending wake of the same kind (and step),
// or start one: each wake keeps one source. Returns the changed wake.
export function enqueue(q: Wake[], coordinator: string, reasons: string[], now: number, id: string, runNow = false, from: Pick<Wake, 'kind' | 'about'> = {}): Wake {
  const like = { kind: from.kind ?? 'autopilot', ...(from.about ? { about: from.about } : {}) }
  const p = pendingOf(q, coordinator, like)
  const add = (old: string[]) => [...old, ...reasons.filter(r => !old.includes(r))]
  if (p) return { ...p, reasons: add(p.reasons), ...(runNow ? { now: true as const } : {}) }
  return { id, coordinator, ...like, reasons: add([]), createdAt: now, tries: 0, ...(runNow ? { now: true as const } : {}) }
}

// The first line: its kind, a step check's task and step, its id.
export const wakeHead = (w: Wake) =>
  `${WAKE_LABEL[w.kind ?? 'autopilot']}: ${w.about ? `${w.about}, ` : ''}wake ${w.id}${w.tries > 1 ? ` (again: no ack after ${WAKE.ACK_MS / 60_000} min)` : ''}`

// A message's wake kind, read from its first line (the chat's label); null: not a wake.
// Its queued or pasted form reads the same: a leading <pasted_content> wrapper or blank lines are skipped.
const HEAD_RE = new RegExp(`^(?:\\s*<pasted_content[^>]*>)?\\s*(${Object.values(WAKE_LABEL).join('|')}): (?:.*, )?wake \\S+`)
export const wakeKindOf = (text: string): WakeKind | null => {
  const m = HEAD_RE.exec(text)
  return m ? (Object.keys(WAKE_LABEL) as WakeKind[]).find(k => WAKE_LABEL[k] === m[1]) ?? null : null
}

// The coordinators (keys: the task's project, the main one) that get the
// engine's give-up on a block (selfFix.ts): each running with its autopilot
// on, in its hours. A give-up needs judgment: it wakes whatever the events.
export const wakesFor = (keys: string[], coordinator: (key: string) => { terminal?: string, autopilot?: Autopilot } | undefined, now: number) =>
  keys.filter((key) => {
    const c = coordinator(key), ap = c?.autopilot
    return !!c?.terminal && !!ap?.on && inHours(ap.hours, new Date(now))
  })

// What a wake may do beyond answering a question: a project coordinator's, its autopilot on.
export const FIX_LINE = `In this wake you may unblock a task of your project when the block is mechanical, with \`wherdr pm tell <task> "<what to do>" --fix <kind> --reason "<one sentence>"\`: ${FIX_KINDS.map(k => `${k} (${FIX_TEXT[k]})`).join(', ')}. A worker that was let go or has ended starts again with your message. At most ${FIXES_PER_STEP} times per task and step; then tell the user. A permission request, merging, approving, guards, settings and limits stay the user's.`

// The text the coordinator gets: its reasons, what it may fix, and how to say it handled them.
export const wakeText = (w: Wake, fixes = false) => [
  wakeHead(w),
  ...w.reasons,
  ...(fixes ? [FIX_LINE] : []),
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
    const other = pendingOf(cur(), coordinator, w)
    if (other) put({ ...other, ended: 'merged', endedAt: now })
    put({ ...w, deliveredAt: undefined, idleSince: undefined, endedAt: undefined, ended: undefined, reasons: [...w.reasons, ...(other?.reasons ?? []).filter(r => !w.reasons.includes(r))], ...(other?.now ? { now: true as const } : {}) })
  }
  // Never in the middle of a turn; not within a minute of the user's message,
  // nor over an open wake, unless the user asked to run now.
  const next = pendings(cur(), coordinator).find(w => w.now) ?? pendingOf(cur(), coordinator)
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

// A wake the engine did not send, and why: the coordinator's last three days,
// newest last, shown by `wherdr pm autopilot show`, never in its chat.
export interface WakeSkip { at: number, what: WakeKind | 'question', why: string }
// Kept three days (the timeline shows yesterday and today, a clock change included).
export const SKIPS_KEPT_MS = 3 * 86_400_000
const SKIP_AGAIN_MS = 12 * 3_600_000
// The list with this skip, unless the same one is noted within 12 h: only for
// what is seen every tick (an engine block, a question); a scheduled wake or a
// health check is skipped once per slot, each one noted (the Autopilot tab's timeline).
const PER_TICK = new Set<WakeSkip['what']>(['engine', 'question'])
export const addSkip = (skips: WakeSkip[] | undefined, s: WakeSkip): WakeSkip[] | undefined =>
  PER_TICK.has(s.what) && skips?.some(x => x.what === s.what && x.why === s.why && s.at - x.at < SKIP_AGAIN_MS) ? undefined : [...(skips ?? []).filter(x => s.at - x.at < SKIPS_KEPT_MS), s]

// Is the coordinator's current turn a wake? Only while a delivered wake is open.
export const inWake = (q: Wake[], coordinator: string) => mine(q, coordinator).some(isOpen)

// The Autopilot tab's window starts at yesterday's local midnight (a 23 or 25 h day included).
export const sinceYesterday = (now: number) => { const d = new Date(now); d.setDate(d.getDate() - 1); return d.setHours(0, 0, 0, 0) }

// Last record per id wins (the file is append-only); old ended wakes dropped.
export function readQueue(lines: string[], now: number, keepMs = 86_400_000): Wake[] {
  const byId = new Map<string, Wake>()
  for (const l of lines) {
    try { const w = JSON.parse(l) as Wake; if (w && typeof w.id === 'string' && typeof w.coordinator === 'string') byId.set(w.id, w) } catch { /* a cut line */ }
  }
  return [...byId.values()].filter(w => w.endedAt === undefined || now - w.endedAt < keepMs)
}
