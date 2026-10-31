// Messages sent from the phone and shown as "queued": when
// did the agent take them?
import type { ChatItem, ClaudeQueueEntry, Pane, QueuedMessage } from '../../shared/types'
import { isUploadLine, photosLanded, photosOnly, uploadNames } from '../../shared/queuedMatch'

// A message sent that never shows in the conversation is reported as not
// seen after this long (see checkSent), instead of waiting for ever.
export const QUEUED_TTL_MS = 60 * 60 * 1000
// A message reported as not sent is kept (across restarts too) until Retry,
// Cancel or its text shows in the conversation, for at most this long.
export const FAILED_TTL_MS = 24 * 60 * 60 * 1000
// Sent photo ("<home>/.cache/herdr-web/uploads/<name>" line of a message).
export { isUploadLine }
const norm = (t: unknown) => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase()
// "! cmd": Claude Code switches to bash mode and only writes "cmd" (<bash-input>).
// omp also has "!!cmd" (kept out of the model's context) and "$ code" / "$$ code" (Python).
export const bashText = (t: string) => String(t || '').replace(/^\s*(?:!!?|\$\$?)\s*/, '')
// omp runs "!cmd" / "!!cmd" / "$ code" / "$$ code" the moment it is submitted,
// even during a turn. A run that ends while the agent works is only written
// to the transcript when the next prompt starts: once that turn is over, the
// run is taken even though the transcript does not show it yet.
export const isOmpRun = (agent: string | null | undefined, text: string) => agent === 'omp' && /^\s*(?:!|\$\$?\s)/.test(String(text || ''))
// The run omp shows on screen ("Running…", see parseOmpShell) is this message's
// command: omp took it. A run cancelled (Stop, Escape) or finished while omp
// rests may never reach the transcript (omp 18.6 writes none before the first
// prompt of a session, and only "You ran" blocks with the next prompt).
export function ompRunShown(agent: string | null | undefined, text: string, shell: { command: string, python?: boolean } | null | undefined): boolean {
  if (!shell || !isOmpRun(agent, text) || /^\s*\$/.test(text) !== Boolean(shell.python)) return false
  // Without spaces: the screen wraps a long command, even mid-word, and may cut it.
  const want = bashText(text).replace(/\s+/g, '').toLowerCase().slice(0, 80)
  const shown = String(shell.command || '').replace(/\s+/g, '').toLowerCase().slice(0, 80)
  return Boolean(want && shown) && (shown.startsWith(want) || (shown.length >= 8 && want.startsWith(shown)))
}

// Taken by the agent = a user message in the transcript, written after
// sending, that contains the start of the text (Claude may group several
// queued messages into a single turn). Text modified by the agent: when idle,
// a user message written after sending followed by a reply is enough.
export function queuedDone(q: { text: string, at: number, turnSeen?: boolean }, items: ChatItem[], idle: boolean, _now: number, agent?: string | null): boolean {
  if (idle && q.turnSeen && isOmpRun(agent, q.text)) return true
  const users = items.filter(i => i.role === 'user' || i.role === 'cmd' || i.role === 'bash')
  // Photo paths become images in the transcript; photos alone are matched by
  // their photos (see shared/queuedMatch.ts).
  const needle = norm(q.text.split('\n').filter(l => !isUploadLine(l)).join(' ')).slice(0, 80)
  const bashNeedle = norm(bashText(q.text)).slice(0, 80)
  const photos = photosOnly(q.text)
  if (users.some(u => (!u.ts || Date.parse(u.ts) >= q.at - 10000)
    && (u.role === 'bash' ? Boolean(bashNeedle) && norm(u.text).includes(bashNeedle)
      : needle ? norm(u.text).includes(needle) : photos ? photosLanded(q.text, u) : (u.images || 0) > 0))) return true
  if (!idle) return false
  const i = items.findIndex(u => u.role === 'user' && u.ts && Date.parse(u.ts) > q.at)
  return i >= 0 && items.slice(i + 1).some(a => a.role === 'assistant')
}

// Taken by the agent, for a message wherdr typed without seeing it taken (a
// send given up, failed, or waiting for another attempt). Deciding wrongly
// "taken" would drop it unsent, so the rule is exact, never a substring:
// - a user message of the transcript, with a time, written at most
//   LANDED_SLACK_MS before wherdr typed it (`typedAt`, else `at`): Claude's
//   queued_command keeps the moment Enter queued it, after the typing began;
// - whose whole text is this message (spaces aside; photo lines may have
//   become images), or, for a message of LANDED_PART_MIN characters or more,
//   a run of its whole lines (an agent grouping queued messages into one);
//   "ok" or "yes" never match inside "ok, and check the token";
// - a photos-only message: a user message with its photos;
// - `taken`: transcript messages already matched to another of wherdr's
//   messages, each counted once (the same "ok" sent twice).
// The matching transcript message is added to `taken`. No expiry here: a
// message is never judged taken because it is old.
export const LANDED_SLACK_MS = 2000
// Longest text wherdr keeps of a queued message (see addQueued).
export const QUEUED_TEXT_MAX = 4000
export const LANDED_PART_MIN = 20
const flat = (t: unknown) => String(t || '').replace(/\s+/g, ' ').trim()
const lineList = (t: string) => t.split('\n').map(flat).filter(Boolean)
export function landed(q: { text: string, at: number, typedAt?: number }, items: ChatItem[], _now: number, agent?: string | null, taken: Set<ChatItem> = new Set()): boolean {
  const since = (q.typedAt ?? q.at) - LANDED_SLACK_MS
  const photos = photosOnly(q.text)
  const bash = /^\s*!/.test(q.text) || isOmpRun(agent, q.text) ? flat(bashText(q.text)) : null
  const bare = q.text.split('\n').filter(l => !isUploadLine(l)).join('\n')
  const wholes = new Set([flat(bare), flat(q.text)].filter(Boolean))
  const lines = lineList(bare)
  // wherdr keeps the first QUEUED_TEXT_MAX characters: a longer message is
  // known by its start (its last kept line may be cut).
  const cut = q.text.length >= QUEUED_TEXT_MAX
  const want = cut ? lines.slice(0, -1) : lines
  const partOf = (text: string) => {
    if (flat(bare).length < LANDED_PART_MIN || !want.length) return false
    const theirs = lineList(text)
    if (cut) return want.every((l, j) => theirs[j] === l)
    for (let i = 0; i + want.length <= theirs.length; i++) if (want.every((l, j) => theirs[i + j] === l)) return true
    return false
  }
  const hit = items.find((u) => {
    if (taken.has(u) || !u.ts || !(Date.parse(u.ts) >= since)) return false
    if (u.role === 'bash') return bash !== null && Boolean(bash) && flat(u.text) === bash
    if (u.role !== 'user' && u.role !== 'cmd') return false
    if (photos) return photosLanded(q.text, u)
    return wholes.has(flat(u.text)) || partOf(u.text)
  })
  if (!hit) return false
  taken.add(hit)
  return true
}

// Messages sent while a menu, panel or dialog hides the agent's input field (an
// interactive /mcp, /hooks… flow, omp's tool approval): typed into it, they
// would be lost, or Enter would answer it. They are held here and delivered,
// in order, as soon as the input is visible again.
// A message that was delivered but never shows up in the transcript while the
// agent sits ready is reported as failed, with Retry / Cancel, instead of
// staying "sending…" forever.
export const HOLD_TTL_MS = 10 * 60 * 1000
export const LOST_MS = 60 * 1000
// Held while the agent is ready and no menu, question or panel is recognized
// on its screen: nothing will close, the input field is just not found
// (unknown screen). Reported as not sent, with that reason, instead of
// waiting "until the menu closes" for nothing.
export const NO_INPUT_MS = 30 * 1000
export const HOLD_AGENTS = new Set(['claude', 'codex', 'omp'])
// Agent at rest, whose input field may be checked on screen (see closePanel).
export const INPUT_STATES = new Set(['idle', 'done', 'unknown'])

export interface QueueEntry {
  id: string
  text: string
  // The whole message when `text` had to be cut (display/record bound):
  // delivery and give-back use it, never the truncated preview.
  full?: string
  // The terminator this message was submitted with ("send with Tab"…):
  // preserved through holds, retries and restarts — delivery must not
  // silently turn it back into Enter.
  submitKey?: string
  at: number
  held?: boolean
  failed?: boolean
  // Claimed on disk before terminal I/O; an interrupted attempt is uncertain.
  delivering?: boolean
  // Held (or failed) because the agent's input field was not empty.
  inputText?: string
  busy?: boolean
  // Since when the agent has been ready with this message delivered.
  readySince?: number
  // The agent worked (a turn) after this message was typed (see isOmpRun).
  turnSeen?: boolean
  // Held: since when the agent has been ready with no menu recognized.
  stuckSince?: number
  // Failed because the input field was not found on an unknown screen.
  noInput?: boolean
  // Given back (see giveBackHeld): its text returns to the message field.
  back?: boolean
  // When wherdr last began typing it into the field. On a held message, set
  // only after a send given up (see guardedSend.ts): the agent may still take
  // it late, so its transcript is looked at (see landed) before any new
  // attempt. On a message sent or failed, where landed looks from.
  typedAt?: number
  // Held until the agent's turn ends: typing it during the turn failed.
  turn?: boolean
  // Pulled back out of Claude's queue and not queued again (see checkSent),
  // since `lostSince`.
  popped?: boolean
  lostSince?: number
  // Failed because it left Claude's queue without reaching the conversation.
  lost?: boolean
  // Failed because it never showed in the conversation within QUEUED_TTL_MS.
  unseen?: boolean
}

// Hold a new message instead of typing it now?
export function shouldHold(agent: string | null | undefined, status: string | null | undefined, input: boolean, earlierHeld: boolean): boolean {
  if (!agent || !HOLD_AGENTS.has(agent)) return false
  // Keep the order: behind a held message, everything waits.
  if (earlierHeld) return true
  return INPUT_STATES.has(status || '') && !input
}

// Next held message to deliver: the oldest one, and only when nothing older
// is still held (a failed one is skipped: it waits for Retry or Cancel).
export function nextHeld(list: QueueEntry[]): QueueEntry | null {
  return list.find(q => q.held && !q.failed) || null
}

// A menu or panel left open on the agent's screen (Claude's /status opened in
// its terminal during a turn…) hides its input field, with no card of the
// conversation showing it: held messages would wait for it with no word.
// Worth a look at the screen: messages wait for the input field (held, or
// not sent for lack of it), and nothing on the conversation explains why.
export function lookForLeftMenu(p: Pick<Pane, 'agent' | 'status' | 'stopped' | 'queued' | 'menu' | 'prompt' | 'screen'>): boolean {
  if (!p.agent || !HOLD_AGENTS.has(p.agent) || p.stopped || p.menu || p.prompt || p.screen) return false
  if (p.status !== 'working' && !INPUT_STATES.has(p.status || '')) return false
  return (p.queued || []).some(q => (q.state === 'held' && q.reason !== 'busy') || (q.state === 'failed' && q.reason === 'no_input'))
}

// Updates timers in place on each poll; true when an entry just failed.
// `menu`: a menu, question or panel recognized on the agent's screen (or a
// restart running): something a held message legitimately waits for.
export function checkQueue(list: QueueEntry[], status: string | null | undefined, now: number, menu = true): boolean {
  let changed = false
  const ready = status === 'idle' || status === 'done'
  for (const q of list) {
    if (q.failed) continue
    if (q.held) {
      // A terminal draft needs the user's attention, not a retry. Keep the
      // explanation/actions and automatic delivery for as long as it remains.
      if (q.busy) { delete q.stuckSince; continue }
      // Waiting for the end of a turn: however long the turn lasts, then
      // counted from the moment the agent rests.
      const turn = q.turn
      if (turn && !ready) { delete q.stuckSince; delete q.readySince; continue }
      if (turn) q.readySince ??= now
      if (now - (turn ? q.readySince! : q.at) > HOLD_TTL_MS) { q.failed = true; changed = true; continue }
      if (!ready || menu) { delete q.stuckSince; continue }
      q.stuckSince ??= now
      if (now - q.stuckSince > NO_INPUT_MS) { q.failed = true; q.noInput = true; changed = true }
      continue
    }
    if (!ready) { delete q.readySince; continue }
    q.readySince ??= now
    if (now - Math.max(q.readySince, q.at) > LOST_MS) {
      q.failed = true
      // Known to be pulled back out of Claude's queue (see checkSent): said so.
      if (q.popped) q.lost = true
      delete q.popped
      delete q.lostSince
      changed = true
    }
  }
  return changed
}

// Messages typed and taken by the agent's input field (not held, not failed)
// that the conversation does not show yet (see queuedDone), against Claude's
// own queue as its transcript records it. Updated in place; true when one
// just failed. `claude`: null when Claude's transcript could not be read.
// - Claude: the message was pulled back out of its queue into the input field
//   (`popAll`: ↑ in the terminal…) and not queued again. Erased there, or
//   left there while Claude works, it will not be read: after LOST_MS it is
//   reported as not sent, instead of staying "queued" until the turn ends,
//   however long. The tail read keeps only recent queue operations, so the
//   fact is remembered (`popped`) until the message is queued again.
// - Any agent: still not in the conversation after QUEUED_TTL_MS, and not in
//   Claude's queue (a turn that long may still read it): not seen.
// Either way it gets Retry / Cancel. Retry waits for the end of a turn and
// first looks at the transcript again (see landed): a message the agent did
// take is not typed twice.
export function checkSent(list: QueueEntry[], o: { agent: string | null | undefined, claude: { queue: ClaudeQueueEntry[], popped: ClaudeQueueEntry[] } | null, now: number }): boolean {
  let changed = false
  for (const q of list) {
    if (q.held || q.failed) { delete q.lostSince; delete q.popped; continue }
    // The same message, never one that merely contains it or starts like it
    // ("review server" is not "review server and client"): its whole text,
    // spaces aside, or, past QUEUED_TEXT_MAX (wherdr keeps the start only),
    // an entry starting with it; photos alone, by their number.
    const text = flat(q.text.split('\n').filter(l => !isUploadLine(l)).join('\n'))
    const cut = q.text.length >= QUEUED_TEXT_MAX
    const photos = uploadNames(q.text).length
    const after = (e: ClaudeQueueEntry) => !e.ts || Date.parse(e.ts) >= (q.typedAt ?? q.at) - LANDED_SLACK_MS
    const isIt = (e: ClaudeQueueEntry) => after(e) && (text
      ? (cut ? flat(e.text).startsWith(text) : flat(e.text) === text)
      : !e.text && (e.images || 0) === photos)
    const c = o.agent === 'claude' ? o.claude : null
    const inQueue = Boolean(c && c.queue.some(isIt))
    if (inQueue) { delete q.popped; delete q.lostSince }
    else if (c && c.popped.some(isIt)) q.popped = true
    if (!inQueue && o.now - q.at > QUEUED_TTL_MS) {
      q.failed = true
      q.unseen = true
      changed = true
    } else if (q.popped) {
      q.lostSince ??= o.now
      if (o.now - q.lostSince <= LOST_MS) continue
      q.failed = true
      q.lost = true
      changed = true
    }
    if (q.failed) { delete q.lostSince; delete q.popped }
  }
  return changed
}

// Held messages nobody will take any more (their agent is gone and the pane is
// a plain shell, with no conversation to show them in): given back. The
// first device that sees one takes it out of the queue and puts its text back
// into the pane's message field (see app/utils/givenBack.ts), so that the
// user never loses sight of something they wrote.
export function giveBackHeld(list: QueueEntry[] | undefined) {
  for (const q of list || []) if (q.held) { q.failed = true; q.back = true }
}
// Codex left without an update (no card after the check of its screen) and
// no agent is back: nothing will take the messages held during the check.
export const leftForGood = (p: Pick<Pane, 'agent' | 'leaving'>, before: Pick<Pane, 'leaving'> | undefined) =>
  !p.agent && !p.leaving && Boolean(before?.leaving)

// Fields the app sees.
export const publicEntry = (q: QueueEntry): QueuedMessage => ({
  id: q.id, text: q.text, at: q.at,
  ...(q.submitKey ? { submitKey: q.submitKey } : {}),
  ...(q.held && !q.failed ? { state: 'held' as const } : {}),
  ...(q.failed ? { state: 'failed' as const } : {}),
  ...((q.held || q.failed) && q.busy ? { reason: 'busy' as const } : q.failed && q.noInput ? { reason: 'no_input' as const }
    : q.failed && q.lost ? { reason: 'lost' as const } : q.failed && q.unseen ? { reason: 'unseen' as const }
      : q.held && !q.failed && q.turn ? { reason: 'turn' as const } : {}),
  ...(q.busy && q.inputText ? { inputText: q.inputText } : {}),
  ...(q.back ? { back: true } : {}),
})

// Records read back from data/queued.json at startup: well-formed ones (a
// delivery interrupted by the restart requires explicit retry). A message older than
// QUEUED_TTL_MS comes back as not sent (sent: not seen) rather than
// vanishing, except a held terminal draft still waiting for the user; one
// older than FAILED_TTL_MS is dropped.
export function loadQueued(raw: unknown, now: number): [string, QueueEntry[]][] {
  if (!raw || typeof raw !== 'object') return []
  const out: [string, QueueEntry[]][] = []
  for (const [pane, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const ok = list.filter((q): q is QueueEntry => Boolean(q) && typeof q.id === 'string' && typeof q.text === 'string' && typeof q.at === 'number'
      && now - q.at < FAILED_TTL_MS)
      .map((q) => {
        // Older versions persisted ambiguous typed attempts as held. Never
        // resume those automatically after upgrading or restarting.
        if (q.delivering || (q.held && q.typedAt)) q = { ...q, held: false, failed: true }
        const old = !q.failed && !(q.held && q.busy) && now - q.at >= QUEUED_TTL_MS
        return { id: q.id, text: q.text, ...(typeof q.full === 'string' ? { full: q.full } : {}), ...(typeof q.submitKey === 'string' ? { submitKey: q.submitKey } : {}), at: q.at, ...(q.held && !old ? { held: true } : {}), ...(q.failed || old ? { failed: true } : {}), ...(q.busy ? { busy: true } : {}), ...(q.back ? { back: true } : {}),
          ...(typeof q.typedAt === 'number' ? { typedAt: q.typedAt } : {}), ...(q.turn && !old ? { turn: true } : {}),
          ...(q.noInput ? { noInput: true } : {}), ...(q.lost ? { lost: true } : {}), ...(q.unseen || (old && !q.held) ? { unseen: true } : {}) }
      })
    if (ok.length) out.push([pane, ok])
  }
  return out
}
