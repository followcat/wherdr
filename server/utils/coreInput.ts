// Composer, keys, interrupt and stop on herdr-core: terminal.send / keys /
// interrupt / kill on the pane's full core address. Never retried: a timeout
// does not prove the text or key did not reach the program.
import { coreCall, CoreError } from './core'
import { HerdrError } from './herdr'
import { keepPastes } from './pastes'
import { fieldGap, fieldHolds, fieldHoldsRawPhoto, isBareBang, isSlashCommand, uploadNames } from '../../shared/queuedMatch'
import { corePaint, pasting, readDraft, sameText } from './coreDraft'
import { noteSubmitting, type Submitting } from './submitting'
import { clearKeys } from './unqueue'
import { inTurn, typingInto } from './terminalTurns'
import { devinCards } from './devinCards'
import type { Pane } from '../../shared/types'

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>
export interface CoreInputDeps {
  call: Call
  pane: (id: string) => Pane | undefined
  panes: () => Pane[]
  refresh: () => void
  /** After a Stop from the conversation: the prompt Claude put back into its field, taken out of it. */
  takeBack?: (p: Pane) => Promise<{ text: string, lost: number } | null>
  /** Claude: text in its input field now (its gray suggestion left out), null when empty. */
  field?: (p: Pane) => Promise<string | null>
  /** Notes a message to Claude being submitted, for a restart to resume it (submitting.ts); returns what forgets it. */
  submitting?: (terminal: string, text: string) => () => void
  settleMs?: number
  /** Longest wait for a message's photos to show, from its paste (PHOTO_WAIT_MS). */
  photoWaitMs?: number
  /** Longest time before typing starts (its turn, the looks at the field), from the request (START_BY_MS). */
  startByMs?: number
  /** Quiet time after a send before the next writer of the terminal (see terminalTurns.ts). */
  turnSettleMs?: number
  /** Devin's /usage, /context, /session-stats: the send, and the card read off the screen after it (devinCards.ts). */
  card?: <T>(p: Pane, text: string, send: () => Promise<T>) => Promise<T>
}

const KEY_RE = /^[a-z0-9+\-]{1,24}$/i
const MAX_TEXT = 256 * 1024

export function coreInputDeps(): CoreInputDeps {
  return {
    call: (method, params, timeout) => {
      const endpoint = process.env.HC_SOCKET
      if (!endpoint) return Promise.reject(new CoreError('unavailable', 'Missing core endpoint'))
      return coreCall(endpoint, method, params, timeout)
    },
    pane: id => findPane(id),
    panes: () => getState().panes,
    refresh: () => { setTimeout(() => { void poll() }, 100) },
    field: async (p) => {
      const endpoint = process.env.HC_SOCKET || ''
      const plain = String(((await coreCall(endpoint, 'terminal.read', { terminal: p.coreAddress, lines: 0 }, 4000)) as { text?: string }).text || '')
      const seen = readDraft(plain, p.agent)
      // The plain screen draws Claude's gray suggestion like typed text: the colored one tells them apart.
      const typed = seen && readDraft(await corePaint(endpoint, p.coreAddress || ''), p.agent)
      if (typed && sameText(typed.text, seen.text)) return typed.text
      // Empty while Claude takes in a paste: not read yet, the text is coming.
      if (pasting(plain)) throw new HerdrError('pasting', 'Claude is still pasting')
      return null
    },
    submitting: noteSubmitting,
    card: devinCards.sending,
    takeBack: (p) => {
      const call = (method: string, params: object, t: number) => coreCall(process.env.HC_SOCKET || '', method, params, t)
      return takeBackFromClaude(p, {
        // Core's plain screen: Claude's field starts with "❯" + a space (a non-breaking one in ANSI).
        screen: async () => String(((await call('terminal.read', { terminal: p.coreAddress, lines: 0 }, 4000)) as { text?: string }).text || '').replace(/^❯ /gm, '❯\u00a0'),
        keys: async (keys) => { await call('terminal.keys', { terminal: p.coreAddress, keys }, 10000) },
      }).then(item => (item ? takeBack(p.id, item) : null))
    },
  }
}

function target(deps: CoreInputDeps, id: unknown) {
  const p = typeof id === 'string' ? deps.pane(id) : undefined
  if (!p?.coreAddress) throw new HerdrError('bad_pane', 'Pane not found')
  return p
}

// Core's stable error kinds, as the interface's messages.
export function failure(e: unknown): never {
  if (e instanceof HerdrError) throw e
  const kind = e instanceof CoreError ? e.kind : 'internal'
  if (kind === 'not_found' || kind === 'finished') throw new HerdrError('stale', 'This terminal has ended')
  if (kind === 'blocked') throw new HerdrError('blocked', 'The agent is waiting for an answer: reply in the terminal')
  if (kind === 'name_taken') throw new HerdrError('name_taken', 'A terminal with this name already exists')
  if (kind === 'spawn_failed') throw new HerdrError('spawn_failed', 'The program could not start: check the folder and that it is installed')
  if (kind === 'timeout') throw new HerdrError('timeout', 'herdr-core did not confirm in time: check the terminal before sending again')
  if (kind === 'unreachable' || kind === 'machine_unknown') throw new HerdrError('unreachable', 'The machine of this terminal is unreachable')
  if (kind === 'unavailable') throw new HerdrError('unreachable', 'herdr-core is unreachable')
  // Lost during a call: the request may have reached herdr-core (see coreHeld.ts).
  if (kind === 'disconnected') throw Object.assign(new HerdrError('unreachable', 'herdr-core is unreachable'), { unconfirmed: true })
  throw new HerdrError(kind, e instanceof Error ? e.message : 'herdr-core rejected the request')
}

// Message from the composer: pasted, then submitted with Enter once nobody types.
// It waits its turn behind wherdr's other writers of this terminal (a wake
// being typed, see terminalTurns.ts), then goes.
// Claude: never typed into an input field that already holds text (a message
// left there, a draft typed in the terminal): Claude would submit both as one
// message. It is refused instead, and the conversation shows that text with
// Send now / Clear (see coreDraft.ts): the user decides, then sends again.
export async function coreSend(deps: CoreInputDeps, b: { pane_id?: unknown, text?: unknown, pastes?: unknown }) {
  const p = target(deps, b.pane_id)
  const text = typeof b.text === 'string' ? b.text : ''
  if (!text.trim() || isBareBang(text)) throw new HerdrError('empty', 'Empty message')
  if (text.length > MAX_TEXT) throw new HerdrError('too_large', 'Message too large')
  const waited = typingInto(p.coreAddress!)
  const queuedAt = Date.now()
  // Bounded under the app's SEND_DEADLINE_MS (app/utils/outbox.ts, 120 s).
  // Not typed within START_BY_MS (its turn behind another writer, the looks at
  // a busy field): refused, nothing typed, and its turn, when it comes, does
  // nothing. Once typed, every step has its own timeout (about 30 s at most,
  // a terminal.send) and none starts after SEND_BUDGET_MS: no look, clear,
  // Backspace or Enter, nor a second paste without 30 s left (the message
  // stays in the field, with Send now / Clear).
  const startBy = queuedAt + (deps.startByMs ?? START_BY_MS)
  const late = () => new HerdrError('busy', 'Another message to this terminal took too long: nothing was typed, send again.')
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const turn = inTurn(p.coreAddress!, () => {
    clearTimeout(timer)
    if (expired || Date.now() >= startBy) throw late()
    return typeIn(deps, p, text, b.pastes, waited, startBy, queuedAt + SEND_BUDGET_MS)
  }, deps.turnSettleMs)
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(late()) }, Math.max(0, startBy - Date.now()))
  })
  // The timer only refuses a request still waiting for its turn: once typing started it is cleared.
  const send = () => Promise.race([turn, deadline])
  return deps.card ? deps.card(p, text, send) : send()
}
const START_BY_MS = 25_000
// The longest step started before it (a key and a field read, ~27 s) still ends under 120 s.
export const SEND_BUDGET_MS = 85_000
const PASTE_STEP_MS = 30_000

// Claude turns a pasted photo path into "[Image #N]" a moment after the
// paste; core's Enter right after it may come first, and Claude then submits
// the path as plain text (WHR-440, mostly after a few idle minutes). A lone
// "\" ends the paste: Claude reads "\" + Enter as a new line, never as a
// submit, and the message waits in its field until submitLeftInput sees each
// photo as its placeholder and presses Enter.
export const holdEnter = (text: string) => (uploadNames(text).length ? `${text}\n\\` : text)

// Behind another writer (or just after it), Claude may still be taking its
// text out of the field: a few looks before calling the field busy.
const BUSY_LOOKS = 5

async function typeIn(deps: CoreInputDeps, p: Pane, text: string, pastes: unknown, waited: boolean, startBy = Infinity, until = Infinity) {
  const field = p.agent === 'claude' ? deps.field : undefined
  // A failed read (Claude still taking in a paste included) is no empty field:
  // looked at again, then refused, never typed over.
  for (let i = 0; field; i++) {
    const seen = await field(p).then(t => (t ? 'text' : null), (e: unknown) => e)
    if (seen === null) break
    if (Date.now() >= startBy) throw new HerdrError('input_busy', 'Claude’s input could not be confirmed empty in time: nothing was typed, send again.')
    if (seen === 'text' ? !waited || i >= BUSY_LOOKS : i >= BUSY_LOOKS) {
      if (seen === 'text' || (seen as HerdrError)?.code === 'pasting') throw new HerdrError('input_busy', 'Claude’s input still holds text that was not sent: send it or clear it first, then send again.')
      failure(seen)
    }
    await new Promise(res => setTimeout(res, deps.settleMs ?? 400))
  }
  if (!isSlashCommand(text)) keepPastes(text, pastes)
  // Noted before the send: a restart during it or during the Enters resumes it.
  const forget = field && deps.submitting ? deps.submitting(p.coreAddress!, text) : () => {}
  try {
    const send = () => deps.call<{ started?: boolean | null, status?: string | null }>('terminal.send', { terminal: p.coreAddress, text: field ? holdEnter(text) : text }, 30000)
    // The photo wait counts from here: before core's send returns (WHR-472).
    const pastedAt = Date.now()
    const r = await send()
    let started = r?.started ?? null
    // Claude takes a multi-line send (photo lines, text + "\n@file") as a paste and
    // may leave it in its input: core reports no turn started. A large photo is
    // read and resized before its "[Image #N]" shows, and an Enter pressed before
    // that is lost. Our text alone there, each photo as its placeholder (also
    // during a turn, where Enter queues it): Enter, again while it stays.
    // `started` is "went working within a few seconds": sent while Claude was
    // already working (or ending its turn), it is true whether or not Claude
    // took the message (WHR-398). So the field is always looked at: empty, the
    // message was taken; holding it, it is submitted (WHR-413).
    if (field) {
      const enters = await submitLeftInput(deps, p, field, text, async () => { await send() }, pastedAt, until)
      if (enters) started = null // unconfirmed: Enter pressed, no turn observed yet
    } else if (p.agent === 'claude' && started === false && text.includes('\n')) {
      // Without a field reading: on an empty input, one more Enter is harmless.
      // Claude only: other agents (Command Code included) keep whatever they observed.
      await new Promise(res => setTimeout(res, deps.settleMs ?? 400))
      const t = await deps.call<{ status?: string | { state?: string } | null }>('terminal.get', { terminal: p.coreAddress }, 3000).catch(() => null)
      const state = typeof t?.status === 'string' ? t.status : t?.status?.state
      if (state === 'idle' || state === 'done') {
        await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['enter'] }, 10000)
        started = null // unconfirmed: Enter pressed, no turn observed yet
      }
    }
    return { ok: true, started }
  } catch (e) { failure(e) } finally { forget(); deps.refresh() }
}

// After a restart: the sends it interrupted are submitted the same way, only
// if Claude's field holds that message alone (never twice). One at a time per
// terminal, in the order they were sent.
export async function resumeSubmitting(deps: CoreInputDeps, list: Submitting[]) {
  const field = deps.field
  if (!field) return
  const terminals = [...new Set(list.map(s => s.terminal))]
  await Promise.all(terminals.map(async (terminal) => {
    for (const s of list.filter(x => x.terminal === terminal)) {
      const p = { id: terminal, coreAddress: terminal, agent: 'claude' } as Pane
      const forget = deps.submitting ? deps.submitting(terminal, s.text) : () => {}
      try {
        console.warn(`[wherdr] message to ${terminal}: resumed after a restart`)
        await submitLeftInput(deps, p, field, s.text)
      } catch { /* the field's own "Not sent" remains */ } finally { forget(); deps.refresh() }
    }
  }))
}

// Looks at Claude's field after a send: up to this many, settleMs apart,
// for the photos to show, and never longer than PHOTO_WAIT_MS from the paste:
// a slow field read (an idle Claude) never stretches the wait to minutes.
const SUBMIT_LOOKS = 60
// 18 s from the first paste, whatever happens meanwhile (clears, a second
// paste): then the message goes as it is (its photo as a path), or is refused
// for Retry when its field could not be confirmed (WHR-472). It is cleared
// and pasted again only with AGAIN_WAIT_MS still left for that paste to show;
// otherwise it goes as it is at once.
export const PHOTO_WAIT_MS = 18_000
const AGAIN_WAIT_MS = 6_000
// Claude Code (2.1.319) checks a pasted photo path, then reads it, each
// within 1 s; one that misses it (its process slowed after an idle, a loaded
// machine) is put in the field as typed text, never turned into an image
// later (WHR-454). Seen there this many looks in a row (about 1.6 s), the
// message is cleared and pasted once more: the file and Claude are warm now.
const RAW_LOOKS = 4
// Clears pressed at most to empty the field before that second paste.
const CLEARS = 3
// After each Enter, the look that decides on the next one, in settleMs: the
// field may still be drawing, or Claude switching turns, and drop an Enter.
// After a long idle, Claude ignored Enter for 2-3 s with "[Image #N]" already
// shown (WHR-413): Enters keep coming for about 16 s.
const RESUBMIT_AFTER = [1, 2, 3, 4, 5, 5, 5, 5, 5, 5]

// Our message left in Claude's field: waits (bounded) until the field holds
// it whole, placeholders included, then presses Enter, and again (backing
// off, at most RESUBMIT_AFTER.length times) while it holds our message alone.
// The field was empty before the send, so other text there is ours still
// being drawn (a photo path not yet an "[Image #N]"); Enter is never pressed
// on it. Never sent twice: the field holds one copy, and an empty field (the
// message taken, or queued during a turn) ends it; an empty field under
// "Pasting…" is not read yet (WHR-419). Returns the Enters pressed.
// A photo left as its path: pasted `again` once (RAW_LOOKS); still a path
// then, or when the wait ends, the message goes as it is, which the agent
// can still open, the lone "\" of holdEnter taken out first (WHR-454).
async function submitLeftInput(deps: CoreInputDeps, p: Pane, field: (p: Pane) => Promise<string | null>, text: string, again?: () => Promise<void>, pastedAt = Date.now(), until = Infinity): Promise<number> {
  const settle = deps.settleMs ?? 400
  const started = pastedAt
  const waitMs = deps.photoWaitMs ?? PHOTO_WAIT_MS
  const deadline = started + waitMs
  let last: string | undefined
  let raw = false
  const look = async (times = 1) => {
    await new Promise(res => setTimeout(res, settle * times))
    // A failed read is no empty field: not taken, no Enter on it either.
    const now = await field(p).catch(() => undefined)
    if (now) last = now
    return now === '' ? null : now
  }
  const holds = async (times = 1) => {
    const now = await look(times)
    return now === undefined ? false : now ? fieldHolds(now, text, true) || (raw && fieldHoldsRawPhoto(now, text)) : null
  }
  // Evidence for the next report: sizes, never the text.
  const why = () => (last === undefined ? 'field never read with text' : `field held ${fieldGap(last, text)}`)
  const keys = (k: string[]) => deps.call('terminal.keys', { terminal: p.coreAddress, keys: k }, 10000)
  // Cleared to be pasted again, the message is only in wherdr: a field never
  // seen empty after that is refused, so the conversation offers Retry with it whole.
  const lost = () => new HerdrError('not_submitted', 'The photo could not be added and the message was taken out of Claude’s input: send it again.')
  // The wait ended on a field never seen holding our message alone: it may
  // hold part of it, or other text. Refused, so the conversation says "Not
  // sent" (its Retry is refused while the field holds text, which then shows
  // with Send now / Clear), never "Sending…" for good (WHR-472).
  const giveUp = (clearing: number): never => {
    console.warn(`[wherdr] message to ${p.coreAddress}: not submitted after ${Date.now() - started} ms, ${clearing ? 'its field never seen empty after a clear' : 'never held the message alone'}: ${why()}`)
    if (clearing) throw lost()
    throw new HerdrError('not_submitted', 'Claude’s input did not show the message in time: check the terminal, then send it again.')
  }
  // Wait for it whole (null: the field emptied, the message was taken). Every
  // decision is on the latest read; a failed read decides nothing.
  const over = (need = 0) => Date.now() + need >= until
  for (let i = 0, rawLooks = 0, clearing = 0; ; i++) {
    if (i >= SUBMIT_LOOKS || over()) giveUp(clearing)
    const now = await look()
    const late = i + 1 >= SUBMIT_LOOKS || Date.now() >= deadline
    if (now === undefined) {
      if (late) giveUp(clearing)
      continue
    }
    if (clearing) {
      // Pasted again only on a field seen empty: never twice in it.
      // The wait is over before the field emptied: the message is no longer whole there, refused for Retry.
      if (late) giveUp(clearing)
      if (now === null) {
        if (over(PASTE_STEP_MS)) giveUp(clearing)
        console.warn(`[wherdr] message to ${p.coreAddress}: a photo stayed a path after ${Date.now() - started} ms, pasted again`)
        const paste = again!
        again = undefined
        clearing = rawLooks = 0
        last = undefined
        await paste()
        continue
      }
      // What is left is ours (the field held our message alone): cleared again, a few times.
      if (clearing >= CLEARS) {
        console.warn(`[wherdr] message to ${p.coreAddress}: not submitted, its field could not be emptied to paste it again: ${why()}`)
        throw lost()
      }
      await keys(clearKeys(now.split('\n').length))
      clearing++
      continue
    }
    if (now === null) return 0
    if (fieldHolds(now, text, true)) break
    rawLooks = fieldHoldsRawPhoto(now, text) ? rawLooks + 1 : 0
    if (rawLooks >= RAW_LOOKS && again && deadline - Date.now() >= Math.min(AGAIN_WAIT_MS, waitMs / 3) && !over(PASTE_STEP_MS)) {
      await keys(clearKeys(now.split('\n').length))
      clearing = 1
      continue
    }
    if (!rawLooks && late) giveUp(0)
    if (rawLooks >= RAW_LOOKS || (rawLooks && late)) {
      raw = true
      const gap = fieldGap(now, text)
      // The lone "\" (and only it): one Backspace at a time while the field
      // ends with it; Enter only on a field read holding our message whole.
      for (let k = 0, cur = now; /\\\s*$/.test(cur); k++) {
        if (over()) {
          console.warn(`[wherdr] message to ${p.coreAddress}: not submitted, out of time while its "\\" was taken out: ${why()}`)
          return 0
        }
        if (k < 3) await keys(['backspace'])
        const after = k < 3 ? await look() : undefined
        if (after === null) return 0
        if (after === undefined || !fieldHoldsRawPhoto(after, text)) {
          console.warn(`[wherdr] message to ${p.coreAddress}: not submitted, its field changed while its "\\" was taken out: ${why()}`)
          return 0
        }
        cur = after
      }
      console.warn(`[wherdr] message to ${p.coreAddress}: a photo stayed a path, sent as it is after ${Date.now() - started} ms: field held ${gap}`)
      break
    }
  }
  let enters = 0
  let left = true
  for (const after of RESUBMIT_AFTER) {
    if (Date.now() >= until) break
    await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['enter'] }, 10000)
    enters++
    if (!await holds(after)) { left = false; break }
  }
  // Evidence for the next report, no message text.
  if (left || enters > 1) console.warn(`[wherdr] message to ${p.coreAddress}: ${left ? `still in input after ${enters} Enters: ${why()}` : `submitted after ${enters} Enters`}`)
  return enters
}

// Raw route: text + Enter is a message, named keys go through terminal.keys.
export async function coreInput(deps: CoreInputDeps, b: { pane_id?: unknown, text?: unknown, keys?: unknown }) {
  const keys = Array.isArray(b.keys) ? b.keys : []
  if (typeof b.text === 'string' && b.text) {
    if (keys.length !== 1 || keys[0] !== 'enter') throw new HerdrError('unsupported', 'Type this text in the terminal')
    return coreSend(deps, b)
  }
  const p = target(deps, b.pane_id)
  if (!keys.length || keys.length > 32 || !keys.every(k => typeof k === 'string' && KEY_RE.test(k))) throw new HerdrError('bad_keys', 'Invalid keys')
  try {
    await deps.call('terminal.keys', { terminal: p.coreAddress, keys }, 10000)
    return { ok: true }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// Stop button: the stop key, then what core observed. Never escalates to a kill.
export async function coreInterrupt(deps: CoreInputDeps, b: { pane_id?: unknown, restore?: unknown }) {
  const p = target(deps, b.pane_id)
  try {
    const r = await deps.call<{ outcome: string }>('terminal.interrupt', { terminal: p.coreAddress, timeout: 10 }, 15000)
    const stopped = r.outcome === 'stopped' || r.outcome === 'exited'
    // Claude puts the message it had not sent back into its field: it leaves the
    // conversation and returns to wherdr's field (see interruptRestore.ts).
    const back = stopped && b.restore === true && p.agent === 'claude' && deps.takeBack ? await deps.takeBack(p).catch(() => null) : null
    return { ok: true, outcome: r.outcome, stopped, background: 0, shell: !p.agent, ...(back ? { restored: back.text, ...(back.lost ? { lost: back.lost } : {}) } : {}) }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// Close: ends the program (hangup, terminate, kill). A group ends each of its
// terminals. Each is removed right after: an explicit close leaves no
// `finished` (reason 'killed') tombstone in herdr-core.
export async function coreKill(deps: CoreInputDeps, b: { pane_id?: unknown, close_group?: unknown }) {
  const p = target(deps, b.pane_id)
  const list = b.close_group === true ? deps.panes().filter(x => x.workspace === p.workspace && x.coreAddress) : [p]
  try {
    for (const x of list) {
      await deps.call('terminal.kill', { terminal: x.coreAddress }, 15000)
      await deps.call('terminal.rm', { terminal: x.coreAddress }, 5000).catch(() => {})
    }
    return { ok: true }
  } catch (e) { failure(e) } finally { deps.refresh() }
}

// "Keep after restart": a kept terminal comes back as a shell when core restarts or loses it.
// terminal.list does not carry the flag, so it is read on demand with terminal.get.
export async function coreKeepGet(deps: CoreInputDeps, id: unknown) {
  const p = target(deps, id)
  try {
    const t = await deps.call<{ keep?: boolean }>('terminal.get', { terminal: p.coreAddress }, 5000)
    return { keep: t.keep === true }
  } catch (e) { failure(e) }
}

export async function coreKeepSet(deps: CoreInputDeps, b: { pane_id?: unknown, keep?: unknown }) {
  if (typeof b.keep !== 'boolean') throw new HerdrError('bad_keep', 'Invalid value')
  const p = target(deps, b.pane_id)
  try {
    await deps.call('terminal.keep', { terminal: p.coreAddress, keep: b.keep }, 5000)
    return { keep: b.keep }
  } catch (e) { failure(e) }
}
