// Messages that wait on the server while Codex installs or updates itself
// (Pane.installing), the first message of a new agent included: typed into
// Codex once it is ready, one at a time. A message stays listed until it was
// typed: a failed send keeps it for the next try. A timed-out send may have
// reached Codex, so it is never typed again: it stays listed as failed
// ('unseen') and the device that sent it puts it back into the message field
// for the user to check. A first message behind a startup dialog is held but
// typed by coreCreate.ts (`manual`) until it hands it over. When Codex is gone instead (exited,
// or stopped by its update) they are dropped here, and the device that sent
// them puts them back into the message field (app/composables/useOutbox.ts).
// Never typed into a shell.
import type { Pane, QueuedMessage } from '../../shared/types'

const CLIENT_ID = /^w-[a-z0-9]{1,32}$/
const ready = (p: Pane) => p.agent === 'codex' && !p.installing && !p.stopped && p.status !== 'working' && p.status !== 'blocked'
const mayHaveReached = (e: unknown) => (e as { code?: string })?.code === 'timeout'

export function createHeld(send: (p: Pane, q: QueuedMessage) => Promise<unknown>, now = Date.now) {
  const held = new Map<string, QueuedMessage[]>() // by core address
  const sending = new Set<string>()
  const manual = new Set<string>() // ids typed by their holder, not here
  let seq = 0
  const remove = (address: string, id: string) => {
    const left = (held.get(address) || []).filter(q => q.id !== id)
    if (left.length) held.set(address, left)
    else held.delete(address)
  }
  const unsure = (address: string, id: string) => {
    const list = held.get(address)
    if (list) held.set(address, list.map(q => (q.id === id ? { ...q, state: 'failed' as const, reason: 'unseen' as const } : q)))
  }
  return {
    // `clientId`: the app's id for the bubble it already shows (app/utils/outbox.ts).
    hold(p: Pane, text: string, clientId?: unknown, byHolder = false): QueuedMessage {
      const list = held.get(p.coreAddress!) || []
      const own = typeof clientId === 'string' && CLIENT_ID.test(clientId) && !list.some(q => q.id === clientId) ? clientId : null
      const q: QueuedMessage = { id: own || `held-${now().toString(36)}-${++seq}`, text, at: now(), state: 'held' }
      held.set(p.coreAddress!, [...list, q])
      if (byHolder) manual.add(q.id)
      return q
    },
    // The holder of a `manual` message is done with it: typed (gone), or left to this queue.
    handOver(address: string, id: string, typed: boolean) {
      manual.delete(id)
      if (typed) remove(address, id)
    },
    // With each new state: lists the waiting messages on their panes, types the
    // oldest one into a Codex that is ready, drops those of a Codex that is gone.
    apply(panes: Pane[]) {
      for (const [address, list] of held) {
        const p = panes.find(x => x.coreAddress === address)
        if (!p || p.agent !== 'codex' || p.stopped) { held.delete(address); continue }
        const next = list.find(q => q.state === 'held' && !manual.has(q.id))
        if (next && ready(p) && !sending.has(address)) {
          sending.add(address)
          void send(p, next)
            .then(() => remove(address, next.id), (e) => { if (mayHaveReached(e)) unsure(address, next.id) })
            .finally(() => sending.delete(address))
        }
        p.queued = held.get(address)
      }
    },
  }
}
