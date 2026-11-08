import type { ChatResponse, Pane } from '#shared/types'

// Pane ids include remote session prefixes; also distinguish agent restarts and
// the local Herdr session. Never share a response across these boundaries.
export function chatIntentKey(pane: Pane, session?: string) {
  return JSON.stringify([session, pane.machine, pane.id, pane.agent, pane.agentSession, pane.bornAt])
}

// Short-lived, one-use handoff to ChatView. Bound both speculative requests and
// retained response characters. It uses the ordinary tail endpoint, never history.
export function createChatIntentCache(read: (pane: string, signal: AbortSignal) => Promise<ChatResponse>) {
  type Entry = { at: number, controller: AbortController, result: Promise<ChatResponse | undefined> }
  const entries = new Map<string, Entry>()
  function drop(key: string) {
    entries.get(key)?.controller.abort()
    entries.delete(key)
  }
  function prune() {
    for (const [key, e] of entries) if (Date.now() - e.at > 5000) drop(key)
  }
  function preload(key: string, pane: string) {
    prune()
    if (entries.has(key)) return
    while (entries.size >= 4) drop(entries.keys().next().value!)
    const controller = new AbortController()
    const entry: Entry = { at: Date.now(), controller, result: Promise.resolve(undefined) }
    entries.set(key, entry)
    // A card's pointerdown calls this before its long press starts: a reader
    // that throws at once fails like a rejected read, never into the card.
    let started: Promise<ChatResponse>
    try { started = read(pane, controller.signal) }
    catch (e) { started = Promise.reject(e) }
    entry.result = started.then(r => {
      if (entries.get(key) !== entry || !r.available || r.unchanged || JSON.stringify(r).length > 500_000) {
        if (entries.get(key) === entry) drop(key)
        return undefined
      }
      return r
    }).catch(() => {
      if (entries.get(key) === entry) drop(key)
      return undefined
    }).finally(() => {
      // The result stays cached, but a settled read no longer needs its abort
      // listener or deadline timer (including the older Safari fallback).
      controller.abort()
    })
  }
  async function take(key: string) {
    prune()
    const entry = entries.get(key)
    if (!entry) return undefined
    const response = await entry.result
    if (entries.get(key) !== entry) return undefined
    entries.delete(key)
    return response
  }
  return { preload, take, clear: () => { for (const key of entries.keys()) drop(key) } }
}

// The caller's signal, also aborted past `ms`. AbortSignal.any needs Safari
// 17.4 while wherdr supports iOS 16.4 (docs/phone.md): built by hand there.
export function withDeadline(signal: AbortSignal, ms: number): AbortSignal {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, AbortSignal.timeout(ms)])
  const c = new AbortController()
  if (signal.aborted) {
    c.abort(signal.reason)
    return c.signal
  }
  const timer = setTimeout(() => c.abort(new DOMException('The operation timed out.', 'TimeoutError')), ms)
  signal.addEventListener('abort', () => { clearTimeout(timer); c.abort(signal.reason) }, { once: true })
  return c.signal
}

export function chatHoverIntent(run: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { clearTimeout(timer); timer = undefined }
  return {
    enter: (pointerType: string) => {
      cancel()
      if (pointerType === 'mouse') timer = setTimeout(() => { timer = undefined; run() }, 65)
    },
    down: () => { cancel(); run() },
    cancel,
  }
}
