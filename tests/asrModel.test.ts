import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ASR_MODELS, ASR_MODEL_IDS, asrInstalled, asrInstalledBy, asrModelId, asrUrls, installAsr, refreshAsrInstalled, removeAsr, selectAsrModel } from '../app/utils/asrModel'

// A minimal CacheStorage: match() answers from a map, open() returns a cache
// whose put() fills the same map — enough to exercise install state.
function fakeCaches(present: string[] = []) {
  const store = new Map(present.map(u => [u, new Response('x')]))
  const put = vi.fn(async (u: string, r: Response) => { store.set(u, r) })
  const caches = {
    match: async (u: RequestInfo | URL) => store.get(String(u)),
    open: async () => ({ put, delete: async (u: string) => store.delete(String(u)) }),
    keys: async () => ['wherdr-asr-v1'],
    delete: async () => { store.clear(); return true },
  } as unknown as CacheStorage
  return { caches, store, put }
}

beforeEach(() => { asrInstalledBy.value = {}; selectAsrModel(ASR_MODEL_IDS[0]!) })

describe('asrUrls', () => {
  it('lists every file the worker needs, per model', () => {
    for (const id of ASR_MODEL_IDS) {
      const urls = asrUrls(id)
      expect(urls.length).toBe(ASR_MODELS[id]!.files.length)
      expect(urls.every(u => u.startsWith(ASR_MODELS[id]!.base))).toBe(true)
    }
  })
})

describe('asrInstalled', () => {
  it('is false until every model file is cached', async () => {
    const { caches, store } = fakeCaches()
    expect(await refreshAsrInstalled(caches)).toBe(false)
    for (const u of asrUrls().slice(0, -1)) store.set(u, new Response('x'))
    expect(await refreshAsrInstalled(caches)).toBe(false)
    store.set(asrUrls().at(-1)!, new Response('x'))
    expect(await refreshAsrInstalled(caches)).toBe(true)
    expect(asrInstalled.value).toBe(true)
  })

  it('tracks install state per model', async () => {
    const { caches, store } = fakeCaches()
    for (const u of asrUrls('qwen3')) store.set(u, new Response('x'))
    await refreshAsrInstalled(caches)
    expect(asrInstalledBy.value.qwen3).toBe(true)
    expect(asrInstalledBy.value.sensevoice).toBe(false)
    selectAsrModel('qwen3')
    expect(asrInstalled.value).toBe(true)
  })

  it('stays false without Cache Storage', async () => {
    expect(await refreshAsrInstalled(undefined)).toBe(false)
  })
})

describe('installAsr', () => {
  it('caches every model file, reports progress, flips installed', async () => {
    const { caches, put } = fakeCaches()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data', { headers: { 'content-length': '4' } })))
    const progress: number[] = []
    await installAsr(p => progress.push(p.done), caches)
    expect(put).toHaveBeenCalledTimes(asrUrls().length)
    expect(asrInstalled.value).toBe(true)
    expect(progress.at(-1)).toBe(asrUrls().length)
    vi.unstubAllGlobals()
  })

  it('skips files already cached', async () => {
    const { caches, put } = fakeCaches([asrUrls()[0]!])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data')))
    await installAsr(undefined, caches)
    expect(put).toHaveBeenCalledTimes(asrUrls().length - 1)
    vi.unstubAllGlobals()
  })

  it('propagates a failed download and stays uninstalled', async () => {
    const { caches } = fakeCaches()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 404 })))
    await expect(installAsr(undefined, caches)).rejects.toThrow('HTTP 404')
    expect(asrInstalled.value).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('removeAsr', () => {
  it('drops only the selected model\'s files', async () => {
    const { caches, store } = fakeCaches([...asrUrls('sensevoice'), ...asrUrls('qwen3')])
    await refreshAsrInstalled(caches)
    selectAsrModel('qwen3')
    await removeAsr(caches)
    expect(asrInstalledBy.value.qwen3).toBe(false)
    expect(asrInstalledBy.value.sensevoice).toBe(true)
  })
})
