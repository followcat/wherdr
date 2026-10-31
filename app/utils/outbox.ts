// Messages shown in the conversation from the tap on Send, before the server
// answers (see composables/useOutbox.ts). Each one has an id made here
// ("w-…"), which the server keeps for its own record of the message (see
// server/utils/state.ts addQueued): the bubble keeps its identity from the tap
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

export function addSending(list: OutboxItem[], id: string, text: string, at: number, submitKey?: string): OutboxItem[] {
  return [...list, { id, text, at, state: 'sending', ...(submitKey ? { submitKey } : {}) }]
}

// The server answered: its record replaces the bubble (same id; the time of
// the tap is kept, so messages typed in a row stay in order). No record (typed
// as an answer, agent not ready yet…): the bubble goes.
export function settle(list: OutboxItem[], id: string, server: QueuedMessage | null, now: number): OutboxItem[] {
  if (!server) return list.filter(q => q.id !== id)
  return list.map(q => (q.id === id ? { ...server, id, at: q.at ?? server.at, settledAt: now } : q))
}

// The request failed: the bubble stays, "Not sent", with Retry / Cancel.
// Its terminator goes with it: Retry must not send it back as a plain Enter.
export function failLocal(list: OutboxItem[], id: string): OutboxItem[] {
  return list.map(q => (q.id === id ? { id: q.id, text: q.text, at: q.at, state: 'failed', local: true, ...(q.submitKey ? { submitKey: q.submitKey } : {}) } : q))
}

// Retry of a message the server never got: sending again, same bubble.
export function resend(list: OutboxItem[], id: string): OutboxItem[] {
  return list.map(q => (q.id === id ? { id: q.id, text: q.text, at: q.at, state: 'sending', ...(q.submitKey ? { submitKey: q.submitKey } : {}) } : q))
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
