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
// The queue is kept on disk (`store`, DATA_DIR/held.json in state.ts) so that a
// restart of wherdr resumes it: a message whose send the restart cut is 'unseen'
// (it may have been typed), and so is one its holder had not handed over yet (the
// holder may have typed it, and is gone): its device puts it back for the user to check.
import fs from 'node:fs'
import type { Pane, QueuedMessage } from '../../shared/types'
import { writeJsonAtomicSync } from './atomicWrite'

const CLIENT_ID = /^w-[a-z0-9]{1,32}$/
const ready = (p: Pane) => p.agent === 'codex' && !p.installing && !p.stopped && p.status !== 'working' && p.status !== 'blocked'
// Timed out, or the connection lost during the send (failure() in coreInput.ts): it may have been typed.
const mayHaveReached = (e: unknown) => (e as { code?: string })?.code === 'timeout' || (e as { unconfirmed?: boolean })?.unconfirmed === true

// On disk: the lists by core address, and the ids being typed (here or by their holder).
export interface HeldSaved { held: Record<string, QueuedMessage[]>, typing: string[] }
export interface HeldStore { load: () => HeldSaved | null, save: (s: HeldSaved) => void }

// A file read by the server's user only. Unreadable (not missing): left as it is,
// the queue starts empty and is not written over it.
export function heldFile(file: string): HeldStore {
  let broken = false
  return {
    load() {
      try {
        const s = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (!s || typeof s.held !== 'object' || !Array.isArray(s.typing)) throw new Error('bad held file')
        return s as HeldSaved
      } catch (e) {
        broken = (e as NodeJS.ErrnoException).code !== 'ENOENT'
        if (broken) console.error(`[held] ${file} is unreadable: held messages not restored, the file is left as it is`)
        return null
      }
    },
    save(s) {
      if (broken) return
      try { writeJsonAtomicSync(file, s) } catch { /* only a restart's resume is lost */ }
    },
  }
}

export function createHeld(send: (p: Pane, q: QueuedMessage) => Promise<unknown>, now = Date.now, store?: HeldStore) {
  const held = new Map<string, QueuedMessage[]>() // by core address
  const sending = new Map<string, string>() // address → id being typed
  const manual = new Set<string>() // ids typed by their holder, not here
  let seq = 0
  const save = () => store?.save({ held: Object.fromEntries(held), typing: [...sending.values(), ...manual] })
  const unsure = (address: string, id: string) => {
    const list = held.get(address)
    if (list) held.set(address, list.map(q => (q.id === id ? { ...q, state: 'failed' as const, reason: 'unseen' as const } : q)))
  }
  const restored = store?.load()
  for (const [address, list] of Object.entries(restored?.held || {})) {
    if (!Array.isArray(list) || !list.length) continue
    held.set(address, list)
    for (const id of restored!.typing) unsure(address, id)
  }
  const remove = (address: string, id: string) => {
    const left = (held.get(address) || []).filter(q => q.id !== id)
    if (left.length) held.set(address, left)
    else held.delete(address)
  }
  return {
    // `clientId`: the app's id for the bubble it already shows (app/utils/outbox.ts).
    // Sent again (its answer lost): the message already held is returned, not held twice.
    hold(p: Pane, text: string, clientId?: unknown, byHolder = false): QueuedMessage {
      const list = held.get(p.coreAddress!) || []
      const own = typeof clientId === 'string' && CLIENT_ID.test(clientId) ? clientId : null
      const known = own && list.find(q => q.id === own)
      if (known) return known
      const q: QueuedMessage = { id: own || `held-${now().toString(36)}-${++seq}`, text, at: now(), state: 'held' }
      held.set(p.coreAddress!, [...list, q])
      if (byHolder) manual.add(q.id)
      save()
      return q
    },
    // The holder of a `manual` message is done with it: typed (gone), left to this
    // queue (false), or maybe typed ('unseen': never typed again).
    handOver(address: string, id: string, typed: boolean | 'unseen') {
      manual.delete(id)
      if (typed === 'unseen') unsure(address, id)
      else if (typed) remove(address, id)
      save()
    },
    // With each new state: lists the waiting messages on their panes, types the
    // oldest one into a Codex that is ready, drops those of a Codex that is gone.
    apply(panes: Pane[]) {
      const before = held.size
      for (const [address, list] of held) {
        const p = panes.find(x => x.coreAddress === address)
        if (!p || p.agent !== 'codex' || p.stopped) { held.delete(address); continue }
        const next = list.find(q => q.state === 'held' && !manual.has(q.id))
        if (next && ready(p) && !sending.has(address)) {
          sending.set(address, next.id)
          save()
          void send(p, next)
            .then(() => remove(address, next.id), (e) => { if (mayHaveReached(e)) unsure(address, next.id) })
            .finally(() => { sending.delete(address); save() })
        }
        p.queued = held.get(address)
      }
      if (held.size !== before) save()
    },
  }
}
