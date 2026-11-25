// Devin's /usage, /context and /session-stats as cards in the conversation
// (shared/devinCommandCards.ts). Devin prints their answer into its terminal
// only, never into its session store: after such a send, wherdr reads the block
// off the pane's screen and keeps the card here, the last few per pane, in memory
// (gone on restart). A card never enters Devin's transcript.
import type { ChatItem, DevinCardCommand, DevinCommandCard, Pane } from '../../shared/types'
import { devinCardBaseline, devinCardBlock, devinCardCommand, devinCardNew, devinCardText, parseDevinCard, type DevinCardBaseline } from '../../shared/devinCommandCards'
import { coreCall } from './core'
import { getPoolRuntime } from './corePool'
import { HerdrError } from './herdr'

export const CARDS_KEEP = 3
// The block is on the screen within this, counted from the send.
const WINDOW_MS = 3000
const STEP_MS = 300

interface Kept { at: number, card: DevinCommandCard }
export interface DevinCardsDeps {
  read: (p: Pane) => Promise<string>
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  windowMs?: number
  step?: number
  keep?: number
}

const cardItem = (k: Kept): ChatItem => ({ role: 'devinCard', text: devinCardText(k.card), ts: new Date(k.at).toISOString(), card: k.card })

export function createDevinCards({ read, now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), windowMs = WINDOW_MS, step = STEP_MS, keep = CARDS_KEEP }: DevinCardsDeps) {
  const kept = new Map<string, { list: Kept[], seq: number }>()
  // One send at a time per pane: the next baseline is read after the last card is kept.
  const queue = new Map<string, Promise<unknown>>()

  function keepCard(paneId: string, k: Kept) {
    const cur = kept.get(paneId)
    kept.set(paneId, { list: [...(cur?.list ?? []), k].slice(-keep), seq: (cur?.seq ?? 0) + 1 })
  }

  // The newest echo of the command, once the screen shows output of it since the baseline,
  // and its block is over. A block still being drawn is kept only once two reads in a
  // row show the same complete block, so a header never goes without its rows.
  async function capture(p: Pane, command: DevinCardCommand, base: DevinCardBaseline, at: number) {
    const deadline = now() + windowMs
    let seen: string | null = null
    for (;;) {
      const screen = await read(p).catch(() => null)
      const block = screen !== null && devinCardNew(screen, command, base) ? devinCardBlock(screen, command) : null
      // Only a block whose end is on the screen is kept: at the deadline too.
      const whole = block?.complete && block.lines.length ? block : null
      const text = whole ? whole.lines.join('\n') : null
      if (whole && (text === seen || now() >= deadline)) return keepCard(p.id, { at, card: parseDevinCard(command, whole.lines) })
      seen = text
      if (now() >= deadline) return
      await sleep(step)
    }
  }

  // A message sent to a pane: a Devin command is kept as a card once its answer is
  // on the screen. Anything else goes through as it is. Devin waiting on a dialog
  // takes the command's text and Enter as its answer, so that send is refused.
  async function sending<T>(p: Pane, text: string, send: () => Promise<T>): Promise<T> {
    const command = p.agent === 'devin' ? devinCardCommand(text) : null
    if (!command) return send()
    if (p.status === 'blocked') throw new HerdrError('blocked', 'The agent is waiting for an answer: reply in the terminal')
    const run = (queue.get(p.id) ?? Promise.resolve()).then(async () => {
      const base = await read(p).then(s => devinCardBaseline(s, command), () => null)
      const at = now()
      const result = await send()
      if (base) await capture(p, command, base, at)
      return result
    })
    queue.set(p.id, run.catch(() => {}))
    return run
  }

  // In the token of /api/chat: a kept card changes it, so an unchanged transcript is read again.
  function mark(paneId: string): string {
    const cur = kept.get(paneId)
    return cur?.list.length ? `~c${cur.seq}` : ''
  }

  // Among the bottom's items, each card after the items written before its send.
  // A card sent before the window's first item is not shown, unless the window
  // starts at the conversation's root (`root`): then nothing older exists.
  function place(paneId: string, items: ChatItem[], root = false): ChatItem[] {
    const first = items.find(i => i.ts)
    const from = root || !first ? -Infinity : Date.parse(first.ts!) || -Infinity
    const shown = (kept.get(paneId)?.list ?? []).filter(k => k.at >= from)
    if (!shown.length) return items
    const out: ChatItem[] = []
    let n = 0
    for (const it of items) {
      const t = it.ts ? Date.parse(it.ts) : NaN
      while (n < shown.length && shown[n]!.at < t) out.push(cardItem(shown[n++]!))
      out.push(it)
    }
    while (n < shown.length) out.push(cardItem(shown[n++]!))
    return out
  }

  function prune(alive: Set<string>) {
    for (const id of [...kept.keys()]) if (!alive.has(id)) kept.delete(id)
    for (const id of [...queue.keys()]) if (!alive.has(id)) queue.delete(id)
  }

  return { sending, mark, place, prune }
}

export const devinCards = createDevinCards({
  read: async (p) => {
    const rt = getPoolRuntime()
    if (rt) {
      const entry = rt.forPane(p.id)
      if (!entry) return ''
      return String((await entry.call<{ text?: string }>('terminal.read', { terminal: p.coreAddress, lines: 0 }, 4000)).text || '')
    }
    const endpoint = process.env.HC_SOCKET
    if (!endpoint) return ''
    return String((await coreCall<{ text?: string }>(endpoint, 'terminal.read', { terminal: p.coreAddress, lines: 0 }, 4000)).text || '')
  },
})
