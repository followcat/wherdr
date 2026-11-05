// Gate for work that several wake-up signals ask for (return to the page,
// socket reconnection): `take()` is true at most once per `ms`.
export function onceEvery(ms: number, now: () => number = Date.now) {
  let last = -Infinity
  return {
    take() {
      const t = now()
      if (t - last < ms) return false
      last = t
      return true
    },
    // The work just ran by another path (a periodic check): counts as taken.
    mark() { last = now() },
    // Time left before `take()` is true again.
    wait() { return Math.max(0, last + ms - now()) },
  }
}
