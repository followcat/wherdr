// Messages of each conversation shown before the server confirms them (see
// utils/outbox.ts). Sends of a conversation go out one after the other, in
// the order they were typed, whatever each one takes on the server.
import { reactive } from 'vue'
import type { Pane, QueuedMessage } from '#shared/types'
import { type OutboxItem, type RecentSend, SendTimeout, addSending, chainSend, failLocal, isRepeat, newOutboxId, prune, recentSends, resend, settle } from '~/utils/outbox'
import { tl } from '~/utils/i18n'
import { sendMessage } from './useActions'

// Plain module state: it outlives the views (switching conversations while sending).
const boxes = reactive(new Map<string, OutboxItem[]>())
const chains = new Map<string, Promise<unknown>>()
const recent = new Map<string, RecentSend[]>()

// The composer's submit, before it sends: false when the same text went to
// this conversation a moment ago (utils/outbox.ts isRepeat), true otherwise,
// and the send is remembered for the next one.
export function claimSend(paneId: string, text: string, now = Date.now()): boolean {
  const list = recent.get(paneId) || []
  if (isRepeat(list, text, now)) return false
  recent.set(paneId, [...recentSends(list, now), { text, at: now }])
  return true
}

// A send that did not go (refused, failed): the same text may go again at once.
export function releaseSend(paneId: string, text: string) {
  const list = (recent.get(paneId) || []).filter(s => s.text !== text)
  if (list.length) recent.set(paneId, list)
  else recent.delete(paneId)
}

const update = (paneId: string, f: (l: OutboxItem[]) => OutboxItem[]) => {
  const next = f(boxes.get(paneId) || [])
  if (next.length) boxes.set(paneId, next)
  else boxes.delete(paneId)
}

export const outboxFor = (paneId: string): OutboxItem[] => boxes.get(paneId) || []

// Send after the earlier sends of this conversation (utils/outbox.ts
// chainSend); the bubble moves to the server's record, or to "Not sent" if the
// request fails or gets no answer (error rethrown).
function deliver(p: Pane | undefined, paneId: string, id: string, text: string): Promise<QueuedMessage | null> {
  const run = chainSend(chains.get(paneId), signal => sendMessage(p, paneId, text, id, signal))
  chains.set(paneId, run)
  return run.then(
    (q) => { update(paneId, l => settle(l, id, q, Date.now())); return q },
    (err) => {
      update(paneId, l => failLocal(l, id))
      throw err instanceof SendTimeout
        ? new Error(tl('No answer from the server: check the conversation before sending it again.', 'Pas de réponse du serveur : vérifie la conversation avant de le renvoyer.'))
        : err
    },
  )
}

// A message: its bubble at once ("Queued · sending…"), then the send.
export function outboxSend(p: Pane | undefined, paneId: string, text: string): Promise<QueuedMessage | null> {
  const id = newOutboxId()
  update(paneId, l => addSending(l, id, text, Date.now()))
  return deliver(p, paneId, id, text)
}

// Retry of a message the server never got.
export function outboxRetry(p: Pane | undefined, paneId: string, id: string): Promise<QueuedMessage | null> {
  const q = outboxFor(paneId).find(x => x.id === id)
  if (!q) return Promise.resolve(null)
  update(paneId, l => resend(l, id))
  return deliver(p, paneId, id, q.text)
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
