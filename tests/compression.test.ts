// The compression decision for /api answers (server/utils/compression.ts):
// every condition of the brief, one test each, and the decoding of what a
// browser then receives.
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMPRESS_MIN, encodingFor, parseAcceptEncoding, type EncodingRequest } from '../server/utils/compression'

// A plain JSON answer over the size threshold, every condition satisfied.
const ok = (over: Partial<EncodingRequest> = {}): EncodingRequest => ({
  path: '/api/state',
  method: 'GET',
  status: 200,
  acceptEncoding: 'gzip',
  contentType: 'application/json',
  contentEncoding: undefined,
  hasRange: false,
  bodyLength: COMPRESS_MIN,
  ...over,
})

describe('which encoding an /api answer gets', () => {
  it('gzips a large JSON answer for a client that takes gzip', () => {
    expect(encodingFor(ok())).toBe('gzip')
  })

  it('prefers br when the client takes it too', () => {
    expect(encodingFor(ok({ acceptEncoding: 'gzip, deflate, br' }))).toBe('br')
  })

  it('leaves the answer alone for a client that takes no encoding, or gzip disabled', () => {
    expect(encodingFor(ok({ acceptEncoding: undefined }))).toBeNull()
    expect(encodingFor(ok({ acceptEncoding: '' }))).toBeNull()
    expect(encodingFor(ok({ acceptEncoding: 'deflate' }))).toBeNull()
    expect(encodingFor(ok({ acceptEncoding: 'identity' }))).toBeNull()
    // q=0 is a refusal, not a preference.
    expect(encodingFor(ok({ acceptEncoding: 'gzip;q=0' }))).toBeNull()
    expect(encodingFor(ok({ acceptEncoding: 'gzip, br;q=0' }))).toBe('gzip')
    // The wildcard covers both.
    expect(encodingFor(ok({ acceptEncoding: '*;q=1' }))).toBe('br')
  })

  it('only compresses JSON and text', () => {
    expect(encodingFor(ok({ contentType: 'application/json' }))).toBe('gzip')
    expect(encodingFor(ok({ contentType: 'text/plain; charset=utf-8' }))).toBe('gzip')
    expect(encodingFor(ok({ contentType: 'text/event-stream' }))).toBe('gzip')
    expect(encodingFor(ok({ contentType: 'application/octet-stream' }))).toBeNull()
    expect(encodingFor(ok({ contentType: 'image/png' }))).toBeNull()
    expect(encodingFor(ok({ contentType: 'application/pdf' }))).toBeNull()
    expect(encodingFor(ok({ contentType: 'application/wasm' }))).toBeNull()
    expect(encodingFor(ok({ contentType: '' }))).toBeNull()
  })

  it('leaves a body under 1 KB as it is', () => {
    expect(encodingFor(ok({ bodyLength: COMPRESS_MIN - 1 }))).toBeNull()
    expect(encodingFor(ok({ bodyLength: COMPRESS_MIN }))).toBe('gzip')
    expect(encodingFor(ok({ bodyLength: null }))).toBeNull()
  })

  it('never encodes an answer a route already encoded', () => {
    expect(encodingFor(ok({ contentEncoding: 'gzip' }))).toBeNull()
    expect(encodingFor(ok({ contentEncoding: 'br' }))).toBeNull()
  })

  it('leaves 204, 206 and 304 answers alone', () => {
    expect(encodingFor(ok({ status: 204 }))).toBeNull()
    expect(encodingFor(ok({ status: 206 }))).toBeNull()
    expect(encodingFor(ok({ status: 304 }))).toBeNull()
    // A 200 keeps it; an error with a JSON body does too.
    expect(encodingFor(ok({ status: 200 }))).toBe('gzip')
    expect(encodingFor(ok({ status: 400, bodyLength: 4096 }))).toBe('gzip')
  })

  it('leaves a ranged request alone', () => {
    expect(encodingFor(ok({ hasRange: true }))).toBeNull()
  })

  it('never touches anything but /api/', () => {
    expect(encodingFor(ok({ path: '/_nuxt/entry.js' }))).toBeNull()
    expect(encodingFor(ok({ path: '/workers/canto/canto_g2p.js' }))).toBeNull()
    expect(encodingFor(ok({ path: '/api' }))).toBeNull()
    expect(encodingFor(ok({ path: '/api/chat?pane=p1' }))).toBe('gzip')
  })

  it('leaves the app pages and the refusal pages alone', () => {
    expect(encodingFor(ok({ path: '/', contentType: 'text/html' }))).toBeNull()
    expect(encodingFor(ok({ path: '/index.html', contentType: 'text/html' }))).toBeNull()
  })

  it('never touches the ranged model downloads', () => {
    expect(encodingFor(ok({ path: '/models/qwen3/model.onnx', contentType: 'application/octet-stream' }))).toBeNull()
    expect(encodingFor(ok({ path: '/models/x.json', contentType: 'application/json' }))).toBeNull()
  })

  it('a HEAD carries no body to compress', () => {
    expect(encodingFor(ok({ method: 'HEAD' }))).toBeNull()
    expect(encodingFor(ok({ method: 'POST' }))).toBe('gzip')
  })
})

describe('Accept-Encoding parsing', () => {
  it('reads the encodings named, with their weights', () => {
    expect(parseAcceptEncoding('gzip, deflate, br')).toEqual({ brotli: true, gzip: true })
    expect(parseAcceptEncoding('gzip;q=0.5, br;q=0.8')).toEqual({ brotli: true, gzip: true })
    expect(parseAcceptEncoding(' gzip ; q=0 ')).toEqual({ brotli: false, gzip: false })
    expect(parseAcceptEncoding(undefined)).toEqual({ brotli: false, gzip: false })
  })
})

describe('what a browser decodes', () => {
  // The real route wrapper and the response hook, behind a real HTTP server:
  // the bytes on the wire decode to the same JSON, with the headers a proxy
  // caches on. A raw request, so nothing decompresses before the assertions
  // (fetch would).
  it('a compressed /api/chat decodes to the same JSON', async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'wherdr-compress-'))
    const { compressResponse } = await import('../server/utils/compression')
    const { defineApi } = await import('../server/utils/http')
    const { createApp, toNodeListener } = await import('h3')
    const http = await import('node:http')
    const items = Array.from({ length: 200 }, (_, i) => ({ role: 'assistant', text: `reply ${i}` }))
    const chat = { available: true, file: 'a.jsonl', token: 'a.jsonl:1:0', start: 0, items }
    const app = createApp()
    // The route as the app declares it: the stock handler, its own headers.
    app.use('/api/chat', defineApi(() => chat))
    app.options.onBeforeResponse = (event, response) => compressResponse(event, response)
    const server = http.createServer(toNodeListener(app))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as { port: number }
    const get = (accept: string) => new Promise<{ headers: http.IncomingHttpHeaders, body: Buffer }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/chat?pane=p1&n=0', headers: { 'accept-encoding': accept } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      req.end()
    })
    try {
      for (const [accept, decode] of [
        ['gzip', (b: Buffer) => JSON.parse(gunzipSync(b).toString('utf8'))],
        ['br', (b: Buffer) => JSON.parse(brotliDecompressSync(b).toString('utf8'))],
        ['identity', (b: Buffer) => JSON.parse(b.toString('utf8'))],
      ] as const) {
        const { headers, body } = await get(accept)
        if (accept === 'identity') expect(headers['content-encoding']).toBeUndefined()
        else expect(headers['content-encoding']).toBe(accept)
        // The decision applies to this answer, so it varies with Accept-Encoding.
        expect(String(headers.vary)).toMatch(/accept-encoding/i)
        // A route must never be truncated by a stale length.
        expect(Number(headers['content-length'])).toBe(body.length)
        // The route's own headers survive the encoding.
        expect(headers['cache-control']).toBe('no-store')
        expect(headers['content-type']).toBe('application/json')
        expect(decode(body)).toEqual(chat)
        if (accept !== 'identity') expect(body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(chat)) / 2)
      }
    } finally {
      await new Promise(r => server.close(r))
      rmSync(process.env.DATA_DIR, { recursive: true, force: true })
    }
  })
})
