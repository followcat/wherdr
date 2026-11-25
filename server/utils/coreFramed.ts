import { createConnection, type Socket } from 'node:net'
import { CoreError } from './core'

// One framed herdr-core connection: `[channel u32 LE][kind u8][len u32 LE][payload]`.
// Channel 0 carries JSON-RPC; other channels are attach or event streams.
export const FRAME = { DATA: 0, CREDIT: 1, CLOSE: 2, RESIZE: 3, FOCUS: 4, FACTS: 5 } as const
const MAX_PAYLOAD = 16 * 1024 * 1024

export type StreamHandler = (kind: number, payload: Buffer) => void
export interface FramedCore {
  call: <T>(method: string, params?: object, timeout?: number) => Promise<T>
  send: (channel: number, kind: number, payload?: Buffer) => void
  // Frames that arrive before the handler is set are kept for it.
  stream: (channel: number, handler: StreamHandler) => void
  onClose: (fn: () => void) => void
  close: () => void
}

export function coreFrame(channel: number, kind: number, payload: Buffer = Buffer.alloc(0)) {
  const head = Buffer.alloc(9)
  head.writeUInt32LE(channel, 0)
  head.writeUInt8(kind, 4)
  head.writeUInt32LE(payload.length, 5)
  return Buffer.concat([head, payload])
}

// Splits a byte stream into frames; returns the unparsed rest.
export function readFrames(buf: Buffer, each: (channel: number, kind: number, payload: Buffer) => void): Buffer {
  let at = 0
  while (buf.length - at >= 9) {
    const len = buf.readUInt32LE(at + 5)
    if (len > MAX_PAYLOAD) throw new CoreError('protocol', 'herdr-core frame is too large')
    if (buf.length - at < 9 + len) break
    each(buf.readUInt32LE(at), buf.readUInt8(at + 4), buf.subarray(at + 9, at + 9 + len))
    at += 9 + len
  }
  return buf.subarray(at)
}

export function openFramed(endpoint: string, timeout = 3000): Promise<FramedCore> {
  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(endpoint)
    let buf: Buffer = Buffer.alloc(0)
    let framed = false
    let closed = false
    let nextId = 2
    const pending = new Map<number, { resolve: (v: unknown) => void, reject: (e: CoreError) => void, timer: ReturnType<typeof setTimeout> }>()
    const streams = new Map<number, StreamHandler>()
    const early = new Map<number, [number, Buffer][]>()
    const closers: (() => void)[] = []
    const fail = (e: CoreError) => {
      if (closed) return
      closed = true
      clearTimeout(helloTimer)
      socket.destroy()
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e) }
      pending.clear()
      if (!framed) reject(e)
      for (const fn of closers) fn()
    }
    const helloTimer = setTimeout(() => fail(new CoreError('timeout', 'herdr-core did not respond in time')), timeout)

    const api: FramedCore = {
      call<T>(method: string, params = {}, ms = 3000) {
        if (closed) return Promise.reject(new CoreError('disconnected', 'herdr-core connection is closed'))
        const id = nextId++
        return new Promise<T>((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new CoreError('timeout', 'herdr-core did not respond in time')) }, ms)
          pending.set(id, { resolve: res as (v: unknown) => void, reject: rej, timer })
          socket.write(coreFrame(0, FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }))))
        })
      },
      send(channel, kind, payload) {
        if (!closed && socket.writable) socket.write(coreFrame(channel, kind, payload))
      },
      stream(channel, handler) {
        streams.set(channel, handler)
        for (const [kind, payload] of early.get(channel)?.splice(0) ?? []) handler(kind, payload)
        early.delete(channel)
      },
      onClose(fn) { if (closed) fn(); else closers.push(fn) },
      close() {
        if (closed) return
        closed = true
        socket.end()
        setTimeout(() => socket.destroy(), 500).unref?.()
        for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new CoreError('disconnected', 'herdr-core connection is closed')) }
        pending.clear()
      },
    }

    const reply = (payload: Buffer) => {
      let m: { id?: number, result?: unknown, error?: { message?: string, data?: { kind?: string, hint?: string } } }
      try { m = JSON.parse(payload.toString('utf8')) }
      catch { return fail(new CoreError('protocol', 'Invalid JSON-RPC response from herdr-core')) }
      const p = typeof m.id === 'number' ? pending.get(m.id) : undefined
      if (!p) return
      pending.delete(m.id!)
      clearTimeout(p.timer)
      if (m.error) p.reject(new CoreError(m.error.data?.kind || 'rpc', m.error.message || '', m.error.data?.hint))
      else p.resolve(m.result)
    }
    const onFrame = (channel: number, kind: number, payload: Buffer) => {
      if (channel === 0) { if (kind === FRAME.DATA) reply(payload); return }
      const handler = streams.get(channel)
      if (handler) return handler(kind, payload)
      const list = early.get(channel) ?? []
      // Bounded: a channel nobody claims never grows the server's memory.
      if (list.length < 256) list.push([kind, payload])
      early.set(channel, list)
    }

    socket.once('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'hello', params: { generation: 1, framed: true } }) + '\n'))
    socket.once('error', () => fail(new CoreError('unavailable', 'Cannot connect to herdr-core. Check HC_SOCKET and start hc.')))
    socket.once('close', () => fail(new CoreError('disconnected', 'herdr-core closed the connection')))
    socket.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
      try {
        if (!framed) {
          const end = buf.indexOf(10)
          if (end < 0) {
            if (buf.length > 1024 * 1024) fail(new CoreError('protocol', 'herdr-core reply is too large'))
            return
          }
          const hello = JSON.parse(buf.subarray(0, end).toString('utf8'))
          if (hello?.id !== 1 || hello.result?.generation !== 1 || hello.result?.framed !== true) {
            return fail(new CoreError('incompatible', 'Incompatible herdr-core. Protocol generation 1 is required.'))
          }
          framed = true
          clearTimeout(helloTimer)
          buf = buf.subarray(end + 1)
          resolve(api)
        }
        buf = readFrames(buf, onFrame)
      } catch (e) {
        fail(e instanceof CoreError ? e : new CoreError('protocol', 'Invalid response from herdr-core'))
      }
    })
  })
}
