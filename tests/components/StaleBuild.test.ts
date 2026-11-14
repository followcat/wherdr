import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { newVersionReady, offerNewBuild } from '~/composables/useAppVersion'

// A file of the running build could not be loaded (removed by a deployment, or
// the server restarting): the banner when a newer build is served, never a reload.
const served = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }))

let reload: ReturnType<typeof vi.fn>
beforeEach(() => {
  newVersionReady.value = false
  reload = vi.fn()
  vi.stubGlobal('location', { ...window.location, hash: '', pathname: '/', search: '', reload, replace: vi.fn() })
})
afterEach(() => { vi.unstubAllGlobals() })

it('does nothing when the server still serves this build or is unreachable', async () => {
  vi.stubGlobal('fetch', served({ id: useRuntimeConfig().app.buildId }))
  expect(await offerNewBuild()).toBe(false)
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
  expect(await offerNewBuild()).toBe(false)
  expect(reload).not.toHaveBeenCalled()
  expect(newVersionReady.value).toBe(false)
})

it('offers a newer build with the banner, without reloading', async () => {
  vi.stubGlobal('fetch', served({ id: 'newer-build' }))
  expect(await offerNewBuild()).toBe(true)
  expect(newVersionReady.value).toBe(true)
  expect(reload).not.toHaveBeenCalled()
})
