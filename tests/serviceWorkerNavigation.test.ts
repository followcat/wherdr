import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.resetModules() })

async function navigation(hit: Response | undefined, network: Promise<Response>, start?: string) {
  vi.useFakeTimers()
  const handlers: Record<string, (event: unknown) => void> = {}
  const put = vi.fn()
  vi.stubGlobal('self', {
    __WB_MANIFEST: [], location: new URL('https://app.example'),
    addEventListener: (type: string, fn: (event: unknown) => void) => { handlers[type] = fn },
  })
  // The device's app start choice (shared/appStart.ts), read from its own cache.
  const open = async (name: string) => (name === 'wherdr-device'
    ? { match: async () => (start ? new Response(start) : undefined) }
    : { put })
  vi.stubGlobal('caches', { match: vi.fn().mockResolvedValue(hit), open })
  vi.stubGlobal('fetch', vi.fn().mockReturnValue(network))
  await import('../app/service-worker/sw')
  let served: Response | undefined
  const background: Promise<unknown>[] = []
  handlers.fetch!({
    request: { method: 'GET', url: 'https://app.example/?open=agent', mode: 'navigate' },
    respondWith: (response: Promise<Response>) => { void response.then(r => { served = r }) },
    waitUntil: (work: Promise<unknown>) => background.push(work),
  })
  await vi.advanceTimersByTimeAsync(0)
  return { served: () => served, background, put }
}

it('serves the current build when the network answers within the wait', async () => {
  const result = await navigation(new Response('cached shell'), Promise.resolve(new Response('next shell')))
  expect(await result.served()?.text()).toBe('next shell')
  await Promise.all(result.background)
})

it('falls back to the cached shell when the network is slow, and still refreshes the cache', async () => {
  const network = Promise.withResolvers<Response>()
  const result = await navigation(new Response('cached shell'), network.promise)
  await vi.advanceTimersByTimeAsync(2900)
  expect(result.served()).toBeUndefined()
  await vi.advanceTimersByTimeAsync(100)
  expect(await result.served()?.text()).toBe('cached shell')
  network.resolve(new Response('next shell'))
  await Promise.all(result.background)
  expect(await result.put.mock.calls[0]![1].text()).toBe('next shell')
})

it('serves the cached shell at once when the network is down', async () => {
  const result = await navigation(new Response('cached shell'), Promise.reject(new TypeError('offline')))
  expect(await result.served()?.text()).toBe('cached shell')
})

it('waits for the network when the shell has not been cached', async () => {
  const network = Promise.withResolvers<Response>()
  const result = await navigation(undefined, network.promise)
  await vi.advanceTimersByTimeAsync(30000)
  expect(result.served()).toBeUndefined()
  network.resolve(new Response('first shell'))
  await Promise.all(result.background)
  await vi.advanceTimersByTimeAsync(0)
  expect(await result.served()?.text()).toBe('first shell')
})

it('serves the cached shell at once on Instant start, and still refreshes the cache', async () => {
  const network = Promise.withResolvers<Response>()
  const result = await navigation(new Response('cached shell'), network.promise, 'cache')
  expect(await result.served()?.text()).toBe('cached shell')
  network.resolve(new Response('next shell'))
  await Promise.all(result.background)
  expect(await result.put.mock.calls[0]![1].text()).toBe('next shell')
})
