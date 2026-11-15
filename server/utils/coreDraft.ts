// Text left unsent in Claude Code's own input box on herdr-core (WHR-286): a
// paste or a draft never submitted, or the prompt Claude put back after an
// interrupt. The conversation shows it as "Not sent" with Send now / Clear.
// Claude's own queue ("ctrl+enter to send now" under a queued message) gets
// Send now too. Every action re-reads the screen first and refuses a box that
// changed since it was shown.
import { HerdrError } from './herdr'
import { failure, type CoreInputDeps } from './coreInput'
import { readCoreScreen } from './coreScreen'
import { clearKeys, inputBox } from './unqueue'
import { parseClaudeScreen } from './claudeScreen'
import { openFramed, FRAME } from './coreFramed'
import type { CoreDraft, Pane } from '../../shared/types'

// Core's screen (terminal.read) is plain text. It keeps the non-breaking space
// Claude puts after the "❯" of its field (sent messages above have a normal one),
// so inputBox finds the field, and its placeholder ('Try "…"') reads empty. But
// Claude's gray next-message suggestion ("commit it" after a turn) is the same
// bytes there as typed text. So the plain screen only nominates a draft, and the
// colored screen (the first paint of terminal.attach, see corePaint) confirms
// it: there the suggestion is drawn dim, which inputBox leaves out.

/**
 * Pure: text in Claude's field, or null. On the plain screen it is only a
 * candidate; on the colored screen (dim text left out) it is the draft.
 */
export function readDraft(text: string, agent: string | null | undefined): CoreDraft | null {
  if (agent !== 'claude') return null
  const box = inputBox(text)
  if (!box || box === '!') return null
  return { text: box, lines: box.split('\n').length }
}

const norm = (t: string) => t.replace(/\s+/g, '')
export const sameText = (a: string, b: string) => norm(a) === norm(b)

/** The colored screen of a terminal: the first paint of a passive attach at its own size. */
export async function corePaint(endpoint: string, address: string, quietMs = 150, maxMs = 2500): Promise<string> {
  const c = await openFramed(endpoint)
  try {
    const t = await c.call<{ cols: number, rows: number }>('terminal.get', { terminal: address })
    const chunks: Buffer[] = []
    let last = 0
    const a = await c.call<{ channel: number }>('terminal.attach', { terminal: address, cols: t.cols, rows: t.rows, history: 0 })
    c.stream(a.channel, (kind, payload) => {
      if (kind !== FRAME.DATA) return
      chunks.push(Buffer.from(payload))
      last = Date.now()
    })
    const start = Date.now()
    while (Date.now() - start < maxMs && (!last || Date.now() - last < quietMs)) await new Promise(r => setTimeout(r, 25))
    if (!chunks.length) throw new HerdrError('timeout', 'herdr-core did not paint the screen in time')
    return Buffer.concat(chunks).toString('utf8')
  } finally { c.close() }
}

/** Pure: Claude offers to send its queued messages now (ctrl+enter). */
export function queueSendNow(text: string, agent: string | null | undefined): boolean {
  return agent === 'claude' && Boolean(parseClaudeScreen(text)?.sendNow)
}

export interface CoreDraftDeps extends CoreInputDeps {
  read: (p: Pane) => Promise<string>
  /** Colored screen (see corePaint). */
  colors: (p: Pane) => Promise<string>
  sleep?: (ms: number) => Promise<void>
}
type Body = { pane_id?: unknown, action?: unknown, text?: unknown }

const changed = () => new HerdrError('stale', 'Claude’s input has changed — check the current screen.')

// One action at a time per pane: the same one asked again (a second tap, a
// second device) shares the run in flight, so nothing is ever sent twice;
// another one (Clear during Send now) is refused.
const inFlight = new Map<string, { key: string, run: Promise<{ ok: true, started?: boolean }> }>()

export function coreDraft(deps: CoreDraftDeps, b: Body): Promise<{ ok: true, started?: boolean }> {
  const id = typeof b.pane_id === 'string' ? b.pane_id : ''
  const key = `${String(b.action)}\n${typeof b.text === 'string' ? b.text : ''}`
  const now = inFlight.get(id)
  if (now) return now.key === key ? now.run : Promise.reject(new HerdrError('busy', 'Another action on this message is still running.'))
  const run = draftAction(deps, b).finally(() => inFlight.delete(id))
  inFlight.set(id, { key, run })
  return run
}

async function draftAction(deps: CoreDraftDeps, b: Body): Promise<{ ok: true, started?: boolean }> {
  const p = typeof b.pane_id === 'string' ? deps.pane(b.pane_id) : undefined
  if (!p?.coreAddress) throw new HerdrError('bad_pane', 'Pane not found')
  if (p.agent !== 'claude') throw new HerdrError('unsupported', 'Only for Claude Code')
  const action = b.action
  if (action !== 'send' && action !== 'clear' && action !== 'send-queued') throw new HerdrError('bad_action', 'Invalid action')
  const sleep = deps.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)))
  const keys = (k: string[]) => deps.call('terminal.keys', { terminal: p.coreAddress, keys: k }, 10000)
  const turn = async () => (await deps.call<{ turn?: number, status?: string | { state?: string } | null }>('terminal.get', { terminal: p.coreAddress }, 3000).catch(() => null))
  // The colored screen: a gray suggestion is no text of the field.
  const field = async () => readDraft(await deps.colors(p), p.agent)
  try {
    if (action === 'send-queued') {
      if (!queueSendNow(await deps.read(p), p.agent)) throw new HerdrError('stale', 'The screen has changed — check the current screen.')
      await keys(['ctrl+enter'])
      // Done once Claude no longer offers it: its queue was taken.
      for (let i = 0; i < 8; i++) {
        await sleep(400)
        if (!queueSendNow(await deps.read(p).catch(() => ''), p.agent)) return { ok: true }
      }
      throw new HerdrError('not_submitted', 'Claude still holds the queued message — check the terminal.')
    }
    const draft = await field()
    if (!draft || typeof b.text !== 'string' || !sameText(draft.text, b.text)) throw changed()
    if (action === 'clear') {
      for (let i = 0; i < 2; i++) {
        await keys(clearKeys(draft.lines))
        await sleep(150)
        const now = await field()
        if (!now) return { ok: true }
        // Someone is typing in the terminal: their new text is left alone.
        if (!sameText(now.text, draft.text)) break
      }
      throw new HerdrError('clear_failed', 'Claude’s input could not be emptied — check the terminal.')
    }
    // Send now: Enter, then the box must empty and a turn start (spinner,
    // core's working status or a new turn number).
    const before = (await turn())?.turn
    await keys(['enter'])
    let emptied = false
    let started = false
    for (let i = 0; i < 8 && !(emptied && started); i++) {
      await sleep(400)
      if (!emptied) emptied = await field().then(d => !d || !sameText(d.text, draft.text), () => false)
      const now = await deps.read(p).catch(() => '')
      const t = await turn()
      const state = typeof t?.status === 'string' ? t.status : t?.status?.state
      started = readCoreScreen(now, p.agent, null).status === 'working' || state === 'working'
        || (typeof before === 'number' && typeof t?.turn === 'number' && t.turn > before)
    }
    if (!emptied) throw new HerdrError('not_submitted', 'Enter was pressed but the text is still in Claude’s input — check the terminal.')
    return { ok: true, started }
  } catch (e) { failure(e) } finally { deps.refresh() }
}
