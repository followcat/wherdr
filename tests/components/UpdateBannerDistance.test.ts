import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import UpdateBanner from '~/components/UpdateBanner.vue'
import type { UpdateInfo } from '#shared/updates'

it('shows release distance without replacing the installation-specific action', async () => {
  const info: UpdateInfo = { current: '1.0.0', latest: '1.3.0', url: null, checked: true, mode: 'plugin', command: 'update', oneTap: true,
    behind: 3, missed: ['1.3.0', '1.2.0', '1.1.0'], behindAtLeast: false }
  const w = await mountSuspended(UpdateBanner, { props: { info } })
  try {
    expect(w.text()).toContain('Newer releases: 3')
    expect(w.text()).toContain('Other newer releases: 1.2.0, 1.1.0')
    expect(w.findAll('button').some(b => b.text() === 'Update')).toBe(true)
    await w.setProps({ info: { ...info, behindAtLeast: true } })
    expect(w.text()).toContain('At least 3 newer releases')
    await w.setProps({ info: { ...info, behind: undefined, missed: undefined } })
    expect(w.text()).not.toContain('newer releases')
    expect(w.text()).toContain('Installed: 1.0.0')
  } finally { w.unmount() }
}, 60_000)
