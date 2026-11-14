// On-device model files in Cache Storage, kept as 8 MB slices (one entry per
// `file?chunk=N`): a download cut by a tunnel or a mobile link resumes at the
// first missing slice, and no file is ever assembled in memory. Settings
// (install, delete, space used) and the device engine (download on first use)
// share one download per model. The worker reads the same slices.
// Based on followcat's installAsr / fetchModelFile (followcat/wherdr, branch mobile, MIT).
import { DEVICE_CACHE } from './deviceModels'
import type { DeviceModel } from './deviceModels'

// What the store needs of a model: a dictation model, or a read-aloud voice
// (app/utils/speech/neuralVoice.ts) with its catalog members as files.
export type StoredModel = Pick<DeviceModel, 'id' | 'dir' | 'set' | 'files'>

export const CHUNK = 8 * 1024 * 1024
export const fileUrl = (m: StoredModel, path: string) => `/models/${m.dir}/${path}`
export const chunkUrl = (url: string, i: number) => `${url}?chunk=${i}`
export const chunkCount = (bytes: number) => Math.max(1, Math.ceil(bytes / CHUNK))
const chunkEnd = (bytes: number, i: number) => Math.min(bytes, (i + 1) * CHUNK) - 1

// The server answers 404: its DATA_DIR/models has no such file (an older
// server that cannot fetch it itself, and the fetch script was not run there).
export class MissingOnServer extends Error {
  constructor(readonly model: StoredModel, readonly path: string) {
    super(`${path}: HTTP 404`)
    this.name = 'MissingOnServer'
  }
}

// The command that fetches this model's files on the server.
export const fetchCommand = (m: StoredModel) => `node scripts/fetch-dictation-files.mjs runtime ${m.set}`

export interface StoreDeps { caches?: CacheStorage | null, fetch?: typeof fetch }
// `server`: the wherdr server is still fetching the files (`unpack`: extracting them).
export interface Progress { got: number, total: number, server?: boolean, unpack?: boolean }

// The server fetched this model's files and failed (a link down, a sha256 mismatch).
export class ServerFetchFailed extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ServerFetchFailed'
  }
}

export const PREPARE_URL = '/api/dictation/prepare'
export const PREPARE_POLL_MS = 1000

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason) }, { once: true })
})

// Ask the server for the model's files (server/utils/dictationServerFiles.ts):
// when it lacks them it fetches them, and this follows its progress until they
// are there. An older server without the route, a refusal or no answer to the
// first request is left to the download, which says what went wrong; once the
// server fetches, a dropped poll is retried.
export async function prepareOnServer(m: StoredModel, deps: StoreDeps, signal: AbortSignal, onProgress: (p: Progress) => void) {
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: m.id }), signal }
  for (let first = true; ; first = false) {
    let r: Response
    try { r = first ? await doFetch(PREPARE_URL, init) : await refetch(() => doFetch(PREPARE_URL, init), signal) }
    catch (e) {
      if (signal.aborted) throw signal.reason
      if (first) return
      throw e
    }
    if (!r.ok) { await r.body?.cancel(); return }
    const s = await r.json() as { state: string, got?: number, total?: number, phase?: string, error?: string }
    if (s.state === 'ready' || s.state === 'missing') return
    if (s.state === 'error') throw new ServerFetchFailed(s.error || 'The server could not fetch the files')
    onProgress({ got: s.got ?? 0, total: s.total ?? 0, server: true, unpack: s.phase === 'unpack' })
    await pause(PREPARE_POLL_MS, signal)
  }
}

const cachesOf = (d: StoreDeps) => (d.caches === undefined ? globalThis.caches ?? null : d.caches)
const keyOf = (u: string) => { const url = new URL(u, 'http://x'); return url.pathname + url.search }

// Bytes of the model this device holds (an F2 whole-file entry counts too).
export async function storedBytes(m: StoredModel, deps: StoreDeps = {}): Promise<number> {
  const cs = cachesOf(deps)
  if (!cs) return 0
  const keys = new Set((await (await cs.open(DEVICE_CACHE)).keys()).map(r => keyOf(r.url)))
  let have = 0
  for (const f of m.files) {
    const url = fileUrl(m, f.path)
    if (keys.has(url)) { have += f.bytes; continue }
    for (let i = 0; i < chunkCount(f.bytes); i++) {
      if (keys.has(chunkUrl(url, i))) have += chunkEnd(f.bytes, i) - i * CHUNK + 1
    }
  }
  return have
}

async function refetch(doFetch: () => Promise<Response>, signal?: AbortSignal): Promise<Response> {
  let lastErr: unknown = null
  for (let i = 0; i < 5; i++) {
    signal?.throwIfAborted()
    try {
      const r = await doFetch()
      if (r.status < 500) return r
      lastErr = new Error(`HTTP ${r.status}`)
    }
    catch (e) {
      if (signal?.aborted) throw e
      lastErr = e
    }
    await new Promise(r => setTimeout(r, 700 * (i + 1)))
  }
  throw lastErr
}

async function download(m: StoredModel, deps: StoreDeps, signal: AbortSignal, onProgress: (p: Progress) => void) {
  const cs = cachesOf(deps)
  if (!cs) throw new Error('This browser cannot keep files (no Cache Storage)')
  const doFetch = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const cache = await cs.open(DEVICE_CACHE)
  const total = m.files.reduce((n, f) => n + f.bytes, 0)
  let got = await storedBytes(m, deps)
  // A model the phone holds whole is not asked for: it loads offline too.
  if (got < total) await prepareOnServer(m, deps, signal, onProgress)
  onProgress({ got, total })
  for (const f of m.files) {
    const url = fileUrl(m, f.path)
    if (await cache.match(url)) continue
    for (let i = 0; i < chunkCount(f.bytes); i++) {
      const key = chunkUrl(url, i)
      if (await cache.match(key)) continue
      const start = i * CHUNK
      const end = chunkEnd(f.bytes, i)
      const res = await refetch(() => doFetch(url, { headers: { range: `bytes=${start}-${end}` }, signal }), signal)
      if (res.status === 404) throw new MissingOnServer(m, f.path)
      if (res.status !== 206) throw new Error(`${f.path}: HTTP ${res.status}`)
      if (Number(res.headers.get('content-range')?.split('/')[1]) !== f.bytes) throw new Error(`${f.path}: size differs from the catalog`)
      const part = await res.arrayBuffer()
      if (part.byteLength !== end - start + 1) throw new Error(`${f.path}: short slice at byte ${start}`)
      await cache.put(key, new Response(part, { headers: { 'content-type': 'application/octet-stream' } }))
      got += part.byteLength
      onProgress({ got, total })
    }
  }
}

interface Running { promise: Promise<void>, abort: AbortController, listeners: Set<(p: Progress) => void>, last: Progress | null }
const running = new Map<string, Running>()

// Download what is missing. A second call for the same model joins the first.
// The browser is asked to keep the site's storage (it may still say no).
export function installModel(m: StoredModel, onProgress?: (p: Progress) => void, deps: StoreDeps = {}): Promise<void> {
  let run = running.get(m.id)
  if (!run) {
    const r: Running = { abort: new AbortController(), listeners: new Set(), last: null, promise: Promise.resolve() }
    globalThis.navigator?.storage?.persist?.().catch(() => {})
    r.promise = download(m, deps, r.abort.signal, (p) => { r.last = p; for (const l of r.listeners) l(p) })
      .finally(() => running.delete(m.id))
    running.set(m.id, r)
    run = r
  }
  if (onProgress) {
    run.listeners.add(onProgress)
    if (run.last) onProgress(run.last)
  }
  return run.promise
}

// The download running for this model, if any: Settings shows its progress.
export function watchInstall(id: string, onProgress: (p: Progress) => void): Promise<void> | null {
  const run = running.get(id)
  if (!run) return null
  run.listeners.add(onProgress)
  if (run.last) onProgress(run.last)
  return run.promise
}

// Stop a download; the slices already kept stay for the next try.
export function cancelInstall(id: string): void {
  running.get(id)?.abort.abort()
}

export async function deleteModel(m: StoredModel, deps: StoreDeps = {}): Promise<void> {
  cancelInstall(m.id)
  const cs = cachesOf(deps)
  if (!cs) return
  const cache = await cs.open(DEVICE_CACHE)
  const prefix = `/models/${m.dir}/`
  for (const r of await cache.keys()) {
    if (keyOf(r.url).startsWith(prefix)) await cache.delete(r)
  }
}

export interface StorageInfo { free: number | null, persisted: boolean | null }

export async function storageInfo(storage = globalThis.navigator?.storage): Promise<StorageInfo> {
  const est = await storage?.estimate?.().catch(() => null)
  const free = est?.quota != null && est.usage != null ? Math.max(0, est.quota - est.usage) : null
  const persisted = storage?.persisted ? await storage.persisted().catch(() => null) : null
  return { free, persisted }
}
