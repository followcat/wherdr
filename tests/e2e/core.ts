// Shared harness of the core e2e specs: the built server (.output/, `npm run build`)
// on a free isolated port, against a fake herdr-core socket that answers from the
// 0.1.16 fixture. A spec overrides some answers and reads the calls it received.
import { expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pdfAuthDb, pdfSession } from './pdfAuth.mjs'
import fixture from '../fixtures/core-0.1.16.json' with { type: 'json' }

export { fixture }
export interface Call { id: number, method: string, params?: any }
// A spec's answer to a call, or undefined for the default one.
export type Answer = (call: Call) => unknown

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

// seed: writes files into the data folder before the server starts.
export async function startCore(answer: Answer = () => undefined, seed?: (data: string) => Promise<void>) {
  const data = await mkdtemp(join(tmpdir(), 'core-e2e-'))
  const socketPath = join(data, 'core.sock')
  await writeFile(join(data, 'auth.json'), JSON.stringify(pdfAuthDb))
  await writeFile(join(data, 'push.json'), '{"subs":[]}')
  await seed?.(data)
  const port = await freePort()
  const server = spawn(process.execPath, ['.output/server/index.mjs'], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: data, HC_SOCKET: socketPath, HERDR_WEB_MACHINES: 'off' },
    stdio: 'ignore',
  })
  // One-shot JSON-RPC calls, then the calls of the framed (event and terminal) connection.
  const calls: Call[] = []
  const framed: Call[] = []
  const terminal = fixture.inventory.terminals[0]!
  const reply = (call: Call) => {
    const own = answer(call)
    if (own !== undefined) return own
    return call.method === 'hello' ? fixture.hello
      : call.method === 'terminal.list' ? fixture.inventory
      : call.method === 'machine.list' ? { machines: [{ name: 'host-a', state: 'connected' }] }
      : fixture.discover
  }
  // The server's SIGTERM in teardown can reset a socket: not a test failure.
  const sockets = new Set<Socket>()
  const core = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    socket.once('data', (first) => {
      const call = JSON.parse(first.toString().split('\n')[0]!) as Call
      if (call.method !== 'hello' || !call.params?.framed) {
        calls.push(call)
        socket.end(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: reply(call) }) + '\n')
        return
      }
      socket.write(JSON.stringify({ jsonrpc: '2.0', id: call.id, result: { ...fixture.hello, framed: true } }) + '\n')
      let buf = Buffer.alloc(0)
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk])
        while (buf.length >= 9 && buf.length >= 9 + buf.readUInt32LE(5)) {
          const channel = buf.readUInt32LE(0)
          const payload = buf.subarray(9, 9 + buf.readUInt32LE(5))
          buf = buf.subarray(9 + payload.length)
          if (channel) continue
          const c = JSON.parse(payload.toString()) as Call
          framed.push(c)
          const result = c.method === 'events.subscribe'
            ? { channel: 2, seq: 1, terminals: [{ ...terminal, cols: 80, rows: 24 }] } : { channel: 3 }
          socket.write(frame(0, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: c.id, result }))))
          if (c.method === 'terminal.attach') socket.write(frame(3, Buffer.from('hello from core\r\n')))
        }
      })
    })
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
