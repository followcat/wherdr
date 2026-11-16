import path from 'node:path'
import WebSocket from 'ws'

export type CodexReadMethod = 'thread/list' | 'thread/read' | 'thread/items/list'
export type CodexRpc = (method: CodexReadMethod, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>
const readMethods = new Set(['thread/list', 'thread/read', 'thread/items/list'])
const READ_BUDGET_MS = 1500
const RETRY_MS = 5000

// Connect only to the existing daemon. Never spawn one, resume a thread, or
// subscribe to its turns: opening a conversation is a read-only operation.
export function createCodexDaemonRpc(codexHome: string): CodexRpc {
  const address = `ws+unix://${path.join(codexHome, 'app-server-control', 'app-server-control.sock')}:/`
  let socket: WebSocket | null = null
  let connecting: Promise<void> | null = null
  let sequence = 0
  let unavailable: { until: number, error: Error } | null = null
  const pending = new Map<number, { resolve: (value: unknown) => void, reject: (error: Error) => void }>()
  const fail = (error = new Error('Codex history connection closed')) => {
    const previous = socket
    socket = null
    unavailable = { until: Date.now() + RETRY_MS, error }
    for (const request of pending.values()) request.reject(error)
    pending.clear()
    previous?.terminate()
  }
  function request(method: string, params: Record<string, unknown>, deadline: number, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const connection = socket
    if (!connection || connection.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Codex history connection closed'))
    return new Promise((resolve, reject) => {
      const id = ++sequence
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); pending.delete(id) }
      const abort = () => { cleanup(); reject(signal?.reason) }
      const timer = setTimeout(() => fail(new Error('Codex history read timed out')), Math.max(1, deadline - Date.now()))
      signal?.addEventListener('abort', abort, { once: true })
      pending.set(id, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
      })
      connection.send(JSON.stringify({ id, method, params }), error => {
        if (error) pending.get(id)?.reject(error)
      })
    })
  }
  async function connect() {
    if (unavailable && Date.now() < unavailable.until) throw unavailable.error
    if (connecting) return connecting
    if (socket?.readyState === WebSocket.OPEN) return
    connecting = (async () => {
      const deadline = Date.now() + READ_BUDGET_MS
      const ws = new WebSocket(address, { handshakeTimeout: READ_BUDGET_MS, maxPayload: 16 * 1024 * 1024 })
      socket = ws
      // An idle reader must not keep the web process alive during shutdown.
      ws.on('upgrade', response => response.socket.unref())
      ws.on('error', error => { if (socket === ws) fail(error) })
      ws.on('close', () => { if (socket === ws) fail() })
      ws.on('message', bytes => {
        let message: { id?: number, method?: string, result?: unknown, error?: { message?: string } }
        try { message = JSON.parse(bytes.toString()) } catch { return }
        if (!message || typeof message !== 'object' || 'method' in message) return
        const call = message.id === undefined ? undefined : pending.get(message.id)
        if (!call) return
        if (message.error) call.reject(new Error(message.error.message || 'Codex history read failed'))
        else call.resolve(message.result)
      })
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      await request('initialize', {
        clientInfo: { name: 'wherdr_history_reader', version: '1.0' },
        capabilities: { experimentalApi: true, requestAttestation: false },
      }, deadline)
      ws.send(JSON.stringify({ method: 'initialized' }))
    })()
    try { await connecting }
    catch (error) { fail(error as Error); throw error }
    finally { connecting = null }
  }
  return async (method, params, signal) => {
    if (!readMethods.has(method)) throw new Error('Only read-only Codex history methods are allowed')
    signal?.throwIfAborted()
    const deadline = Date.now() + READ_BUDGET_MS
    // A caller can leave a shared connection attempt without cancelling others.
    await new Promise<void>((resolve, reject) => {
      const abort = () => { cleanup(); reject(signal?.reason) }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      signal?.addEventListener('abort', abort, { once: true })
      connect().then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
    })
    return request(method, params, deadline, signal)
  }
}
