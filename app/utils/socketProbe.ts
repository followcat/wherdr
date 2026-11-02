// One ping per socket, shared by overlapping wake signals. Cancellation is
// distinct from a network failure: replacing/closing a socket owns its retry.
export function createSocketProbe<T extends { readyState: number, send: (data: string) => void }>(getSocket: () => T | null) {
  let pending: { socket: T, promise: Promise<boolean | null>, finish: (result: boolean | null) => void } | null = null
  function cancel() { pending?.finish(null) }
  function pong(socket: T) { if (pending?.socket === socket) pending.finish(true) }
  function probe(ms = 1600): Promise<boolean | null> {
    const socket = getSocket()
    if (pending && pending.socket === socket) return pending.promise
    cancel()
    // CONNECTING belongs to the handshake watchdog, never to a ping timeout.
    if (!socket || socket.readyState !== 1) return Promise.resolve(null)
    let finish!: (result: boolean | null) => void
    const promise = new Promise<boolean | null>(resolve => { finish = resolve })
    const timer = setTimeout(() => { if (pending?.promise === promise) pending.finish(false) }, ms)
    pending = { socket, promise, finish: result => {
      clearTimeout(timer)
      pending = null
      finish(result)
    } }
    try { socket.send(JSON.stringify({ type: 'ping' })) }
    catch { pending?.finish(false) }
    return promise
  }
  async function recover(reconnect: () => void) {
    const socket = getSocket()
    const alive = await probe()
    // Only the first waiter can replace this socket. Late results from an
    // old connection must never close its replacement.
    if (alive === false && getSocket() === socket) reconnect()
  }
  return { probe, pong, cancel, recover }
}
