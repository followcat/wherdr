// Parked terminals: recent panes kept alive across a swipe or a visit home.
//
// A terminal view that goes away (Conversation/Terminal toggle, another agent,
// the home screen) parks its xterm and its /ws/term stream instead of disposing
// them (see useTerminal.ts). The controller lives on inside its AgentView; this
// module only holds the ones whose AgentView is gone, so returning to a
// recently viewed agent adopts the parked terminal and opens no new attach.
//
// Bounds: at most MAX_PARKED entries, least recently parked evicted first. The
// idle limit is NOT here: `park()` arms it on the controller itself, so the
// limit runs from the moment the terminal was parked — a controller parked
// inside its live view, which never reaches this cache, is bounded too.
export const MAX_PARKED = 2

// How long a parked terminal is kept before it is disposed and its wire
// closed. Armed by `park()` on the controller itself, so it runs from the
// moment the terminal was parked — including a controller parked inside its
// live view, which never reaches this cache.
export const PARK_IDLE_MS = 120_000

// What the cache needs from a parked controller (useTerminal.ts's TerminalCtl).
export interface ParkedViewer {
  dispose: () => void
}

export interface ParkEntry {
  // What the parked terminal is: its core address (see terminalIdentity).
  identity: string
  viewer: ParkedViewer
}

// The identity of a pane's terminal across snapshots: its core address. A core
// terminal keeps the same address for its whole life, and a new incarnation
// (a restarted program, a re-created terminal) closes the parked viewer's
// stream, which disposes it and drops it from the cache. `bornAt` is not used:
// it is filled in by the transcript readers on their own copies of a pane and
// never written into the app state this module reconciles against.
export function terminalIdentity(pane: { coreAddress?: string } | null | undefined): string | null {
  return pane?.coreAddress || null
}

export function createPark(limit = MAX_PARKED) {
  // Insertion order is recency: a re-park deletes and re-adds.
  const entries = new Map<string, ParkEntry>()

  function evictBeyondLimit() {
    const over: string[] = []
    for (const key of entries.keys()) if (entries.size - over.length > limit) over.push(key)
    for (const key of over) {
      const entry = entries.get(key)
      entries.delete(key)
      entry?.viewer.dispose()
    }
  }

  return {
    // Points a pane id at a parked viewer, replacing what it held.
    keep(key: string, entry: ParkEntry) {
      entries.delete(key)
      entries.set(key, entry)
      evictBeyondLimit()
    },
    // Adopt: takes the entry out of the cache. A different identity (the
    // pane's terminal changed while it was parked) is dropped, not adopted:
    // a cold open is the honest answer then.
    take<V extends ParkedViewer>(key: string, identity: string | null): V | null {
      const entry = entries.get(key)
      if (!entry) return null
      entries.delete(key)
      if (!identity || entry.identity !== identity) {
        entry.viewer.dispose()
        return null
      }
      return entry.viewer as V
    },
    // The pane is gone or its terminal changed: dispose and forget.
    drop(key: string) {
      const entry = entries.get(key)
      if (!entry) return
      entries.delete(key)
      entry.viewer.dispose()
    },
    // A parked viewer disposed itself (its stream closed, or its idle limit
    // ran out): only the reference goes.
    forget(viewer: ParkedViewer) {
      for (const [key, entry] of entries) if (entry.viewer === viewer) entries.delete(key)
    },
    // Drops what no live pane claims any more; `identityOf` answers null for a
    // pane that left the state and the terminal's identity otherwise.
    reconcile(identityOf: (key: string) => string | null) {
      const gone: string[] = []
      for (const [key, entry] of entries) {
        const identity = identityOf(key)
        if (!identity || identity !== entry.identity) gone.push(key)
      }
      for (const key of gone) {
        const entry = entries.get(key)
        entries.delete(key)
        entry?.viewer.dispose()
      }
    },
    keys: () => [...entries.keys()],
    size: () => entries.size,
    peek: (key: string): ParkEntry | null => entries.get(key) ?? null,
  }
}

export type Park = ReturnType<typeof createPark>

// One cache for the app (client only: it holds live sockets).
export const terminalPark = createPark()
