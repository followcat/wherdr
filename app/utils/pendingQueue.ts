// Messages sent but not yet in the conversation (dotted bubbles under it):
// wherdr's own records (server and local sends) + Claude's own queue
// (messages typed on the computer while it works), without duplicates, each
// with its photos and its phase (see shared/queuedPhase.ts).
//
// Photos alone have no text: their record is matched by its photos (see
// shared/queuedMatch.ts). Claude's queue only keeps "[Image #1]": an entry of
// it gets the photos of wherdr's record of the same message, from the server
// (`sent`, see server/utils/sentHistory.ts) or remembered here.
import type { ChatItem, ClaudeQueueEntry, ClaudeScreen, QueuedMessage } from '../../shared/types'
import type { OutboxItem } from './outbox'
import { type QueuedPhase, queuedPhases } from '../../shared/queuedPhase'
import { photosLanded, photosOnly, uploadNames, withoutUploads } from '../../shared/queuedMatch'
import { sameSent } from '../../shared/reference'

export interface PendingMessage {
  id: string
  // Text as sent (photo lines included), for Cancel.
  raw: string
  // Sent from wherdr (Claude's own entries have ids "cc-…").
  mine: boolean
  phase: QueuedPhase
  // 'sending': shown from the tap, the server has not answered yet (see outbox.ts).
  state: 'held' | 'failed' | 'sending' | null
  // Never reached the server: Retry / Cancel act on the app's copy.
  local?: boolean
  // 'busy': waiting because the agent's input field holds other text.
  inputText?: string
  reason?: QueuedMessage['reason']
  // Stored names of its photos.
  photos: string[]
  // Photos Claude's queue counts but whose files are unknown.
  missing: number
  // Long pasted texts of `raw`, as the server lists them (QueuedMessage.pasted).
  pasted?: string[]
}

const normText = (s: string) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
// `text` holds the message `sent`: the same reference at its start, then the
// first words of `sent` (see sameSent).
const holds = (text: string, sent: string) => sameSent(normText(text), normText(sent), (a, b) => a.includes(b.slice(0, 60)))

// Whether a rendered queue item's raw text is the given on-screen queue
// row — the same match the merge uses. Devin's Cancel only exists for its
// newest row, so the button hides on anything older.
export const queuedRowMatches = (raw: string, screenEntry: string) => holds(raw, screenEntry)

// Records with photos seen for a pane (most recent last), to give Claude's
// entries their photos. Plain memory of this page, outside reactivity.
const MEMORY = 30
const memories = new Map<string, OutboxItem[]>()
export function rememberSent(paneId: string, list: OutboxItem[]): OutboxItem[] {
  const out = (memories.get(paneId) || []).filter(m => !list.some(q => q.id === m.id))
  out.push(...list.filter(q => uploadNames(q.text).length))
  memories.set(paneId, out.slice(-MEMORY))
  return memories.get(paneId)!
}

export function pendingQueue(o: {
  mine: OutboxItem[]
  claude: ClaudeQueueEntry[]
  items: ChatItem[]
  screen: ClaudeScreen | null
  memory?: OutboxItem[]
  // Agent idle with nothing holding it back: Claude has emptied its queue.
  idle?: boolean
}): PendingMessage[] {
  // Already in the conversation (the server has not noticed yet): we do not
  // show two copies. "! cmd" appears there as a command without "!" (omp:
  // also "!!cmd", "$ code").
  const inChat = (q: OutboxItem) => {
    const after = (i: ChatItem) => !q.at || !i.ts || Date.parse(i.ts) >= q.at - 10000
    if (photosOnly(q.text)) return o.items.some(i => after(i) && photosLanded(q.text, i))
    const sent = withoutUploads(q.text)
    const nb = normText(q.text.replace(/^\s*(?:!!?|\$\$?)\s*/, '')).slice(0, 60)
    return Boolean(normText(sent)) && o.items.some(i => after(i)
      && (i.role === 'user' ? holds(i.text, sent) : i.role === 'bash' && Boolean(nb) && normText(i.text).includes(nb)))
  }
  // Sending order, whatever the source (server or local send).
  const mine = [...o.mine].sort((a, b) => (a.at && b.at ? a.at - b.at : 0))
  const list: (OutboxItem & { missing?: number })[] = mine.filter(q => !inChat(q))
  // Claude's entries: one of wherdr's records (listed, or already in the
  // conversation) is the same message. Photos alone: one entry per record
  // still waiting in Claude's queue (not held here, not already sent).
  const minePhases = queuedPhases(list.map(q => q.text), o.screen)
  let ownPhotos = list.filter((q, i) => photosOnly(q.text) && !q.state && minePhases[i] === 'queued').length
  const memPhotos = (o.memory || []).filter(m => photosOnly(m.text) && !mine.some(q => q.id === m.id))
  // wherdr did not send these: shown only while Claude may still read them
  // (never once idle), and not once in the conversation (a scheduled prompt
  // shows there as a note).
  for (const q of o.idle ? [] : o.claude) {
    const images = q.images || 0
    if (!q.text) {
      if (!images) continue
      if (ownPhotos > 0) { ownPhotos--; continue }
      // Remembered ones are taken in order, even when the server knows the entry.
      const remembered = memPhotos.shift()
      const known = q.sent || remembered?.text
      list.push({ id: `cc-${q.ts}`, text: known || '', missing: known ? 0 : images })
      continue
    }
    if (!normText(q.text) || mine.some(x => holds(x.text, q.text))) continue
    if (o.items.some(i => (!q.ts || !i.ts || i.ts >= q.ts) && (i.role === 'user' || i.role === 'notice') && holds(i.text, q.text))) continue
    const known = images ? q.sent || [...(o.memory || [])].reverse().find(m => holds(withoutUploads(m.text), q.text))?.text : null
    list.push({ id: `cc-${q.ts}`, text: known || q.text, missing: known ? 0 : images })
  }
  const phases = queuedPhases(list.map(q => q.text), o.screen)
  return list.map((q, i) => ({
    id: q.id,
    raw: q.text,
    mine: !q.id.startsWith('cc-'),
    // Held or failed on the server: never typed yet, so never "sent".
    phase: q.state ? 'queued' : phases[i]!,
    state: q.state || null,
    ...(q.local ? { local: true } : {}),
    ...(q.inputText ? { inputText: q.inputText } : {}),
    ...(q.reason ? { reason: q.reason } : {}),
    photos: uploadNames(q.text),
    missing: q.missing || 0,
    ...(q.pasted ? { pasted: q.pasted } : {}),
  }))
}
