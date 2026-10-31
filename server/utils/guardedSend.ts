// Sending a message to Claude Code without gluing it to another writer's.
//
// Several writers type into the same input field: wherdr, and tools such as
// the herdr-projects ticker (`herdr agent prompt "[hp inbox] …"`). Herdr
// serializes its own `agent.prompt` calls per pane, but only until the Enter
// key is written: a Claude Code that lags (busy Pi, long session) may take
// that Enter after the next writer's text has arrived, and submits both as one
// message ("…confondu) ?[hp inbox] t-0171 new report", seen on Herdr 0.9.1 /
// Claude Code 2.1.x). `agent.prompt` also appends to any text already in the
// field. Herdr's `wait` option does not extend its lock either.
//
// So wherdr types the message itself and checks the field (read from the
// screen) at every step:
// - before typing, the field must be empty. Text already there (a draft typed
//   in the terminal, another writer's message on its way) is never cleared:
//   after a short wait the send is refused with `input_busy` and the caller
//   holds the message until the field is free;
// - after typing and before Enter, the field must hold exactly our text.
//   Text that appeared before or after it meanwhile is another writer's: the
//   field is cleared, our text typed again, and that foreign text is kept and
//   typed back as its own message right after ours (its writer already
//   believes it sent it, nobody else would);
// - after Enter, the field must empty (Claude took the message). Still our
//   text alone: Enter is pressed once more. Our text with foreign text: our
//   Enter was lost, same repair as above.
// A "!" command switches Claude to bash mode: the field then reads "!" first
// (see inputBox), so "! cmd" is checked like any other message. Claude may
// stay in bash mode, field empty ("!"), after a command ran: that field is
// free. A "!" message is typed there without its "!"; any other message
// first leaves bash mode with Backspace (checked on Claude Code 2.1.288; Esc
// would interrupt a turn), the field must read empty, then it is typed.
// Text the field shows in a way we cannot split exactly (a foreign paste
// shown as "[Pasted text #2]"…) is never cleared: sent as it is, logged.
// Claude Code reads "\" followed by Enter as a line break, not as a submit:
// the backslash goes, the cursor moves to a new line and the message stays in
// the field. A message that ends with "\" (a Windows path, a regex, a slip of
// the finger next to Enter) is therefore typed with one space after it: Enter
// then submits, and Claude drops that space, so the message is recorded with
// its backslashes intact (checked on Claude Code 2.1.296; Codex 0.162 and omp
// submit such a message as it is).
import { HerdrError } from './herdr'
import { clearKeys } from './unqueue'

export interface GuardDeps {
  // Content of the input field ('' empty), null when it is not on screen.
  box: () => Promise<string | null>
  type: (text: string) => Promise<void>
  keys: (keys: string[]) => Promise<void>
  sleep: (ms: number) => Promise<void>
  // User messages the agent recorded since `since` (ms), from its transcript:
  // tells whether another writer's Enter already submitted the field.
  sentSince?: (since: number) => Promise<string[]>
  now?: () => number
  log?: (msg: string) => void
}

export interface GuardOptions {
  // The key that ends the submission (default Enter). An alternate
  // terminator (e.g. Codex's Tab) replaces it everywhere — first press and
  // the single retry alike.
  submitKey?: string
  // Wait for an occupied field to empty before refusing (ms).
  freeWaitMs?: number
  // How long the field must stay empty before we type (ms).
  quietMs?: number
  // Wait for the typed text to show (ms).
  showWaitMs?: number
  // Wait for the field to empty after Enter (ms).
  submitWaitMs?: number
  // Extra time a lagging screen gets (a long session, a loaded machine, a
  // turn being drawn) before the send is given up and our text cleared (ms).
  lateMs?: number
  pollMs?: number
  // A text exactly ours already in the field is what an earlier attempt of
  // this same message left there: cleared, then typed again.
  retry?: boolean
}

export interface GuardResult {
  // Foreign texts taken out of our message and typed back after it.
  foreign: string[]
  // Foreign texts that could not be typed back (field busy): the caller must
  // keep them (wherdr holds them like its own messages).
  unsent: string[]
}

const DEFAULTS: Required<GuardOptions> = { submitKey: 'enter', freeWaitMs: 2000, quietMs: 400, showWaitMs: 4000, submitWaitMs: 4000, lateMs: 8000, pollMs: 50, retry: false }
// Time for the transcript to record a message just submitted (ms).
const RECORD_MS = 600
const MAX_ATTEMPTS = 3
const MAX_FOREIGN = 5
// Shortest start of our text a retry takes for its own leftover (see sendOne).
const RETRY_PART_MIN = 12

// Stand-ins Claude Code shows instead of a long paste or an image.
const PLACEHOLDER = /\[(?:Pasted text|Image) #\d+[^\]]*\]/g
const PASTE_ONLY = /^\[Pasted text #\d+[^\]]*\]$/
const compact = (s: string) => s.replace(/\s+/g, '')
// Bash mode with nothing typed in it (see inputBox).
export const BASH_EMPTY = '!'
const isFree = (box: string) => !box || box === BASH_EMPTY
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim()
// What to type so that Enter submits `text` (see the header).
export const submittable = (text: string) => (text.endsWith('\\') ? `${text} ` : text)

export type BoxState =
  | { kind: 'empty' }
  | { kind: 'exact' }
  | { kind: 'partial' } // our text, still being drawn
  | { kind: 'glued', foreign: string[] } // our text with someone else's
  | { kind: 'unknown' } // cannot be split exactly

// What the field holds, compared with the text we typed. Wrapping changes
// the spaces and line breaks the screen shows, so the comparison ignores
// whitespace; foreign text comes back with single spaces.
export function classifyBox(box: string, ours: string): BoxState {
  const b = compact(box)
  const o = compact(ours)
  if (!b) return { kind: 'empty' }
  if (b === o) return { kind: 'exact' }
  // A long message is shown as "[Pasted text #N]", photos as "[Image #N]".
  if (PASTE_ONLY.test(box.trim()) && !o.includes('[Pastedtext#')) return { kind: 'exact' }
  if (o.startsWith(b)) return { kind: 'partial' }
  const at = b.indexOf(o)
  if (at >= 0) {
    // Back to the field's own characters: indexes of the non-blank ones.
    const raw: number[] = []
    for (let i = 0; i < box.length; i++) if (!/\s/.test(box[i]!)) raw.push(i)
    const before = tidy(box.slice(0, raw[at]))
    const after = tidy(box.slice(raw[at + o.length - 1]! + 1))
    const foreign = [before, after].filter(Boolean)
    if (foreign.some(f => new RegExp(PLACEHOLDER.source).test(f))) return { kind: 'unknown' }
    return { kind: 'glued', foreign }
  }
  // Our long text as a paste stand-in, foreign text beside it.
  const pastes = box.match(PLACEHOLDER) || []
  if (pastes.length === 1 && /^\[Pasted text/.test(pastes[0]!) && !o.includes('[Pastedtext#')) {
    const [before, after] = box.split(pastes[0]!).map(tidy)
    return { kind: 'glued', foreign: [before!, after!].filter(Boolean) }
  }
  return { kind: 'unknown' }
}

// Field read twice in a row with the same content (an ongoing paste or
// redraw has settled). null: not on screen.
async function settled(d: Pick<GuardDeps, 'box' | 'sleep'>, o: Required<GuardOptions>): Promise<string | null> {
  let prev = await d.box()
  for (let i = 0; i < 20; i++) {
    await d.sleep(o.pollMs)
    const now = await d.box()
    if (now === prev) return now
    prev = now
  }
  return prev
}

// The field must stay empty for `quietMs` before we type: another writer's
// `agent.prompt` shows its text ~200 ms after it starts, and Claude takes a
// submitted message ~200 ms after its Enter; typing in either moment glues.
// Text that stays longer than `freeWaitMs` (a draft) refuses the send.
async function waitFree(d: GuardDeps, o: Required<GuardOptions>): Promise<string> {
  const now = d.now || Date.now
  const start = now()
  let emptySince: number | null = null
  for (;;) {
    const box = await d.box()
    if (box === null) throw new HerdrError('no_input', 'Agent input field not found')
    const t = now()
    emptySince = isFree(box) ? emptySince ?? t : null
    if (emptySince !== null && t - emptySince >= o.quietMs) return box
    if (box && t - start >= o.freeWaitMs) throw new HerdrError('input_busy', 'The agent’s input contains text')
    await d.sleep(o.pollMs)
  }
}

// Empties the field and checks it stays empty. Text that shows up after the
// clear is one more foreign message (kept when readable).
async function clearField(d: GuardDeps, o: Required<GuardOptions>, lines: number, foreign: string[]): Promise<string> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await d.keys(clearKeys(lines))
    await d.sleep(o.pollMs)
    const box = await settled(d, o)
    if (box === null) throw new HerdrError('no_input', 'Agent input field not found')
    if (isFree(box)) return box
    if (new RegExp(PLACEHOLDER.source).test(box)) throw new HerdrError('clear_failed', 'Agent input not cleared: check its terminal')
    foreign.push(tidy(box))
    lines = box.split('\n').length
  }
  throw new HerdrError('clear_failed', 'Agent input not cleared: check its terminal')
}

// What to type into a free field, ready for it: in an empty bash mode, a
// "!" message without its "!"; any other message once bash mode is left.
async function bashReady(d: GuardDeps, o: Required<GuardOptions>, text: string, field: string): Promise<string> {
  if (field !== BASH_EMPTY) return text
  let box: string | null
  if (text.startsWith('!')) return text.slice(1)
  d.log?.('input field left in bash mode: Backspace before typing')
  await d.keys(['backspace'])
  const start = (d.now || Date.now)()
  while ((d.now || Date.now)() - start < o.showWaitMs) {
    await d.sleep(o.pollMs)
    box = await d.box()
    if (box === '') return text
    if (box === null) throw new HerdrError('no_input', 'Agent input field not found')
    if (box !== BASH_EMPTY) throw new HerdrError('input_busy', 'The agent’s input contains text')
  }
  throw new HerdrError('bash_mode', 'The agent’s input stays in shell mode (!)')
}

// What is left of our text in the field after a send given up goes: a
// half-typed message would sit there until someone presses Enter, and the
// next writer would glue to it. Only text that is ours is cleared; text that
// is not (or no longer) ours stays. Texts that show up meanwhile join `foreign`.
async function clearOurs(d: GuardDeps, o: Required<GuardOptions>, text: string, foreign: string[]): Promise<void> {
  const box = await settled(d, o)
  if (box === null || isFree(box)) return
  const kind = classifyBox(box, text).kind
  if (kind !== 'exact' && kind !== 'partial') return
  d.log?.('send given up: our text taken out of the input')
  await clearField(d, o, box.split('\n').length + text.split('\n').length, foreign)
}

// One message, typed and submitted alone. Foreign texts removed from the
// field on the way are added to `foreign`, even when the send then fails.
// The field is read once per poll and Enter pressed as soon as it holds our
// text alone: the shorter that moment, the less room for another writer.
// A screen that lags (a long session drawing its turn, a loaded machine) gets
// `lateMs` more at each step; past it, the send is given up and our text is
// taken out of the field, never left half-typed (see clearOurs).
async function sendOne(d: GuardDeps, text: string, o: Required<GuardOptions>, foreign: string[]): Promise<void> {
  const log = d.log || (() => {})
  const now = d.now || Date.now
  const start = now()
  const lines = (box: string) => box.split('\n').length + text.split('\n').length
  // Already submitted (a late Enter, another writer's Enter)? Judged on the
  // user messages recorded since the send began, never by a substring: a
  // short "ok" is not taken because "ok so look at this" was. A message
  // counts when its whole text is ours; with `glued` (the field as read with
  // a foreign text, see separate), also when it is that glued field: ours
  // with every foreign part, nothing else.
  const recorded = async (glued?: { box: string, parts: string[] }): Promise<string | null> => {
    if (!d.sentSince) return null
    await d.sleep(RECORD_MS)
    const o = compact(text)
    const isOurs = (m: string) => {
      const c = compact(m)
      if (c === o) return true
      if (!glued) return false
      return c === compact(glued.box) || (c.length === o.length + glued.parts.reduce((n, p) => n + compact(p).length, 0)
        && c.includes(o) && glued.parts.every(p => c.includes(compact(p))))
    }
    return (await d.sentSince(start).catch(() => [])).find(isOurs) ?? null
  }
  // Free field as last read (empty, or bash mode left empty).
  let field = ''
  // Foreign text separated, field cleared: unless another writer's Enter beat
  // us to it, in which case the glued message is out and nothing is typed again.
  const separate = async (box: string, parts: string[]): Promise<boolean> => {
    const before = foreign.length
    foreign.push(...parts)
    field = await clearField(d, o, lines(box), foreign)
    const m = await recorded({ box, parts })
    if (m === null) return false
    foreign.splice(before)
    log(`another writer submitted the field before it could be separated: ${JSON.stringify(m)}`)
    return true
  }
  // Our own text left by an earlier attempt of this message (whole, or the
  // start of it drawn late): taken out first. A start too short to be told
  // from someone's draft ("the") is left alone.
  if (o.retry) {
    const box = await settled(d, o)
    const kind = box ? classifyBox(box, text).kind : 'empty'
    if (box && (kind === 'exact' || (kind === 'partial' && compact(box).length >= Math.min(RETRY_PART_MIN, compact(text).length)))) {
      log('our text from an earlier attempt still in the input: cleared before typing again')
      await clearField(d, o, lines(box), foreign)
    }
  }
  field = await waitFree(d, o)
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await d.type(submittable(await bashReady(d, o, text, field)))
    // 1. Our text shown, alone.
    let state: BoxState = { kind: 'empty' }
    let box: string | null = ''
    const typed = now()
    let looked = false
    while (now() - typed < o.showWaitMs + o.lateMs) {
      await d.sleep(o.pollMs)
      box = await d.box()
      if (box === null) throw new HerdrError('no_input', 'Agent input field not found')
      state = classifyBox(box, text)
      if (state.kind === 'glued' || state.kind === 'exact') break
      // Unknown: maybe a paste still being drawn; settled before deciding.
      if (state.kind === 'unknown' && (await settled(d, o)) === box) break
      // Still nothing: maybe taken at once by another writer's Enter.
      if (!looked && state.kind === 'empty' && now() - typed >= o.showWaitMs) {
        looked = true
        if (await recorded() !== null) return
      }
    }
    if (state.kind === 'empty' || state.kind === 'partial') {
      // Taken by another writer's Enter (our text alone: fine).
      if (state.kind === 'empty' && await recorded() !== null) return
      await clearOurs(d, o, text, foreign)
      throw new HerdrError('not_shown', 'The message did not show in the agent’s input')
    }
    if (state.kind === 'glued') {
      log(`foreign text in the input before Enter, separated: ${JSON.stringify(state.foreign)}`)
      if (await separate(box!, state.foreign)) return
      continue
    }
    const sent = box!
    if (state.kind === 'unknown') log(`input holds more than our message and cannot be split: sent as it is (${JSON.stringify(sent)})`)
    // 2. The submit key, then the field must empty.
    await d.keys([o.submitKey])
    let again = false
    let looked2 = false
    let after: BoxState = state
    const entered = now()
    while (now() - entered < o.submitWaitMs + o.lateMs) {
      await d.sleep(o.pollMs)
      box = await d.box()
      // Field gone (a menu, Claude redrawing) or emptied: taken.
      if (!box || box === BASH_EMPTY) return
      // What we submitted is still there as it was: not taken yet.
      const same = box === sent || (state.kind === 'exact' && classifyBox(box, text).kind === 'exact')
      if (!same) {
        after = state.kind === 'unknown' ? { kind: 'unknown' } : classifyBox(box, text)
        // Our text joined by another's before Claude took it.
        if (after.kind === 'glued') break
        // Only a part of our text is left: Enter changed the field instead of
        // submitting it (a line break…). Not taken, and reported as such.
        if (after.kind === 'partial') continue
        // Replaced by other text: ours was taken, another writer typed since.
        return
      }
      // Still there alone: the submit key was lost, pressed once more. Never
      // a third time: a dialog that opens meanwhile would take it as an answer.
      if (!again && now() - entered >= o.submitWaitMs / 3) {
        again = true
        log(`message still in the input after ${o.submitKey}: pressed again`)
        await d.keys([o.submitKey])
      }
      // A screen that lags behind the agent: the transcript may already have it.
      if (!looked2 && now() - entered >= o.submitWaitMs) {
        looked2 = true
        if (await recorded() !== null) { log('message recorded while the input still showed it: taken'); return }
      }
    }
    if (after.kind === 'glued') {
      log(`foreign text joined our message before it was taken, separated: ${JSON.stringify(after.foreign)}`)
      if (await separate(box!, after.foreign)) return
      continue
    }
    if (await recorded() !== null) return
    await clearOurs(d, o, text, foreign)
    throw new HerdrError('not_submitted', 'The agent did not take the message')
  }
  throw new HerdrError('input_contended', 'Another writer keeps typing into the agent’s input')
}

// Error of a send that failed after taking foreign text out of the field:
// that text is in `unsent`, for the caller to keep.
export type GuardError = HerdrError & { unsent?: string[], typed?: boolean }

// Our message, then each foreign text taken out of it, each in its own turn.
// An error carries `typed` once something went into the field: the agent may
// still take it (an Enter it handles late), so the caller looks for it in the
// transcript before typing it again. Our text is never left in the field
// (see clearOurs), except with `clear_failed`.
export async function guardedSend(d: GuardDeps, text: string, opts: GuardOptions = {}): Promise<GuardResult> {
  const o = { ...DEFAULTS, ...opts }
  const todo: string[] = []
  let typed = false
  const deps: GuardDeps = { ...d, type: (t) => { typed = true; return d.type(t) } }
  try { await sendOne(deps, text, o, todo) }
  catch (e) {
    if (todo.length) (e as GuardError).unsent = todo
    if (typed) (e as GuardError).typed = true
    throw e
  }
  const result: GuardResult = { foreign: [], unsent: [] }
  while (todo.length) {
    const f = todo.shift()!
    if (result.foreign.length >= MAX_FOREIGN) { result.unsent.push(f); continue }
    try {
      await sendOne(deps, f, o, todo)
      result.foreign.push(f)
      d.log?.(`foreign message typed back after ours: ${JSON.stringify(f)}`)
    } catch (e) {
      d.log?.(`foreign message not typed back (${(e as Error).message}): kept`)
      result.unsent.push(f, ...todo.splice(0))
    }
  }
  return result
}

// After Herdr's `agent.prompt` (text, then Enter) to Codex: the field must
// not keep our text. Codex takes Enter during a turn too (0.163: the message
// joins the running turn at once, written to its transcript right away), but
// a Codex that lags may drop the Enter. `box`: the first line of its field
// (see codexFieldLine), '' when empty. Still ours after `submitWaitMs / 3`:
// Enter once more (never a third time). Still ours past `submitWaitMs +
// lateMs` and not in the transcript: taken out of the field, and the send
// fails with `not_submitted` (typed).
export async function confirmSubmitted(d: Omit<GuardDeps, 'type'>, text: string, opts: GuardOptions = {}): Promise<void> {
  const o = { ...DEFAULTS, ...opts }
  const now = d.now || Date.now
  const start = now()
  const want = compact(text)
  // The first line of the field is the start of our text (a long one wraps;
  // a long paste shows as "[Pasted Content …]").
  const ours = (box: string | null) => Boolean(box) && (want.startsWith(compact(box!)) || (/^\[Pasted Content/.test(box!.trim()) && text.length > 200))
  // In the transcript since Herdr typed it (its Enter came before `start`): a
  // user message whose whole text is ours, never a substring ("ok" is not
  // "ok so look at this").
  const recorded = async () => {
    if (!d.sentSince) return false
    await d.sleep(RECORD_MS)
    return (await d.sentSince(start - 2000).catch(() => [])).some(m => compact(m) === want)
  }
  let again = false
  let looked = false
  while (now() - start < o.submitWaitMs + o.lateMs) {
    await d.sleep(o.pollMs)
    if (!ours(await d.box())) return
    if (!again && now() - start >= o.submitWaitMs / 3) {
      again = true
      d.log?.(`message still in the input after ${o.submitKey}: pressed again`)
      await d.keys([o.submitKey])
    }
    if (!looked && now() - start >= o.submitWaitMs) {
      looked = true
      if (await recorded()) return
    }
  }
  if (await recorded()) return
  d.log?.('send given up: our text taken out of the input')
  await d.keys(clearKeys(text.split('\n').length))
  await d.sleep(o.pollMs)
  const left = await settled(d, o)
  const err = new HerdrError(ours(left) ? 'clear_failed' : 'not_submitted', ours(left) ? 'Agent input not cleared: check its terminal' : 'The agent did not take the message')
  throw Object.assign(err, { typed: true })
}

// wherdr's own sends to a pane, one at a time.
const locks = new Map<string, Promise<unknown>>()
export function withPaneLock<T>(paneId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(paneId) || Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  const tail = run.catch(() => {})
  locks.set(paneId, tail)
  tail.then(() => { if (locks.get(paneId) === tail) locks.delete(paneId) })
  return run
}
