// Herdr 0.9.5 ignores `lines` in mouse-report mode: one command is one
// wheel tick. Preserve every requested tick instead of merging a fast drag
// into a single command. Small batches avoid a long queue in the agent's TTY.
export function createTouchScrollPacer<T = undefined>(send: (direction: 'up' | 'down', lines: number, metadata?: T) => void) {
  let metadata: (T | undefined)[] = []
  let net = 0, inFlight = 0, last = -Infinity
  let credit = 12, creditedAt = Date.now(), expiresAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  const schedule = () => {
    if (disposed || !net || timer) return
    const now = Date.now()
    if (now >= expiresAt) { net = 0; metadata = []; return }
    credit = Math.min(12, credit + Math.max(0, now - creditedAt) * .1)
    creditedAt = now
    const wait = Math.max(0, last + (inFlight >= 8 ? 45 : 16) - now, (1 - credit) / .1)
    if (wait > 0) {
      timer = setTimeout(() => { timer = null; schedule() }, Math.ceil(Math.min(wait, expiresAt - now)))
      return
    }
    const count = Math.min(Math.abs(net), Math.floor(credit), inFlight >= 8 ? 2 : 4)
    const direction = net > 0 ? 'up' : 'down'
    net -= Math.sign(net) * count
    credit -= count
    last = now
    inFlight += count
    for (let i = 0; i < count; i++) send(direction, 1, metadata.shift())
    schedule()
  }
  const cancel = () => {
    net = 0; metadata = []; inFlight = 0; last = -Infinity
    if (timer) clearTimeout(timer)
    timer = null
  }
  return {
    push(direction: 'up' | 'down', lines: number, value?: T) {
      if (disposed) return
      const amount = direction === 'up' ? lines : -lines
      // A reversal follows the finger now, rather than draining older input.
      if (net && Math.sign(net) !== Math.sign(amount)) { net = 0; metadata = [] }
      const accepted = Math.min(80 - Math.abs(net), Math.abs(amount))
      net += Math.sign(amount) * accepted
      for (let i = 0; i < accepted; i++) metadata.push(value)
      expiresAt = Date.now() + 800
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
    dispose() { cancel(); disposed = true },
  }
}
