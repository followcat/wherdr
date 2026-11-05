// At most `limit` calls per `windowMs` for each client key. The table of
// clients is itself bounded: expired entries go first, then the oldest.
export function createRateLimit(limit: number, windowMs: number, maxClients = 1000) {
  const hits = new Map<string, { n: number, reset: number }>()
  return {
    take(key: string, now = Date.now()): boolean {
      let h = hits.get(key)
      if (!h || h.reset <= now) {
        hits.delete(key)
        if (hits.size >= maxClients) {
          for (const [k, v] of hits) if (v.reset <= now) hits.delete(k)
          while (hits.size >= maxClients) hits.delete(hits.keys().next().value!)
        }
        h = { n: 0, reset: now + windowMs }
        hits.set(key, h)
      }
      return ++h.n <= limit
    },
    _size: () => hits.size,
  }
}
