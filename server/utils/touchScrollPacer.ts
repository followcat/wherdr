// Herdr 0.9.5 ignores `lines` in mouse-report mode: one command is one
// wheel tick. Preserve every requested tick instead of merging a fast drag
// into a single command. Small batches avoid a long queue in the agent's TTY.
export function createTouchScrollPacer<T = undefined>(send: (direction: 'up' | 'down', lines: number, metadata: T | undefined, expiresAt: number) => void) {
  let queue: { value: T | undefined, expiresAt: number }[] = []
  let direction: 'up' | 'down' = 'up'
  let inFlight = 0, last = -Infinity
  let credit = 12, creditedAt = Date.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const schedule = () => {
    if (disposed || !queue.length || timer) return
    const now = Date.now()
    queue = queue.filter(item => item.expiresAt > now)
    if (!queue.length) return
    const expiresAt = Math.min(...queue.map(item => item.expiresAt))
    credit = Math.min(12, credit + Math.max(0, now - creditedAt) * .1)
    creditedAt = now
    // A repaint is only a pacing opportunity, not proof of applied movement.
    // Keep an actual ceiling while the terminal is silent; a slower timer
    // alone still fills its input queue after the user has stopped.
    if (inFlight >= 8) {
      timer = setTimeout(() => { timer = null; schedule() }, expiresAt - now)
      return
    }
    const wait = Math.max(0, last + 16 - now, (1 - credit) / .1)
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; schedule() }, Math.ceil(Math.min(wait, expiresAt - now)))
      return
    }
    const count = Math.min(queue.length, Math.floor(credit), 4, 8 - inFlight)
    last = now
    for (let i = 0; i < count; i++) {
      // send() may synchronously cancel queued items — guard the shift, and
      // reserve credit/in-flight only for a tick that actually went out:
      // items dropped mid-batch must not leave phantom in-flight behind.
      const item = queue.shift()
      if (!item) break
      inFlight++
      credit -= 1
      // The item's own deadline travels with the send: downstream queues
      // must honor the same TTL rather than deliver stale ticks late.
      send(direction, 1, item.value, item.expiresAt)
    }
    schedule()
  }
  const cancel = () => {
    queue = []; inFlight = 0; last = -Infinity
    if (timer) clearTimeout(timer)
    timer = null
  }
  // Phase cancel: drop queued items matching the predicate (e.g. leftover
  // momentum) without touching the drag phase or the send window.
  const cancelWhere = (drop: (value: T | undefined) => boolean) => {
    queue = queue.filter(item => !drop(item.value))
  }
  return {
    push(nextDirection: 'up' | 'down', lines: number, value?: T, maxAgeMs = 240) {
      if (disposed) return
      // Keep real drag requests longer than expendable momentum. Each request
      // owns its deadline: a later flick must not shorten or renew older input.
      if (direction !== nextDirection) queue = []
      direction = nextDirection
      queue = queue.filter(item => item.expiresAt > Date.now())
      const accepted = Math.min(48 - queue.length, Math.abs(lines))
      const expiresAt = Date.now() + Math.max(1, Math.min(800, maxAgeMs))
      for (let i = 0; i < accepted; i++) queue.push({ value, expiresAt })
      if (timer) clearTimeout(timer)
      timer = null
      schedule()
    },
    frame() {
      if (disposed) return
      inFlight = 0
      if (timer) clearTimeout(timer)
      timer = null
      schedule()
    },
    cancel,
    cancelWhere,
    dispose() { cancel(); disposed = true },
  }
}
