import { afterEach, expect, it, vi } from 'vitest'
import { useRuntimeConfig } from '#imports'
import { flushPromises } from '@vue/test-utils'
import { newVersionReady, registerServiceWorker } from '~/composables/useAppVersion'

afterEach(() => {
  newVersionReady.value = false
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('offers the new-version banner when startup uses an older cached shell', async () => {
  sessionStorage.clear()
  const config = useRuntimeConfig()
  const buildId = config.app.buildId
  config.app.buildId = 'cached-build'
  const reload = vi.spyOn(location, 'reload').mockImplementation(() => {})
  const serviceWorker = {
    controller: {},
    register: vi.fn().mockResolvedValue({ waiting: null, installing: null, addEventListener: vi.fn() }),
  }
  vi.stubGlobal('navigator', { serviceWorker })
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 'served-build' })))
  try {
    registerServiceWorker()
    await flushPromises()
    expect(newVersionReady.value).toBe(true)
    expect(reload).not.toHaveBeenCalled()
    expect(sessionStorage.getItem('wherdr:chunk-reload')).toBeNull()
  } finally {
    config.app.buildId = buildId
  }
})
