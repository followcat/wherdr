// On-device model files in Cache Storage (app/utils/dictation/modelStore.ts):
// 8 MB slices, resumed after a cut, one download per model, deleted whole;
// and the catalog's ratings and WebGPU filter (deviceModels.ts).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeCaches, rangeServer } from './fakeModelCache'
import { DEVICE_CACHE, DEVICE_MODELS, qualityRating, readCatalog, runnableModels } from '../app/utils/dictation/deviceModels'
import type { DeviceModel } from '../app/utils/dictation/deviceModels'
import { CHUNK, PREPARE_URL, ServerFetchFailed, cancelInstall, deleteModel, fetchCommand, installModel, MissingOnServer, storedBytes, watchInstall } from '../app/utils/dictation/modelStore'
import type { Progress } from '../app/utils/dictation/modelStore'

const model: DeviceModel = { ...DEVICE_MODELS[0]!, id: 'm', dir: 'm', files: [{ path: 'enc.onnx', bytes: 2 * CHUNK + 5 }, { path: 'tokens.txt', bytes: 10 }] }
const total = 2 * CHUNK + 15

afterEach(() => { vi.useRealTimers() })

describe('model store', () => {
  it('downloads every slice, with progress, then counts the model as stored', async () => {
    const caches = fakeCaches()
    const server = rangeServer(model)
    const seen: number[] = []
    await installModel(model, p => seen.push(p.got), { caches, fetch: server.fetch })
    expect(server.calls).toEqual([`enc.onnx 0`, `enc.onnx ${CHUNK}`, `enc.onnx ${2 * CHUNK}`, 'tokens.txt 0'])
    expect(seen).toEqual([0, CHUNK, 2 * CHUNK, 2 * CHUNK + 5, total])
    expect([...caches.stores.get(DEVICE_CACHE)!.keys()]).toContain('/models/m/enc.onnx?chunk=2')
    expect(await storedBytes(model, { caches })).toBe(total)
  })

  it('resumes at the first missing slice after a cut', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const caches = fakeCaches()
    const cut = installModel(model, undefined, { caches, fetch: rangeServer(model, { failAt: CHUNK }).fetch })
    const failed = cut.catch(e => e)
    await vi.runAllTimersAsync()
    expect(await failed).toBeInstanceOf(TypeError)
    expect(await storedBytes(model, { caches })).toBe(CHUNK)
    const server = rangeServer(model)
    await installModel(model, undefined, { caches, fetch: server.fetch })
    expect(server.calls[0]).toBe(`enc.onnx ${CHUNK}`)
    expect(await storedBytes(model, { caches })).toBe(total)
  })

  it('shares one download per model, and a cancel keeps what came', async () => {
    const caches = fakeCaches()
    const server = rangeServer(model)
    const first = installModel(model, undefined, { caches, fetch: server.fetch })
    const later: number[] = []
    expect(watchInstall('m', p => later.push(p.got))).toBe(first)
    expect(installModel(model)).toBe(first)
    await first
    expect(server.calls).toHaveLength(4)
    expect(later.at(-1)).toBe(total)
    expect(watchInstall('m', () => {})).toBeNull()

    const caches2 = fakeCaches()
    const run = installModel(model, (p) => { if (p.got >= CHUNK) cancelInstall('m') }, { caches: caches2, fetch: rangeServer(model).fetch })
    expect((await run.catch(e => e)).name).toBe('AbortError')
    expect(await storedBytes(model, { caches: caches2 })).toBe(CHUNK)
  })

  it('refuses a file whose size differs from the catalog', async () => {
    const caches = fakeCaches()
    const wrong = { ...model, files: [{ path: 'enc.onnx', bytes: 2 * CHUNK + 5 }] }
    const server = rangeServer({ ...model, files: [{ path: 'enc.onnx', bytes: 99 }] })
    await expect(installModel(wrong, undefined, { caches, fetch: server.fetch })).rejects.toThrow('size differs from the catalog')
  })

  it('says the server is missing the files on a 404, with the command that fetches them', async () => {
    const fetch404 = (async () => new Response(null, { status: 404 })) as typeof fetch
    const err = await installModel(model, undefined, { caches: fakeCaches(), fetch: fetch404 }).catch(e => e)
    expect(err).toBeInstanceOf(MissingOnServer)
    expect(err).toMatchObject({ path: 'enc.onnx', model: { id: 'm' } })
    expect(fetchCommand(model)).toBe(`node scripts/fetch-dictation-files.mjs runtime ${model.set}`)
  })

  it('waits for the server to fetch the files, with its progress, then downloads them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const files = rangeServer(model)
    const answers = [
      { state: 'preparing', phase: 'fetch', got: 40, total: 100 },
      { state: 'preparing', phase: 'unpack', got: 100, total: 100 },
      { state: 'ready' },
    ]
    const asked: unknown[] = []
    const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (url !== PREPARE_URL) return files.fetch(url, init)
      asked.push(JSON.parse(String(init!.body)))
      return Response.json(answers.shift())
    }) as typeof globalThis.fetch
    const seen: Progress[] = []
    const run = installModel(model, p => seen.push(p), { caches: fakeCaches(), fetch })
    await vi.runAllTimersAsync()
    await run
    expect(asked).toEqual([{ model: 'm' }, { model: 'm' }, { model: 'm' }])
    expect(seen.slice(0, 2)).toEqual([{ got: 40, total: 100, server: true, unpack: false }, { got: 100, total: 100, server: true, unpack: true }])
    expect(seen.at(-1)).toEqual({ got: total, total })
    expect(files.calls).toHaveLength(4)
  })

  it('stops on a failed server fetch, and asks nothing when the phone holds the model', async () => {
    const fail = (async () => Response.json({ state: 'error', error: 'enc.onnx: sha256 mismatch' })) as typeof fetch
    const err = await installModel(model, undefined, { caches: fakeCaches(), fetch: fail }).catch(e => e)
    expect(err).toBeInstanceOf(ServerFetchFailed)
    expect(err.message).toBe('enc.onnx: sha256 mismatch')

    const caches = fakeCaches()
    await installModel(model, undefined, { caches, fetch: rangeServer(model).fetch })
    const never = vi.fn(fail)
    await installModel(model, undefined, { caches, fetch: never })
    expect(never).not.toHaveBeenCalled()
  })

  it('counts a whole-file entry, and deletes only this model', async () => {
    const caches = fakeCaches()
    const cache = await caches.open(DEVICE_CACHE)
    await cache.put('/models/m/enc.onnx', new Response('x'))
    await cache.put('/models/m/tokens.txt?chunk=0', new Response('x'))
    await cache.put('/models/other/model.onnx', new Response('x'))
    expect(await storedBytes(model, { caches })).toBe(total)
    await deleteModel(model, { caches })
    expect([...caches.stores.get(DEVICE_CACHE)!.keys()]).toEqual(['/models/other/model.onnx'])
    expect(await storedBytes(model, { caches: null })).toBe(0)
  })
})

describe('model catalog', () => {
  it('rates quality from the published WER, FLEURS first, and says when there is none', () => {
    const parakeet = DEVICE_MODELS.find(m => m.id === 'parakeet-v3')!
    expect(qualityRating(parakeet, 'fr')).toMatchObject({ dots: 4, dataset: 'FLEURS', wer: 5.15 })
    expect(qualityRating(parakeet, 'en')).toMatchObject({ dots: 5 })
    expect(qualityRating({ ...parakeet, quality: [{ lang: 'fr', dataset: 'CV', wer: 41, source: 's' }] }, 'fr')).toMatchObject({ dots: 1 })
    expect(qualityRating({ ...parakeet, quality: [] }, 'fr')).toBeNull()
    expect(qualityRating(DEVICE_MODELS.find(m => m.id === 'sensevoice')!, 'fr')).toBe('unsupported')
  })

  it('skips unknown families and hides GPU models without the GPU', () => {
    const base = DEVICE_MODELS[0]!
    const gpu = { ...base, id: 'gpu', requires: ['webgpu', 'shader-f16'] as DeviceModel['requires'] }
    expect(readCatalog({ models: [base, { ...base, id: 'new', kind: 'qwen9' }] }).map(m => m.id)).toEqual([base.id])
    expect(runnableModels([], [base, gpu]).map(m => m.id)).toEqual([base.id])
    expect(runnableModels(['webgpu'], [base, gpu]).map(m => m.id)).toEqual([base.id])
    expect(runnableModels(['webgpu', 'shader-f16'], [base, gpu]).map(m => m.id)).toEqual([base.id, 'gpu'])
  })

  it('has exact sizes, a pinned source and a source for every figure', () => {
    for (const m of DEVICE_MODELS) {
      expect(m.files.every(f => f.bytes > 0)).toBe(true)
      expect(m.source.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(m.quality.every(q => q.source.startsWith('https://') && q.wer > 0)).toBe(true)
      if (m.speed) expect(m.speed.estimate).toBeGreaterThanOrEqual(1)
    }
  })
})
