// One Herdr poll per machine at a time. A request made while a poll runs joins
// it, and one more poll follows (the change behind the request may be newer
// than what the running poll read).
export function pollQueue<M extends { key: string }>(run: (m: M) => Promise<void>) {
  const inflight = new Map<string, Promise<void>>()
  const again = new Set<string>()
  function pollOne(m: M): Promise<void> {
    const cur = inflight.get(m.key)
    if (cur) { again.add(m.key); return cur }
    const p = run(m).catch(() => {}).finally(() => {
      inflight.delete(m.key)
      if (again.delete(m.key)) pollOne(m)
    })
    inflight.set(m.key, p)
    return p
  }
  // A poll that reads Herdr after this call, e.g. to see a pane just created:
  // the running poll (if any) is waited for, then the next one.
  async function pollFresh(m: M): Promise<void> {
    const cur = inflight.get(m.key)
    if (cur) await cur
    return pollOne(m)
  }
  return { pollOne, pollFresh, busy: (key: string) => inflight.has(key) }
}
