import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import crossws from 'crossws/adapters/node'
import WebSocket from 'ws'
import { applyWsCompression, compressionAllowed, eventSendOptions, EVENTS_DEFLATE, WS_MAX_PAYLOAD } from '../server/utils/wsCompression'

describe('compressionAllowed', () => {
  it.each(['/ws/events', '/ws/events?x=1', '/ws/events/'])('allows %s', u => expect(compressionAllowed(u)).toBe(true))
  it.each(['/ws/term?pane=p1', '/ws/other', '/ws', '/', undefined])('refuses %s', u => expect(compressionAllowed(u)).toBe(false))
})

const servers: http.Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections(); s.close(r) })))
})

// The same wiring as the node-server preset: crossws' adapter given the h3
// websocket options, after the plugin has applied the compression settings.
async function serve(payload: string) {
  // Sent as server/routes/ws/events.ts does, a moment after the handshake so
  // the two are counted apart.
  const options = applyWsCompression({ hooks: { open: (peer: { send: (d: string, o?: { compress?: boolean }) => void }) => { setTimeout(() => peer.send(payload, eventSendOptions(payload)), 30) } } })
  const { handleUpgrade } = crossws(options as Parameters<typeof crossws>[0])
  const server = http.createServer()
  server.on('upgrade', handleUpgrade)
  servers.push(server)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  return `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
}

// Bytes read for the first message, handshake excluded.
function firstMessage(url: string) {
  return new Promise<{ extensions: string, data: string, wire: number }>((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: true })
    let extensions = ''
    let handshake = 0
    ws.on('upgrade', (res) => {
      extensions = String(res.headers['sec-websocket-extensions'] || '')
      handshake = res.socket.bytesRead
    })
    ws.on('message', (d) => {
      // `ws` reads the whole frame before emitting it.
      const wire = (ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead - handshake
      ws.close()
      resolve({ extensions, data: d.toString(), wire })
    })
    ws.on('error', reject)
  })
}

// A state-shaped frame: repetitive JSON, like the real one.
const state = JSON.stringify({ ok: true, panes: Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, agent: 'claude', status: 'idle', label: `pane ${i}`, workspace: 'w1' })) })

// The extension the server answers to a raw offer, as a browser sends it.
async function negotiated(offer: string) {
  const base = await serve(state)
  const { port } = new URL(base)
  const nonce = randomBytes(16).toString('base64')
  return new Promise<string>((resolve, reject) => {
    const headers = {
      'connection': 'Upgrade',
      'upgrade': 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': nonce,
      'sec-websocket-extensions': offer,
    }
    const req = http.request({ host: '127.0.0.1', port, path: '/ws/events', headers })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(String(res.headers['sec-websocket-extensions'] || '')) })
    req.on('response', res => reject(new Error(`HTTP ${res.statusCode}`)))
    req.on('error', reject)
    req.end()
  })
}

// RFC 7692 §7.1: the parameters an answer may carry, each once, and
// client_max_window_bits only when the client offered it.
function rfc7692Valid(answer: string, offer: string) {
  const [name, ...params] = answer.split(';').map(p => p.trim())
  if (name !== 'permessage-deflate') return false
  const seen = new Set<string>()
  for (const p of params) {
    const [k, v] = p.split('=').map(x => x.trim())
    if (!k || seen.has(k)) return false
    seen.add(k)
    if (k === 'server_no_context_takeover' || k === 'client_no_context_takeover') { if (v !== undefined) return false }
    else if (k === 'server_max_window_bits' || k === 'client_max_window_bits') { if (!/^(8|9|1[0-5])$/.test(v ?? '')) return false }
    else return false
  }
  return !seen.has('client_max_window_bits') || /client_max_window_bits/.test(offer)
}

describe('permessage-deflate', () => {
  // iOS Safari drops the socket when the answer limits its window (the app
  // stays offline on iPhone): never send client_max_window_bits.
  it.each(['permessage-deflate', 'permessage-deflate; client_max_window_bits'])('answers a Safari offer (%s) per RFC 7692, without client_max_window_bits', async (offer) => {
    const answer = await negotiated(offer)
    expect(answer).toMatch(/^permessage-deflate\b/)
    expect(rfc7692Valid(answer, offer)).toBe(true)
    expect(answer).not.toContain('client_max_window_bits')
  })

  it('compresses a state frame on /ws/events', async () => {
    const base = await serve(state)
    const m = await firstMessage(`${base}/ws/events`)
    expect(m.extensions).toContain('permessage-deflate')
    expect(m.data).toBe(state)
    expect(m.wire).toBeLessThan(state.length / 4)
  })

  it('compresses a repeated state frame against the previous one', async () => {
    const send = (peer: { send: (d: string, o?: { compress?: boolean }) => void }, d: string) => peer.send(d, eventSendOptions(d))
    const next = state.replace('"status":"idle"', '"status":"working"')
    const options = applyWsCompression({ hooks: { open: (peer: { send: (d: string, o?: { compress?: boolean }) => void }) => {
      setTimeout(() => send(peer, state), 30)
      setTimeout(() => send(peer, next), 60)
    } } })
    const { handleUpgrade } = crossws(options as Parameters<typeof crossws>[0])
    const server = http.createServer()
    server.on('upgrade', handleUpgrade)
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/events`, { perMessageDeflate: true })
    const reads: number[] = []
    const got: string[] = []
    await new Promise<void>((resolve) => {
      ws.on('message', (d) => {
        reads.push((ws as unknown as { _socket: { bytesRead: number } })._socket.bytesRead)
        got.push(d.toString())
        if (got.length === 2) { ws.close(); resolve() }
      })
    })
    expect(got).toEqual([state, next])
    expect(reads[1]! - reads[0]!).toBeLessThan(200)
  })

  it('sends frames under the threshold as they are', async () => {
    const small = JSON.stringify({ type: 'pong', pad: 'x'.repeat(EVENTS_DEFLATE.threshold - 40) })
    const base = await serve(small)
    const m = await firstMessage(`${base}/ws/events`)
    expect(m.extensions).toContain('permessage-deflate')
    expect(m.wire).toBeGreaterThanOrEqual(small.length)
  })

  it('leaves the terminal socket uncompressed', async () => {
    const base = await serve(state)
    const m = await firstMessage(`${base}/ws/term?pane=p1&cols=80&rows=24`)
    expect(m.extensions).toBe('')
    expect(m.data).toBe(state)
    expect(m.wire).toBeGreaterThanOrEqual(state.length)
  })

  it('keeps a route upgrade hook working', async () => {
    const options = applyWsCompression({ hooks: { upgrade: () => new Response(null, { status: 403 }) } })
    const { handleUpgrade } = crossws(options as Parameters<typeof crossws>[0])
    const server = http.createServer()
    server.on('upgrade', handleUpgrade)
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const ws = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/events`)
    const status = await new Promise(r => ws.on('unexpected-response', (_req, res) => r(res.statusCode)))
    expect(status).toBe(403)
  })
})

describe('maxPayload', () => {
  it('closes on a small compressed frame that inflates past 256 KB, before the route reads it', async () => {
    let received = 0
    const options = applyWsCompression({ hooks: { message: () => { received++ } } })
    expect(options.serverOptions?.maxPayload).toBe(WS_MAX_PAYLOAD)
    const { handleUpgrade } = crossws(options as Parameters<typeof crossws>[0])
    const server = http.createServer()
    server.on('upgrade', handleUpgrade)
    servers.push(server)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/ws/events`
    const code = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: { threshold: 0 } })
      ws.on('open', () => {
        // 4 MB of zeros: a few KB on the wire.
        ws.send(Buffer.alloc(4 * 1024 * 1024), { compress: true })
      })
      ws.on('close', c => resolve(c))
      ws.on('error', () => { /* the close follows */ })
      setTimeout(() => reject(new Error('no close')), 5000)
    })
    // 1009: message too big.
    expect(code).toBe(1009)
    expect(received).toBe(0)
  })
})
