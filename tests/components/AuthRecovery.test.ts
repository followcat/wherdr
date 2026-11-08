import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { confirmLock, connectEvents, locked, showLock, start } from '~/composables/useHerdr'
import { mayReadOffline, readOfflineAccess, setOfflineAccess } from '~/utils/offlineAccess'

vi.mock('~/utils/offlineCache', () => ({
  readHome: async () => null, saveHome: vi.fn(), clearOffline: vi.fn(),
}))

beforeEach(() => {
  vi.useFakeTimers()
  showLock()
  // Native AbortSignal.timeout does not use Vitest's clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms)
    return controller.signal
  })
  vi.stubGlobal('WebSocket', class { readyState = 0; close() {} })
})

afterEach(() => {
  showLock()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function statusAfter(ms: number | null) {
  vi.stubGlobal('fetch', vi.fn((path: string, opts?: RequestInit) => {
    if (!path.startsWith('/api/auth/status')) return Promise.resolve(Response.json({}))
    return new Promise<Response>((resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true })
      if (ms !== null) setTimeout(() => resolve(Response.json({
        enabled: true, unlocked: true, now: Date.now(), expiresAt: Date.now() + 60_000,
      })), ms)
    })
  }))
}

it.each(['start', 'confirmLock'] as const)('%s saves a slow unlock status before the next suspend', async operation => {
  statusAfter(4000)
  let done = false
  const pending = (operation === 'start' ? start() : confirmLock()).then(() => { done = true })
  await vi.advanceTimersByTimeAsync(3000)
  expect(done).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  await pending
  expect(mayReadOffline(readOfflineAccess())).toBe(true)

  // A failed read on resume must retain the lease obtained after unlock.
  statusAfter(null)
  const resume = start({ resume: true })
  await vi.advanceTimersByTimeAsync(3000)
  await resume
  expect(locked.value).toBe(false)
  expect(mayReadOffline(readOfflineAccess())).toBe(true)
})

it.each([false, true])('bounds a silent status read on resume=%s without revealing an expired cache', async resume => {
  setOfflineAccess({ enabled: true, expiresAt: Date.now() - 1 })
  statusAfter(null)
  let done = false
  const pending = start({ resume }).then(() => { done = true })
  const limit = resume ? 3000 : 10_000
  await vi.advanceTimersByTimeAsync(limit - 1)
  expect(done).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(done).toBe(true)
  await pending
  expect(locked.value).toBe(true)
  expect(readOfflineAccess()).toBeNull()
})

it.each([false, true])('bounds a silent confirmation on resume=%s while keeping a valid lease', async resume => {
  setOfflineAccess({ enabled: true, expiresAt: Date.now() + 60_000 })
  statusAfter(null)
  let done = false
  const pending = confirmLock({ resume }).then(() => { done = true })
  await vi.advanceTimersByTimeAsync((resume ? 3000 : 10000) - 1)
  expect(done).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(done).toBe(true)
  await pending
  expect(mayReadOffline(readOfflineAccess())).toBe(true)
})

it.each([false, true])('closes an open events socket only while its first real packet is missing=%s', async missing => {
  statusAfter(null)
  const close = vi.fn()
  let ws!: { readyState: number, onopen: () => void, onmessage: (e: { data: string }) => void }
  vi.stubGlobal('WebSocket', class {
    readyState = 0
    close = close
    send = vi.fn()
    constructor() { ws = this as unknown as typeof ws }
  })
  locked.value = false
  connectEvents()
  ws.readyState = 1
  ws.onopen()
  ws.onmessage({ data: JSON.stringify(missing ? { type: 'pong' } : { ok: true, ready: true, panes: [], workspaces: [] }) })
  await vi.advanceTimersByTimeAsync(7999)
  expect(close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(close).toHaveBeenCalledTimes(missing ? 1 : 0)
})
