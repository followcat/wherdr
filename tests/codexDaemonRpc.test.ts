import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'
import { createCodexDaemonRpc } from '../server/utils/codexDaemonRpc'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0)) await cleanup() })
async function fakeDaemon(sendRequest = false, options: { upgradeDelayMs?: number, silent?: string[] } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'codex-history-'))
  const socket = path.join(home, 'app-server-control', 'app-server-control.sock')
  mkdirSync(path.dirname(socket))
  const server = createServer()
  const ws = new WebSocketServer({ noServer: true })
  const methods: string[] = []
  const silent = new Set(options.silent)
  const methodWaiters = new Map<string, () => void>()
  const upgrades: (() => void)[] = []
  let connections = 0
  const sockets = new Set<import('node:net').Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (request, socket, head) => {
    connections++
    const upgrade = () => ws.handleUpgrade(request, socket, head, client => ws.emit('connection', client))
    if (options.upgradeDelayMs) setTimeout(upgrade, options.upgradeDelayMs)
    else upgrade()
    upgrades.shift()?.()
  })
  ws.on('connection', client => client.on('message', bytes => {
    const message = JSON.parse(bytes.toString())
    methods.push(message.method)
    methodWaiters.get(message.method)?.()
    if (sendRequest && message.id !== undefined) client.send(JSON.stringify({ id: message.id, method: 'server/request', params: {}, result: { data: ['wrong'] } }))
    if (message.id !== undefined && !silent.has(message.method)) client.send(JSON.stringify({ id: message.id, result: message.method === 'initialize' ? {} : { data: [], nextCursor: null } }))
  }))
  await new Promise<void>(resolve => server.listen(socket, resolve))
  cleanups.push(async () => {
    for (const client of ws.clients) client.terminate()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    ws.close()
    rmSync(home, { recursive: true, force: true })
  })
  return {
    home, methods, silent, connections: () => connections,
    upgraded: () => new Promise<void>(resolve => upgrades.push(resolve)),
    seen: (method: string) => methods.includes(method) ? Promise.resolve() : new Promise<void>(resolve => methodWaiters.set(method, resolve)),
  }
}
describe('read-only local Codex daemon transport', () => {
  it('bounds a read on an established connection and backs off after a timeout', async () => {
    const daemon = await fakeDaemon(false, { silent: ['thread/items/list'] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const rpc = createCodexDaemonRpc(daemon.home)
    let failure: unknown
    const read = rpc('thread/items/list', { threadId: 'thread-a' }).catch(error => { failure = error })
    await daemon.seen('thread/items/list')
    await vi.advanceTimersByTimeAsync(1500)
    expect(failure).toBeInstanceOf(Error)
    await read
    await expect(rpc('thread/list', {})).rejects.toThrow()
    expect(daemon.connections()).toBe(1)
  })
  it('shares a tight budget across handshake and initialize, backs off, then reconnects', async () => {
    const daemon = await fakeDaemon(false, { upgradeDelayMs: 500, silent: ['initialize'] })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const rpc = createCodexDaemonRpc(daemon.home)
    const upgraded = daemon.upgraded()
    let failure: unknown
    const first = rpc('thread/list', {}).catch(error => { failure = error })
    await upgraded
    await vi.advanceTimersByTimeAsync(500)
    await daemon.seen('initialize')
    await vi.advanceTimersByTimeAsync(1000)
    expect(failure).toBeInstanceOf(Error)
    await first
    await expect(rpc('thread/list', {})).rejects.toThrow()
    expect(daemon.connections()).toBe(1)
    await vi.advanceTimersByTimeAsync(4999)
    await expect(rpc('thread/list', {})).rejects.toThrow()
    expect(daemon.connections()).toBe(1)
    daemon.silent.clear()
    await vi.advanceTimersByTimeAsync(1)
    const nextUpgrade = daemon.upgraded()
    const recovered = rpc('thread/list', {})
    await nextUpgrade
    await vi.advanceTimersByTimeAsync(500)
    expect(await recovered).toEqual({ data: [], nextCursor: null })
    expect(daemon.connections()).toBe(2)
  })
  it('ignores server requests whose ids overlap pending reads', async () => {
    const { home } = await fakeDaemon(true)
    expect(await createCodexDaemonRpc(home)('thread/list', {})).toEqual({ data: [], nextCursor: null })
  })
  it('handshakes once before concurrent history requests over the UNIX WebSocket', async () => {
    const { home, methods } = await fakeDaemon()
    const rpc = createCodexDaemonRpc(home)
    const results = await Promise.all([rpc('thread/list', {}), rpc('thread/items/list', { threadId: 'thread-a' })])
    expect(results).toEqual([{ data: [], nextCursor: null }, { data: [], nextCursor: null }])
    expect(methods).toEqual(['initialize', 'initialized', 'thread/list', 'thread/items/list'])
  })
  it('refuses mutating methods before connecting to any endpoint', async () => {
    const rpc = createCodexDaemonRpc('/unused')
    await expect(rpc('turn/start' as never, {})).rejects.toThrow('read-only')
    await expect(rpc('thread/resume' as never, {})).rejects.toThrow('read-only')
  })
})
