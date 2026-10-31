// Messages of each conversation shown before the server confirms them (see
// utils/outbox.ts). Sends of a conversation go out one after the other, in
// the order they were typed, whatever each one takes on the server.
import { reactive } from 'vue'
import type { Pane, QueuedMessage } from '#shared/types'
import { type OutboxItem, addSending, failLocal, newOutboxId, prune, resend, settle } from '~/utils/outbox'
import { sendMessage } from './useActions'

// Plain module state: it outlives the views (switching conversations while sending).
const boxes = reactive(new Map<string, OutboxItem[]>())
const chains = new Map<string, Promise<unknown>>()

const update = (paneId: string, f: (l: OutboxItem[]) => OutboxItem[]) => {
  const next = f(boxes.get(paneId) || [])
  if (next.length) boxes.set(paneId, next)
  else boxes.delete(paneId)
}

export const outboxFor = (paneId: string): OutboxItem[] => boxes.get(paneId) || []

// Send after the earlier sends of this conversation; the bubble moves to the
// server's record, or to "Not sent" if the request fails (error rethrown).
function deliver(p: Pane | undefined, paneId: string, id: string, text: string, submitKey?: string): Promise<QueuedMessage | null> {
  const run = (chains.get(paneId) || Promise.resolve()).catch(() => {}).then(() => sendMessage(p, paneId, text, id, submitKey))
  chains.set(paneId, run)
  return run.then(
    (q) => { update(paneId, l => settle(l, id, q, Date.now())); return q },
    (err) => { update(paneId, l => failLocal(l, id)); throw err },
  )
}

// A message: its bubble at once ("Queued · sending…"), then the send.
export function outboxSend(p: Pane | undefined, paneId: string, text: string, submitKey?: string): Promise<QueuedMessage | null> {
  const id = newOutboxId()
  update(paneId, l => addSending(l, id, text, Date.now(), submitKey))
  return deliver(p, paneId, id, text, submitKey)
}

// Retry of a message the server never got.
export function outboxRetry(p: Pane | undefined, paneId: string, id: string): Promise<QueuedMessage | null> {
  const q = outboxFor(paneId).find(x => x.id === id)
  if (!q) return Promise.resolve(null)
  update(paneId, l => resend(l, id))
  return deliver(p, paneId, id, q.text, q.submitKey)
}

// Cancel of a message the server never got: its text (photo paths included).
export function outboxDrop(paneId: string, id: string): string {
  const q = outboxFor(paneId).find(x => x.id === id)
  update(paneId, l => l.filter(x => x.id !== id))
  return q ? q.text : ''
}

// A record the server returned for a send made outside the outbox (the
// conversation's run buttons, a file dropped on the terminal…).
export function outboxAdd(paneId: string, q: QueuedMessage) {
  update(paneId, l => [...l.filter(x => x.id !== q.id), { ...q, settledAt: Date.now() }])
}

export function outboxPrune(paneId: string, server: QueuedMessage[]) {
  if (boxes.has(paneId)) update(paneId, l => prune(l, server, Date.now()))
}
