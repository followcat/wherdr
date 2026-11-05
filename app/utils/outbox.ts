// Messages shown in the conversation from the tap on Send, before the server
// answers (see composables/useOutbox.ts). Each one has an id made here
// ("w-…"), which the server keeps for its own record of the message: the bubble keeps its identity from the tap
// until it lands in the transcript, with no duplicate and no jump.
import type { QueuedMessage } from '../../shared/types'

export interface OutboxItem extends Omit<QueuedMessage, 'state'> {
  // 'sending': the server has not answered yet.
  state?: QueuedMessage['state'] | 'sending'
  // The server never got it (network, refusal): Retry / Cancel stay here.
  local?: boolean
  // When the server answered (a slow send must not shorten its stay).
  settledAt?: number
}

// How long a record the server returned stays shown without the server
// listing it (it lands in the transcript in the meantime).
export const SETTLED_MS = 10000

let seq = 0
export const newOutboxId = () => `w-${Date.now().toString(36)}${(seq++ % 1296).toString(36).padStart(2, '0')}${Math.random().toString(36).slice(2, 6)}`

export function addSending(list: OutboxItem[], id: string, text: string, at: number): OutboxItem[] {
  return [...list, { id, text, at, state: 'sending' }]
}

// The server answered: its record replaces the bubble (same id; the time of
// the tap is kept, so messages typed in a row stay in order). No record (typed
// as an answer, agent not ready yet…): the bubble goes.
export function settle(list: OutboxItem[], id: string, server: QueuedMessage | null, now: number): OutboxItem[] {
  if (!server) return list.filter(q => q.id !== id)
  return list.map(q => (q.id === id ? { ...server, id, at: q.at ?? server.at, settledAt: now } : q))
}

// The request failed: the bubble stays, "Not sent", with Retry / Cancel.
export function failLocal(list: OutboxItem[], id: string): OutboxItem[] {
  return list.map(q => (q.id === id ? { id: q.id, text: q.text, at: q.at, state: 'failed', local: true } : q))
}

// Retry of a message the server never got: sending again, same bubble.
export function resend(list: OutboxItem[], id: string): OutboxItem[] {
  return list.map(q => (q.id === id ? { id: q.id, text: q.text, at: q.at, state: 'sending' } : q))
}

// A new server state: the records it lists win (shown from its state from now
// on); records it returned but no longer lists go after a while. A bubble
// still sending only goes on its own outcome. A bubble whose request failed
// stays "Not sent", unless the server lists it: then it got the message after
// all (the answer was lost on the way), and its record decides from now on,
// so that once the message lands the old "Not sent" does not come back.
export function prune(list: OutboxItem[], server: QueuedMessage[], now: number): OutboxItem[] {
  const known = new Set(server.map(q => q.id))
  return list.filter(q => q.state === 'sending' || (q.local ? !known.has(q.id) : !known.has(q.id) && now - (q.settledAt ?? q.at ?? 0) < SETTLED_MS))
}

// What the conversation shows: the server's records (its state wins), then the
// app's bubbles it does not list yet.
export function withOutbox(server: QueuedMessage[], local: OutboxItem[]): OutboxItem[] {
  return [...server, ...local.filter(q => !server.some(x => x.id === q.id))]
}

// A dictation app pastes the text and presses Enter for the user; when the
// page lags, that can happen more than once for one message. A submit whose
// text is exactly the one sent to the same conversation less than REPEAT_MS
// ago is that echo, not a new message. Any change in the text sends.
export const REPEAT_MS = 3000

export interface RecentSend { text: string, at: number }

// The sends still recent enough to catch an echo.
export function recentSends(list: RecentSend[], now: number): RecentSend[] {
  return list.filter(s => now - s.at < REPEAT_MS && s.at <= now)
}

export function isRepeat(list: RecentSend[], text: string, now: number): boolean {
  return recentSends(list, now).some(s => s.text === text)
}

// Sends of a conversation go one after the other. Each waits for the earlier
// one whatever its outcome, so a message behind a failed one still goes. A
// send with no answer after SEND_DEADLINE_MS fails ("Not sent", Retry /
// Cancel), so the ones behind it never wait for good. The server answers
// within about 45 s (herdr-core's own deadlines): this only catches a request
// lost on the way.
export const SEND_DEADLINE_MS = 60000

export class SendTimeout extends Error {
  constructor() {
    super('No answer from the server')
    this.name = 'SendTimeout'
  }
}

export function chainSend<T>(prev: Promise<unknown> | undefined, send: (signal: AbortSignal) => Promise<T>, ms = SEND_DEADLINE_MS): Promise<T> {
  return (prev || Promise.resolve()).catch(() => {}).then(() => {
    const ctl = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Also when `send` does not honour the signal.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new SendTimeout()
        ctl.abort(err)
        reject(err)
      }, ms)
    })
    return Promise.race([send(ctl.signal), deadline]).finally(() => clearTimeout(timer))
  })
}
