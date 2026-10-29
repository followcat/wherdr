import { describe, expect, it, vi } from 'vitest'
import { createUpdateChecker, RELEASES_URL } from '../server/utils/updates'

describe('newer stable releases', () => {
  const releases = [
    { tag_name: 'v1.3.0' }, { tag_name: 'v1.10.0' }, { tag_name: 'v1.2.0' },
    { tag_name: 'v2.0.0-beta.1', prerelease: true }, { tag_name: 'v9.0.0', draft: true },
    { tag_name: 'not-a-version' },
  ]
  const fetcher = (body = releases) => vi.fn(async (_url: string) => ({ ok: true, json: async () => body }))

  it('counts only newer stable versions in numeric order without disabling plugin updates', async () => {
    const fetch = fetcher()
    const check = createUpdateChecker({ current: '1.2.0', env: { WHERDR_INSTALL: 'plugin' }, fetch })
    expect(await check()).toMatchObject({ latest: '1.10.0', behind: 2, missed: ['1.10.0', '1.3.0'], behindAtLeast: false, mode: 'plugin', oneTap: true })
    expect(fetch).toHaveBeenCalledTimes(3) // existing release, archive and checksum checks
    expect(fetch).toHaveBeenCalledWith(RELEASES_URL)
  })

  it('bounds the version list while keeping the full count', async () => {
    const fetch = fetcher(Array.from({ length: 8 }, (_, i) => ({ tag_name: `v1.${i + 1}.0` })))
    expect(await createUpdateChecker({ current: '1.0.0', env: {}, fetch })()).toMatchObject({ behind: 8, missed: ['1.8.0', '1.7.0', '1.6.0', '1.5.0', '1.4.0'] })
  })

  it('reports a lower bound when the release response fills the API page', async () => {
    const fetch = fetcher(Array.from({ length: 100 }, (_, i) => ({ tag_name: `v1.${i + 1}.0` })))
    expect(await createUpdateChecker({ current: '1.0.0', env: {}, fetch })()).toMatchObject({ behind: 100, behindAtLeast: true })
  })

  it.each(['1.10.0', '2.0.0'])('has no missed releases when current is %s', async current => {
    expect(await createUpdateChecker({ current, env: {}, fetch: fetcher() })()).toMatchObject({ latest: null, behind: 0, missed: [], behindAtLeast: false })
  })

  it('does not invent a count when checking is disabled or unavailable', async () => {
    const fetch = fetcher()
    expect(await createUpdateChecker({ current: '1.0.0', env: { WHERDR_UPDATE_CHECK: 'off' }, fetch })()).toMatchObject({ checked: false, behind: 0, missed: [] })
    expect(fetch).not.toHaveBeenCalled()
    expect(await createUpdateChecker({ current: '1.0.0', env: {}, fetch: async () => { throw new Error('offline') } })()).toMatchObject({ checked: false, behind: 0, missed: [] })
  })
})
