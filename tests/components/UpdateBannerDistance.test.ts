import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import UpdateBanner from '~/components/UpdateBanner.vue'
import type { UpdateInfo } from '#shared/updates'

const { ask } = vi.hoisted(() => ({ ask: vi.fn(async (_text: string) => {}) }))
mockNuxtImport('askAlfred', () => ask)

it('shows release distance without replacing the installation-specific action', async () => {
  const info: UpdateInfo = { current: '1.0.0', latest: '1.3.0', url: null, checked: true, command: 'update',
    behind: 3, missed: ['1.3.0', '1.2.0', '1.1.0'], behindAtLeast: false }
  const w = await mountSuspended(UpdateBanner, { props: { info } })
  try {
    expect(w.text()).toContain('Newer releases: 3')
    expect(w.text()).toContain('Other newer releases: 1.2.0, 1.1.0')
    expect(w.findAll('button').some(b => b.text() === 'Update with Alfred')).toBe(true)
    await w.setProps({ info: { ...info, behindAtLeast: true } })
    expect(w.text()).toContain('At least 3 newer releases')
    await w.setProps({ info: { ...info, behind: undefined, missed: undefined } })
    expect(w.text()).not.toContain('newer releases')
    expect(w.text()).toContain('Installed: 1.0.0')
  } finally { w.unmount() }
}, 60_000)

it('Update with Alfred asks Alfred for the version, with its release', async () => {
  const info: UpdateInfo = { current: '3.0.0', latest: '3.1.0', url: 'https://example.test/releases/v3.1.0', checked: true, command: 'update' }
  const w = await mountSuspended(UpdateBanner, { props: { info } })
  try {
    await w.findAll('button').find(b => b.text() === 'Update with Alfred')!.trigger('click')
    await flushPromises()
    expect(ask).toHaveBeenCalledOnce()
    expect(ask).toHaveBeenCalledWith('Update wherdr to 3.1.0: https://example.test/releases/v3.1.0')
  } finally { w.unmount() }
}, 60_000)
