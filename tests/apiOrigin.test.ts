// Every API write (POST, DELETE…) needs the app's own Origin (server/utils/http.ts,
// defineApi); reads (GET, HEAD) do not.
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createApp, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const data = mkdtempSync(path.join(tmpdir(), 'wherdr-origin-'))
process.env.DATA_DIR = data
let server: http.Server
let base = ''
let calls = 0
beforeAll(async () => {
  const { defineApi } = await import('../server/utils/http')
  const app = createApp()
  app.use('/key', defineApi(() => { calls++; return { ok: true } }))
  server = http.createServer(toNodeListener(app))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  base = `127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => {
  await new Promise(r => server.close(r))
  rmSync(data, { recursive: true, force: true })
})

const send = (method: string, origin?: string) => fetch(`http://${base}/key`, { method, headers: origin ? { origin } : {} }).then(r => r.status)

describe('Origin check on API writes', () => {
  it('refuses a DELETE without the app\'s Origin, before the handler runs', async () => {
    calls = 0
    expect(await send('DELETE')).toBe(403)
    expect(await send('DELETE', 'https://evil.example')).toBe(403)
    expect(await send('PUT')).toBe(403)
    expect(calls).toBe(0)
    expect(await send('DELETE', `http://${base}`)).toBe(200)
    expect(calls).toBe(1)
  })
  it('lets reads through without an Origin', async () => {
    expect(await send('GET')).toBe(200)
    expect(await send('HEAD')).toBe(200)
  })
})
