// public/workers/model-files.js — the Cache Storage reader and Range-slice
// downloader shared by the dictation workers — exercised in a worker-like
// sandbox (node:vm): fetch, caches and postMessage are fakes.
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { fakeCaches } from './fakeModelCache'

const SRC = readFileSync(new URL('../public/workers/model-files.js', import.meta.url), 'utf8')
const CHUNK = 8 * 1024 * 1024

type FetchImpl = (url: string, init: { headers: Record<string, string> }) => Promise<Response>
interface Dl { t: string, file: string, got: number, total: number }
interface Api {
  openFile: (url: string, file: string, bytes: number, msg: { cache: string, chunk: number }) => Promise<Response>
  streamFile: (url: string, file: string) => AsyncGenerator<Uint8Array>
  cachedSlices: (cache: unknown, url: string, file: string, count: number) => AsyncGenerator<Uint8Array>
}

// A sandbox wired like the worker global: `self` is the global object.
function run(o: { fetchImpl?: FetchImpl } = {}) {
  const sent: Dl[] = []
  const calls: (string | undefined)[] = []
  const caches = fakeCaches()
  const scope = vm.createContext({
    fetch: async (url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers.range)
      return o.fetchImpl!(url, init)
    },
    postMessage: (m: Dl) => sent.push(m),
    // The retries' backoff, without the wait.
    setTimeout: (fn: () => void) => { fn(); return 0 },
    Response, ReadableStream,
    caches,
  } as Record<string, unknown>)
  scope.self = scope
  vm.runInContext(SRC, scope)
  return { api: (scope.self as { wherdrModelFiles: Api }).wherdrModelFiles, sent, calls, caches }
}

const fill = (n: number) => {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = i % 251
  return b
}
const bytes = async (res: Response) => new Uint8Array(await res.arrayBuffer())
// memcmp: deep-equal on 16 MB views exhausts vitest's diff machinery.
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

// A server that honours a single bytes=a-b range per request.
const ranged = (body: Uint8Array): FetchImpl => async (_url, init) => {
  const m = /bytes=(\d+)-(\d+)/.exec(init.headers.range)!
  const [a, b] = [Number(m[1]), Number(m[2])]
  return new Response(body.subarray(a, b + 1), {
    status: 206,
    headers: { 'content-range': `bytes ${a}-${b}/${body.length}` },
  })
}

describe('the shared model-file loader', () => {
  it('answers a whole entry from the cache without fetching', async () => {
    const { api, calls, sent, caches } = run()
    await caches.open('wherdr-asr-v1')
    caches.stores.get('wherdr-asr-v1')!.set('/models/m/a.onnx', fill(123).buffer)
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', 123, { cache: 'wherdr-asr-v1', chunk: CHUNK })
    expect((await bytes(res)).length).toBe(123)
    expect(calls).toEqual([])
    expect(sent).toEqual([])
  })

  it('reads all the cached ?chunk=N slices in order', async () => {
    const { api, calls, sent, caches } = run()
    await caches.open('wherdr-asr-v1')
    const store = caches.stores.get('wherdr-asr-v1')!
    for (const [i, n] of [4, 4, 2].entries()) store.set(`/models/m/a.onnx?chunk=${i}`, fill(n).buffer)
    // bytes 10 in 4-byte slices: chunks 0, 1 and 2.
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', 10, { cache: 'wherdr-asr-v1', chunk: 4 })
    expect((await bytes(res)).length).toBe(10)
    expect(calls).toEqual([])
    expect(sent).toEqual([])
  })

  it('fails on a missing slice', async () => {
    const { api, calls, caches } = run()
    await caches.open('wherdr-asr-v1')
    caches.stores.get('wherdr-asr-v1')!.set('/models/m/a.onnx?chunk=0', fill(4).buffer)
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', 10, { cache: 'wherdr-asr-v1', chunk: 4 })
    await expect(res.arrayBuffer()).rejects.toThrow('a.onnx: not downloaded')
    expect(calls).toEqual([])
  })

  it('slices a 206 answer into ranges, posting progress as it goes', async () => {
    const body = fill(CHUNK * 2 + 123)
    const { api, sent, calls } = run({ fetchImpl: ranged(body) })
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', body.length, { cache: '', chunk: CHUNK })
    expect(sameBytes(await bytes(res), body)).toBe(true)
    expect(calls).toEqual([
      `bytes=0-${CHUNK - 1}`,
      `bytes=${CHUNK}-${CHUNK * 2 - 1}`,
      `bytes=${CHUNK * 2}-${body.length - 1}`,
    ])
    expect(sent).toEqual([
      { t: 'dl', file: 'a.onnx', got: CHUNK, total: body.length },
      { t: 'dl', file: 'a.onnx', got: CHUNK * 2, total: body.length },
      { t: 'dl', file: 'a.onnx', got: body.length, total: body.length },
    ])
  })

  it('streams a 200 answer whole, counting what arrives', async () => {
    const body = fill(5000)
    const { api, sent, calls } = run({
      fetchImpl: async () => new Response(body, { status: 200, headers: { 'content-length': String(body.length) } }),
    })
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', body.length, { cache: '', chunk: CHUNK })
    expect(sameBytes(await bytes(res), body)).toBe(true)
    expect(calls).toEqual([`bytes=0-${CHUNK - 1}`])
    expect(sent.at(-1)).toEqual({ t: 'dl', file: 'a.onnx', got: body.length, total: body.length })
    expect(sent.every(m => m.total === body.length)).toBe(true)
  })

  it('retries a 5xx answer, then downloads', async () => {
    const body = fill(10)
    let n = 0
    const { api, calls } = run({
      fetchImpl: async (url, init) => ++n <= 2 ? new Response(null, { status: 503 }) : await ranged(body)(url, init),
    })
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', body.length, { cache: '', chunk: CHUNK })
    expect(sameBytes(await bytes(res), body)).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('gives up when every try fails', async () => {
    const { api, calls } = run({ fetchImpl: async () => new Response(null, { status: 503 }) })
    // The failure surfaces when the body is drained: the stream is lazy.
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', 10, { cache: '', chunk: CHUNK })
    await expect(res.arrayBuffer()).rejects.toThrow('HTTP 503')
    expect(calls).toHaveLength(5)
  })

  it('fails on a slice that comes back short', async () => {
    const body = fill(CHUNK + 100)
    let n = 0
    const { api } = run({
      fetchImpl: async (_url, init) => {
        const m = /bytes=(\d+)-(\d+)/.exec(init.headers.range)!
        const [a, b] = [Number(m[1]), Number(m[2])]
        // Every slice after the first comes back one byte short.
        return new Response(body.subarray(a, ++n === 1 ? b + 1 : b), {
          status: 206,
          headers: { 'content-range': `bytes ${a}-${b}/${body.length}` },
        })
      },
    })
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', body.length, { cache: '', chunk: CHUNK })
    await expect(res.arrayBuffer()).rejects.toThrow(`short slice at byte ${CHUNK}`)
  })

  it('fails on a 206 with no usable content-range', async () => {
    const { api } = run({ fetchImpl: async () => new Response(fill(10), { status: 206 }) })
    const res = await api.openFile('/models/m/a.onnx', 'a.onnx', 10, { cache: '', chunk: CHUNK })
    await expect(res.arrayBuffer()).rejects.toThrow('bad content-range')
  })
})
