// Mounts plugin widgets into every [data-wherdr="header-actions"] slot
// (Home and Agent headers, present and future) without plugins querying the DOM.
// No observers run when no plugin mounts anything.
export type HeaderActionCleanup = () => void
export type HeaderActionRender = (el: HTMLElement) => HeaderActionCleanup | void | Promise<HeaderActionCleanup | void>

interface MountedSlot {
  box: HTMLElement
  cleanup?: HeaderActionCleanup
  dead?: boolean
}

interface HeaderActionEntry {
  render: HeaderActionRender
  mounted: Map<Element, MountedSlot>
}

const registeredSlots = new Set<Element>()
const syncAll = new Set<() => void>()

export function hasHeaderActions(el: Element | null | undefined): boolean {
  if (!el) return false
  return Array.from(el.children).some(c => !c.classList.contains('header-action') || c.childNodes.length > 0)
}

/** Register a [data-wherdr="header-actions"] element owned by a component. */
export function registerHeaderActionsSlot(el: Element): () => void {
  registeredSlots.add(el)
  for (const fn of [...syncAll]) fn()
  return () => {
    if (!registeredSlots.delete(el)) return
    for (const fn of [...syncAll]) fn()
  }
}

function safeCall(fn: () => void) {
  try { fn() } catch { /* a failing teardown changes nothing */ }
}

/** Create a DOM mount manager for [data-wherdr="header-actions"] containers. */
export function createHeaderActionsMount(root?: ParentNode) {
  const entries = new Map<symbol, HeaderActionEntry>()
  let observer: MutationObserver | null = null

  function currentSlots(): Element[] {
    const found = new Set<Element>()
    const target = root ?? (typeof document !== 'undefined' ? document.body : null)
    if (target) {
      if (target instanceof Element && target.matches('[data-wherdr="header-actions"]')) found.add(target)
      for (const el of target.querySelectorAll('[data-wherdr="header-actions"]')) found.add(el)
    }
    if (!root) {
      for (const el of registeredSlots) found.add(el)
    }
    return [...found]
  }

  function unmountSlot(rec: MountedSlot) {
    rec.dead = true
    const fn = rec.cleanup
    rec.cleanup = undefined
    if (fn) safeCall(fn)
    rec.box.remove()
  }

  function mountSlot(key: symbol, entry: HeaderActionEntry, slot: Element) {
    if (entry.mounted.has(slot)) return
    const box = slot.ownerDocument.createElement('span')
    box.className = 'header-action'
    const rec: MountedSlot = { box }
    entry.mounted.set(slot, rec)
    slot.append(box)
    let res: ReturnType<HeaderActionRender>
    try {
      res = entry.render(box)
    } catch (e) {
      entry.mounted.delete(slot)
      unmountSlot(rec)
      throw e
    }
    if (rec.dead || !entries.has(key)) {
      if (typeof res === 'function') safeCall(res)
      else if (res && typeof (res as PromiseLike<unknown>).then === 'function') {
        Promise.resolve(res).then((fn) => { if (typeof fn === 'function') safeCall(fn) }, () => {})
      }
      return
    }
    if (typeof res === 'function') rec.cleanup = res
    else if (res && typeof (res as PromiseLike<unknown>).then === 'function') {
      Promise.resolve(res).then((fn) => {
        if (typeof fn !== 'function') return
        if (rec.dead || !entries.has(key)) safeCall(fn)
        else rec.cleanup = fn
      }, () => {})
    }
  }

  function sync() {
    if (!entries.size) return
    const slots = currentSlots()
    const active = new Set(slots)
    for (const [key, entry] of [...entries]) {
      for (const [slot, rec] of [...entry.mounted]) {
        if (!active.has(slot)) {
          entry.mounted.delete(slot)
          unmountSlot(rec)
        }
      }
      for (const slot of slots) {
        if (!entries.has(key)) break
        mountSlot(key, entry, slot)
      }
    }
  }

  function ensureObserver() {
    if (observer || typeof MutationObserver === 'undefined') return
    const target = root ?? (typeof document !== 'undefined' ? document.body : null)
    if (!target) return
    observer = new MutationObserver(() => sync())
    observer.observe(target, { childList: true, subtree: true })
  }

  return function mountHeaderAction(render: HeaderActionRender): () => void {
    const key = Symbol()
    const entry: HeaderActionEntry = { render, mounted: new Map() }
    entries.set(key, entry)
    syncAll.add(sync)
    sync()
    ensureObserver()
    return () => {
      if (!entries.delete(key)) return
      for (const rec of entry.mounted.values()) unmountSlot(rec)
      entry.mounted.clear()
      if (!entries.size) {
        syncAll.delete(sync)
        observer?.disconnect()
        observer = null
      }
    }
  }
}
