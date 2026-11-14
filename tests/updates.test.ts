import { describe, expect, it, vi } from 'vitest'
import { compareVersions, parseVersion } from '../shared/updates'
import { RELEASES_URL, createUpdateChecker } from '../server/utils/updates'

describe('versions', () => {
  it('reads numbers with or without v', () => {
    expect(parseVersion('v1.2.3')).toEqual([1, 2, 3])
    expect(parseVersion('1.10.0-beta.1')).toEqual([1, 10, 0])
    expect(parseVersion('latest')).toBeNull()
  })
  it('compares numerically', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
    expect(compareVersions('v1.1.0', '1.1.0')).toBe(0)
    expect(compareVersions('1.0.9', '1.1.0')).toBeLessThan(0)
    expect(compareVersions('n/a', '1.0.0')).toBe(0)
  })
})

function release(tag: string) {
  return vi.fn(async (_url: string) => ({ ok: true, json: async () => ([{ tag_name: tag, html_url: `https://example.test/releases/${tag}`, body: '## Upgrade notes' }]) }))
}

describe('release check', () => {
  it('reports a newer version', async () => {
    const fetch = release('v1.2.0')
    const check = createUpdateChecker({ current: '1.1.0', env: {}, fetch })
    const u = await check()
    expect(fetch).toHaveBeenCalledWith(RELEASES_URL)
    expect(u).toEqual({ current: '1.1.0', latest: '1.2.0', url: 'https://example.test/releases/v1.2.0', notes: '## Upgrade notes', checked: true, command: 'git pull && npm ci && npm run build', behind: 1, missed: ['1.2.0'], behindAtLeast: false })
  })

  it('offers only newer releases of the running major', async () => {
    const releases = (...tags: string[]) => vi.fn(async (_url: string) => ({ ok: true, json: async () => tags.map(tag => ({ tag_name: tag, html_url: '' })) }))
    // v3 before its release: the last v2 release is not offered, 3.0.0 is.
    const v2 = await createUpdateChecker({ current: '3.0.0-dev', env: {}, fetch: releases('v2.6.0', 'v2.5.0') })()
    expect(v2).toMatchObject({ latest: null, checked: true, behind: 0 })
    expect((await createUpdateChecker({ current: '3.0.0-dev', env: {}, fetch: releases('v3.0.0', 'v2.6.0') })()).latest).toBe('3.0.0')
    const u = await createUpdateChecker({ current: '3.0.0', env: {}, fetch: releases('v2.7.0', 'v4.0.0', 'v3.1.0', 'v3.0.1') })()
    expect(u).toMatchObject({ latest: '3.1.0', behind: 2, missed: ['3.1.0', '3.0.1'] })
  })

  it('says nothing when up to date or ahead', async () => {
    expect((await createUpdateChecker({ current: '1.2.0', env: {}, fetch: release('v1.2.0') })()).latest).toBeNull()
    const u = await createUpdateChecker({ current: '1.3.0', env: {}, fetch: release('v1.2.0') })()
    expect(u.latest).toBeNull()
    expect(u.checked).toBe(true)
  })

  it('keeps the result for a day', async () => {
    let t = 0
    const fetch = release('v2.0.0')
    const check = createUpdateChecker({ current: '1.0.0', env: {}, fetch, now: () => t })
    await Promise.all([check(), check()])
    t += 23 * 3600e3
    await check()
    expect(fetch).toHaveBeenCalledTimes(1)
    t += 2 * 3600e3
    await check()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('retries an hour after a failure', async () => {
    let t = 0
    const fetch = vi.fn(async () => ({ ok: false, json: async () => ({}) }))
    const check = createUpdateChecker({ current: '1.0.0', env: {}, fetch, now: () => t })
    expect(await check()).toMatchObject({ latest: null, checked: false })
    t += 30 * 60e3
    await check()
    expect(fetch).toHaveBeenCalledTimes(1)
    t += 31 * 60e3
    await check()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('WHERDR_UPDATE_CHECK=off : aucun appel', async () => {
    const fetch = release('v9.0.0')
    const u = await createUpdateChecker({ current: '1.0.0', env: { WHERDR_UPDATE_CHECK: 'OFF' }, fetch })()
    expect(fetch).not.toHaveBeenCalled()
    expect(u).toMatchObject({ latest: null, checked: false })
  })
})

describe('transient errors', () => {
  it('keeps a previously read notice through a network error', async () => {
    let time = 0, offline = false
    const check = createUpdateChecker({ current: '1.3.2', env: {}, now: () => time,
      fetch: async () => {
        if (offline) throw new Error('offline')
        return { ok: true, json: async () => [{ tag_name: 'v1.3.3' }] }
      } })
    expect((await check()).latest).toBe('1.3.3')
    offline = true; time += 86400e3
    expect(await check()).toMatchObject({ latest: '1.3.3', checked: true })
  })
})
