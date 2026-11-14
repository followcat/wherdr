// Shared harness of the core e2e specs: the built server (.output/, `npm run build`)
// on a free isolated port, against a fake herdr-core socket that answers from the
// 0.1.16 fixture. A spec overrides some answers and reads the calls it received.
import { expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pdfAuthDb, pdfSession } from './pdfAuth.mjs'
import fixture from '../fixtures/core-0.1.16.json' with { type: 'json' }

export { fixture }
export interface Call { id: number, method: string, params?: any }
// A spec's answer to a call, or undefined for the default one.
export type Answer = (call: Call) => unknown
// Frame kinds a spec asserts on (mirrors server/utils/coreFramed.ts FRAME).
export const STREAM = { data: 0, credit: 1, close: 2, resize: 3 } as const

// Framed relay: [channel u32][kind u8][len u32][payload].
function frame(channel: number, payload: Buffer) {
  const head = Buffer.alloc(9)
  head.writeUInt32LE(channel, 0)
  head.writeUInt8(0, 4)
  head.writeUInt32LE(payload.length, 5)
  return Buffer.concat([head, payload])
}

async function freePort() {
  for (let port = 7690; port <= 7699; port++) {
    const probe = createServer()
    const free = await new Promise<boolean>((resolve) => {
      probe.once('error', () => resolve(false))
      probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('No free isolated test port')
}

// seed: writes files into the data folder before the server starts. feed tunes
// the attach stream: firstPaint replaces the default 'hello from core' burst
// (pass '' for none, or a function of the attach call when the paint must be
// sized to the client's requested cols/rows); output() pushes more terminal
// data after the attach.
// feed.terminal overrides fixture fields on BOTH the one-shot terminal.list
// answer and the framed events.subscribe snapshot (screen:'inexact' etc);
// feed.terminals replaces the whole list the same way (each entry merged
// onto the fixture's base terminal).
export async function startCore(answer: Answer = () => undefined, seed?: (data: string) => Promise<void>, feed: { firstPaint?: string | Uint8Array | ((attach: Call) => string | Uint8Array), terminal?: Record<string, unknown>, terminals?: Record<string, unknown>[] } = {}) {
  const data = await mkdtemp(join(tmpdir(), 'core-e2e-'))
  const socketPath = join(data, 'core.sock')
  // Every path the server can derive (HOME fallbacks, XDG, its own dir
  // variables) is anchored inside the owned root, so nothing the child reads,
  // writes or cleans up can reach the host's files.
  const dirs = ['home', 'config', 'xdg', 'wherdr', 'uploads', 'attach']
  await Promise.all(dirs.map(d => mkdir(join(data, d), { recursive: true })))
  await writeFile(join(data, 'auth.json'), JSON.stringify(pdfAuthDb))
  await writeFile(join(data, 'push.json'), '{"subs":[]}')
  await seed?.(data)
  const port = await freePort()
  // Allowlist environment, never process.env: no HERDR_*/HC_* beside the fake
  // socket, no agent config or provider key, no real APP_URL.
  const server = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: join(data, 'home'),
      TMPDIR: data,
      XDG_CONFIG_HOME: join(data, 'config'),
      XDG_DATA_HOME: join(data, 'xdg'),
      WHERDR_DIR: join(data, 'wherdr'),
      UPLOAD_DIR: join(data, 'uploads'),
      ATTACH_DIR: join(data, 'attach'),
      DATA_DIR: data,
      HC_SOCKET: socketPath,
      HERDR_WEB_MACHINES: 'off',
      HOST_LABEL: 'e2e',
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: 'ignore',
  })
  // One-shot JSON-RPC calls, then the calls of the framed (event and terminal) connection.
  const calls: Call[] = []
  const framed: Call[] = []
  // Inbound stream frames on the attach/event channels (input DATA, CREDIT,
  // RESIZE): what the browser terminal sent to core. `keys` ride channel 0 as
  // terminal.keys calls and are read from `framed`.
  const inbound: { channel: number, kind: number, data: Buffer }[] = []
  // Sockets that attached a terminal: output() writes on their stream channel.
  const attachSockets = new Set<Socket>()
  const terminals = feed.terminals?.map(t => ({ ...fixture.inventory.terminals[0]!, ...t }))
    ?? [{ ...fixture.inventory.terminals[0]!, ...feed.terminal }]
  // What the server was answered for inventory/subscription (read-only record
  // for specs that must prove which metadata variant each path delivered).
  const served: { method: string, result: unknown }[] = []
  const reply = (call: Call) => {
    const own = answer(call)
    if (own !== undefined) return own
    return call.method === 'hello' ? fixture.hello
      : call.method === 'terminal.list' ? { ...fixture.inventory, terminals: feed.terminals ? terminals : [terminals[0]!, ...fixture.inventory.terminals.slice(1)] }
      : call.method === 'machine.list' ? { machines: [{ name: 'host-a', state: 'connected' }] }
      : fixture.discover
  }
  // The server's SIGTERM in teardown can reset a socket: not a test failure.
  const sockets = new Set<Socket>()
  const core = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    // The first line can come in several chunks (a long request): read up to its end.
    let head = Buffer.alloc(0)
    const onHead = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk])
      const end = head.indexOf(10)
      if (end < 0) return
      socket.off('data', onHead)
      const call = JSON.parse(head.subarray(0, end).toString()) as Call
      if (call.method !== 'hello' || !call.params?.framed) {
        calls.push(call)
        const result = reply(call)
        served.push({ method: call.method, result })
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result }) + '\n')
        return
      }
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { ...fixture.hello, framed: true } }) + '\n')
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= 9 && buf.length >= 9 + buf.readUInt32LE(5)) {
          const channel = buf.readUInt32LE(0)
          const kind = buf.readUInt8(4)
          const payload = buf.subarray(9, 9 + buf.readUInt32LE(5))
          buf = buf.subarray(9 + payload.length)
          if (channel) { inbound.push({ channel, kind, data: Buffer.from(payload) }); continue }
          const c = JSON.parse(payload.toString()) as Call
          framed.push(c)
          const own = answer(c)
          const result = own !== undefined ? own
            : c.method === 'events.subscribe' ? { channel: 2, seq: 1, terminals: terminals.map(t => ({ cols: 80, rows: 24, ...t })) } : { channel: 3 }
          served.push({ method: c.method, result })
          socket.write(frame(0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: c.id, result }))))
          if (c.method === 'terminal.attach') {
            attachSockets.add(socket)
            socket.once('close', () => attachSockets.delete(socket))
            if (feed.firstPaint !== '') {
              const paint = typeof feed.firstPaint === 'function' ? feed.firstPaint(c) : (feed.firstPaint ?? 'hello from core\r\n')
              socket.write(frame(3, Buffer.from(paint)))
            }
          }
        }
      })
    }
    socket.on('data', onHead)
  })
  const url = `http://localhost:${port}`
  await expect.poll(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok } catch { return false }
  }).toBe(true)
  await new Promise<void>(resolve => core.listen(socketPath, resolve))
  return {
    url,
    calls,
    framed,
    inbound,
    served,
    // More terminal output on the attach channel, after the first paint.
    output(data: string | Uint8Array) {
      for (const socket of attachSockets) socket.write(frame(3, Buffer.from(data)))
    },
    // An events-channel payload after the subscribe — e.g. the size event
    // another viewer set, which flips this client into watching mode.
    event(data: string | Uint8Array) {
      for (const socket of attachSockets) socket.write(frame(2, Buffer.from(data)))
    },
    // Signed in with the test passkey session, then on `path` of the app.
    async open(page: Page, path = '/') {
      await page.context().addCookies([{ name: 'hw_session', value: pdfSession(), url }])
      await page.goto(url + path)
    },
    async stop() {
      if (server.exitCode === null) {
        server.kill('SIGTERM')
        await new Promise<void>(resolve => server.once('exit', () => resolve()))
      }
      for (const socket of sockets) socket.destroy()
      if (core.listening) await new Promise<void>(resolve => core.close(() => resolve()))
      await rm(data, { recursive: true, force: true })
    },
  }
}
