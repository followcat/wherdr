// A restart while a response is still going and a WebSocket is open
// (server/utils/shutdown.ts): Nitro's graceful shutdown, with the settings it
// reads from the environment, ends in under 2 s instead of its 30 s default.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import crossws from 'crossws/adapters/node'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { capShutdownWait } from '../server/utils/shutdown'
// What the node-server preset runs (setupGracefulShutdown).
// @ts-expect-error no type declarations
import { getGracefulShutdownConfig } from '../node_modules/nitropack/dist/runtime/internal/shutdown.mjs'
// @ts-expect-error no type declarations
import gracefulShutdown from '../node_modules/nitropack/dist/runtime/internal/lib/http-graceful-shutdown.mjs'

it('stops in under 2 s with a download and a WebSocket open', async () => {
  const saved = process.env.NITRO_SHUTDOWN_TIMEOUT
  delete process.env.NITRO_SHUTDOWN_TIMEOUT
  capShutdownWait()
  const { timeout } = getGracefulShutdownConfig()
  if (saved === undefined) delete process.env.NITRO_SHUTDOWN_TIMEOUT
  else process.env.NITRO_SHUTDOWN_TIMEOUT = saved

  const started = Promise.withResolvers<void>()
  // A response that never ends, like a large download to a slow phone.
  const server = http.createServer((_req, res) => { res.write('x'); started.resolve() })
  server.on('upgrade', crossws({ hooks: {} }).handleUpgrade)
  // No signal (the test triggers it), no process.exit.
  const shutdown = gracefulShutdown(server, { signals: '', timeout, forceExit: false })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo

  http.get(`http://127.0.0.1:${port}/big`).on('error', () => {})
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/events`)
  await Promise.all([started.promise, new Promise(r => ws.on('open', r))])
  const wsClosed = new Promise(r => ws.on('close', r))

  const t0 = Date.now()
  await shutdown()
  expect(Date.now() - t0).toBeLessThan(2000)
  await wsClosed
}, 10000)
