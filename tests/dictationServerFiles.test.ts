// server/utils/dictationServerFiles.ts: Install has the server fetch a model's
// missing files with the fetch script's checks, one fetch at a time, shared
// by concurrent requests, resumed after a cut.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createServerFiles } from '../server/utils/dictationServerFiles'
import type { ServerFilesState } from '../server/utils/dictationServerFiles'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const made: string[] = []
const tmp = () => { const d = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), 'hw-srvfiles-')); made.push(d); return d }
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })
const rt = Buffer.from('r'.repeat(300))
const enc = Buffer.from('e'.repeat(2000))

// A remote that honours Range; `hold` keeps answers until `release()`.
function remote(files: Record<string, Buffer>, o: { hold?: boolean } = {}) {
  const calls: string[] = []
  let release = () => {}
  const gate = o.hold ? new Promise<void>((r) => { release = r }) : Promise.resolve()
  const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const name = String(url).split('/').pop()!
    const range = new Headers(init?.headers).get('range')
    calls.push(range ? `${name} ${range}` : name)
    await gate
    const data = files[name]
    if (!data) return new Response(null, { status: 404 })
    const start = range ? Number(/bytes=(\d+)-/.exec(range)![1]) : 0
    if (start >= data.length) return new Response(null, { status: 416 })
    const body = data.subarray(start)
    return new Response(body, { status: range ? 206 : 200, headers: { 'content-length': String(body.length) } })
  }
  return { fetch: fetch as typeof globalThis.fetch, calls, release: () => release() }
}

const model = { id: 'm1', set: 'm1set', dir: 'm1', files: [{ path: 'enc.onnx', bytes: enc.length }] }
const sets = (encSha = sha(enc)) => ({
  runtime: [{ url: 'https://x/rt.js', sha256: sha(rt), to: 'runtime/r-1/rt.js' }],
  m1set: [{ url: 'https://x/enc.onnx', sha256: encSha, to: 'm1/enc.onnx' }],
})

async function until(files: ReturnType<typeof createServerFiles>, id: string): Promise<ServerFilesState[]> {
  const seen: ServerFilesState[] = []
  for (let i = 0; i < 200; i++) {
    const s = await files.prepare(id)
    seen.push(s)
    if (s.state === 'ready' || s.state === 'error') return seen
    await new Promise(r => setTimeout(r, 5))
  }
  throw new Error('never settled')
}

describe('server dictation files', () => {
  it('says ready without fetching when the files are there, missing when asked not to fetch', async () => {
    const dir = tmp()
    const r = remote({})
    const files = createServerFiles({ modelsDir: dir, models: [model], sets: sets(), fetch: r.fetch })
    expect(await files.prepare('m1', false)).toEqual({ state: 'missing' })
    mkdirSync(path.join(dir, 'runtime/r-1'), { recursive: true })
    mkdirSync(path.join(dir, 'm1'))
    writeFileSync(path.join(dir, 'runtime/r-1/rt.js'), rt)
    writeFileSync(path.join(dir, 'm1/enc.onnx'), enc)
    expect(await files.prepare('m1')).toEqual({ state: 'ready' })
    expect(r.calls).toEqual([])
    await expect(files.prepare('nope')).rejects.toThrow(/Unknown model/)
  })

  it('fetches the runtime and the model once for concurrent requests, with progress', async () => {
    const dir = tmp()
    const r = remote({ 'rt.js': rt, 'enc.onnx': enc }, { hold: true })
    const files = createServerFiles({ modelsDir: dir, models: [model], sets: sets(), fetch: r.fetch })
    const [a, b] = await Promise.all([files.prepare('m1'), files.prepare('m1')])
    expect(a.state).toBe('preparing')
    expect(b.state).toBe('preparing')
    r.release()
    const seen = await until(files, 'm1')
    expect(seen.at(-1)).toEqual({ state: 'ready' })
    expect(r.calls).toEqual(['rt.js', 'enc.onnx'])
    expect(readFileSync(path.join(dir, 'm1/enc.onnx'))).toEqual(enc)
    for (const s of seen) if (s.state === 'preparing') expect(s.got).toBeLessThanOrEqual(s.total)
  })

  it('runs one fetch at a time across models, and does not fetch the shared runtime twice', async () => {
    const dir = tmp()
    const enc2 = Buffer.from('f'.repeat(500))
    const m2 = { id: 'm2', set: 'm2set', dir: 'm2', files: [{ path: 'enc2.onnx', bytes: enc2.length }] }
    const r = remote({ 'rt.js': rt, 'enc.onnx': enc, 'enc2.onnx': enc2 }, { hold: true })
    const files = createServerFiles({
      modelsDir: dir, models: [model, m2], fetch: r.fetch,
      sets: { ...sets(), m2set: [{ url: 'https://x/enc2.onnx', sha256: sha(enc2), to: 'm2/enc2.onnx' }] },
    })
    await files.prepare('m1')
    await files.prepare('m2')
    while (!r.calls.length) await new Promise(res => setTimeout(res, 5))
    await new Promise(res => setTimeout(res, 30))
    expect(r.calls).toEqual(['rt.js']) // m2 waits for m1
    r.release()
    await until(files, 'm1')
    expect((await until(files, 'm2')).at(-1)).toEqual({ state: 'ready' })
    expect(r.calls).toEqual(['rt.js', 'enc.onnx', 'enc2.onnx'])
  })

  it('refuses a file whose sha256 differs, says so once, then tries again', async () => {
    const dir = tmp()
    const r = remote({ 'rt.js': rt, 'enc.onnx': Buffer.from('tampered') })
    const files = createServerFiles({ modelsDir: dir, models: [model], sets: sets(), fetch: r.fetch, retryMs: 1 })
    const last = (await until(files, 'm1')).at(-1)!
    expect(last.state).toBe('error')
    expect((last as { error: string }).error).toMatch(/enc\.onnx: sha256 mismatch/)
    expect(existsSync(path.join(dir, 'm1/enc.onnx')) || existsSync(path.join(dir, 'm1/enc.onnx.part'))).toBe(false)
    // The runtime came whole and stays; the next request fetches only the model again.
    expect(readFileSync(path.join(dir, 'runtime/r-1/rt.js'))).toEqual(rt)
    const before = r.calls.length
    expect((await files.prepare('m1')).state).toBe('preparing')
    await until(files, 'm1')
    expect(r.calls.slice(before).every(c => c.startsWith('enc.onnx'))).toBe(true)
  })

  it('resumes a part left by a cut fetch', async () => {
    const dir = tmp()
    mkdirSync(path.join(dir, 'm1'), { recursive: true })
    writeFileSync(path.join(dir, 'm1/enc.onnx.part'), enc.subarray(0, 1200))
    const r = remote({ 'rt.js': rt, 'enc.onnx': enc })
    const files = createServerFiles({ modelsDir: dir, models: [model], sets: sets(), fetch: r.fetch })
    expect((await until(files, 'm1')).at(-1)).toEqual({ state: 'ready' })
    expect(r.calls).toEqual(['rt.js', 'enc.onnx bytes=1200-'])
    expect(readFileSync(path.join(dir, 'm1/enc.onnx'))).toEqual(enc)
  })

  it('unpacks a model archive and then counts it as there', async () => {
    const src = tmp()
    mkdirSync(path.join(src, 'pack'))
    writeFileSync(path.join(src, 'pack/enc.onnx'), enc)
    writeFileSync(path.join(src, 'pack/extra.txt'), 'not listed')
    execFileSync('tar', ['-cjf', path.join(src, 'pack.tar.bz2'), '-C', src, 'pack'])
    const archive = readFileSync(path.join(src, 'pack.tar.bz2'))
    const dir = tmp()
    const r = remote({ 'rt.js': rt, 'pack.tar.bz2': archive })
    const files = createServerFiles({
      modelsDir: dir, models: [model], fetch: r.fetch,
      sets: { runtime: sets().runtime, m1set: [{ url: 'https://x/pack.tar.bz2', sha256: sha(archive), dir: 'm1', members: ['enc.onnx'] }] },
    })
    expect((await until(files, 'm1')).at(-1)).toEqual({ state: 'ready' })
    expect(readFileSync(path.join(dir, 'm1/enc.onnx'))).toEqual(enc)
    expect(existsSync(path.join(dir, 'm1/extra.txt'))).toBe(false)
    expect(await files.prepare('m1')).toEqual({ state: 'ready' })
    expect(r.calls).toEqual(['rt.js', 'pack.tar.bz2'])
    // A file gone, its stamp left: fetched again, not counted as there.
    rmSync(path.join(dir, 'm1/enc.onnx'))
    expect((await until(files, 'm1')).at(-1)).toEqual({ state: 'ready' })
    expect(r.calls).toEqual(['rt.js', 'pack.tar.bz2', 'pack.tar.bz2'])
    expect(readFileSync(path.join(dir, 'm1/enc.onnx'))).toEqual(enc)
  })
})
