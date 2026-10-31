import { beforeEach, describe, expect, it, vi } from 'vitest'
import { asrInstalled, asrUrls, installAsr, refreshAsrInstalled, removeAsr } from '../app/utils/asrModel'

// A minimal CacheStorage: match() answers from a map, open() returns a cache
// whose put() fills the same map — enough to exercise install state.
function fakeCaches(present: string[] = []) {
  const store = new Map(present.map(u => [u, new Response('x')]))
  const put = vi.fn(async (u: string, r: Response) => { store.set(u, r) })
  const caches = {
    match: async (u: RequestInfo | URL) => store.get(String(u)),
    open: async () => ({ put }),
    delete: async () => { store.clear(); return true },
  } as unknown as CacheStorage
  return { caches, store, put }
}

beforeEach(() => { asrInstalled.value = false })

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
  it('drops the cache and the flag', async () => {
    const { caches, store } = fakeCaches(asrUrls())
    asrInstalled.value = true
    await removeAsr(caches)
    expect(asrInstalled.value).toBe(false)
    expect(store.size).toBe(0)
  })
})
