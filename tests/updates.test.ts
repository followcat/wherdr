import { describe, expect, it, vi } from 'vitest'
import { compareVersions, installMode, oneTapMode, parseVersion, updateCommand } from '../shared/updates'
import { RELEASES_URL, createUpdateChecker, fetchUpdateResource } from '../server/utils/updates'

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

describe('update command', () => {
  it('follows the installation mode', () => {
    expect(installMode('npm')).toBe('npm')
    expect(installMode('brew')).toBe('brew')
    expect(installMode('npm-global')).toBe('npm-global')
    expect(installMode('plugin')).toBe('plugin')
    expect(installMode(undefined)).toBe('native')
    expect(installMode('autre')).toBe('native')
    const cmd = (m: Parameters<typeof updateCommand>[0]) => updateCommand(m, 'owner/wherdr')
    expect(cmd('native')).toBe('git pull && npm ci && npm run build')
    expect(cmd('npm')).toBe('npx wherdr@latest')
    expect(cmd('brew')).toBe('brew upgrade wherdr && brew services restart wherdr')
    expect(cmd('npm-global')).toBe('npm install -g wherdr@latest && wherdr restart')
    expect(cmd('plugin')).toBe('herdr plugin install owner/wherdr --yes')
  })

  it('offers the one-tap update only where wherdr can replace itself', () => {
    expect(['plugin', 'npm-global', 'brew', 'npm', 'native'].filter(m => oneTapMode(installMode(m)))).toEqual(['plugin', 'npm-global', 'brew'])
  })
})

function release(tag: string) {
  return vi.fn(async (_url: string) => ({ ok: true, json: async () => ([{ tag_name: tag, html_url: `https://example.test/releases/${tag}` }]) }))
}

describe('release check', () => {
  it('reports a newer version', async () => {
    const fetch = release('v1.2.0')
    const check = createUpdateChecker({ current: '1.1.0', env: { WHERDR_INSTALL: 'native' }, fetch })
    const u = await check()
    expect(fetch).toHaveBeenCalledWith(RELEASES_URL)
    expect(u).toEqual({ current: '1.1.0', latest: '1.2.0', url: 'https://example.test/releases/v1.2.0', checked: true, mode: 'native', command: 'git pull && npm ci && npm run build', oneTap: false, behind: 1, missed: ['1.2.0'], latestAt: null })
  })

  it('counts how far the build is behind and lists the skipped versions', async () => {
    const releases = [
      { tag_name: 'v1.4.0', published_at: '2026-10-01T00:00:00Z' },
      { tag_name: 'v1.3.0' },
      { tag_name: 'v1.2.0' },
      { tag_name: 'v1.5.0-beta', prerelease: true },
      { tag_name: 'v9.9.9', draft: true },
    ]
    const fetch = vi.fn(async () => ({ ok: true, json: async () => releases }))
    const u = await createUpdateChecker({ current: '1.2.0', env: {}, fetch })()
    expect(u).toMatchObject({ latest: '1.4.0', behind: 2, missed: ['1.4.0', '1.3.0'], latestAt: Date.parse('2026-10-01T00:00:00Z') })
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
    expect(u).toMatchObject({ latest: null, checked: false, mode: 'native' })
  })
})

describe('independent release channels', () => {
  const releases = [{ tag_name: 'v1.3.3' }, { tag_name: 'v1.3.4-beta', prerelease: true }, { tag_name: 'v9.0.0', draft: true }]
  it('offers published releases to plugins even while npm is unavailable', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => releases }))
    const check = createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: 'plugin' }, fetch })
    // A marked plugin install one-taps through the GitHub archive.
    expect(await check()).toMatchObject({ latest: '1.3.3', oneTap: true, mode: 'plugin' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })
  it('keeps a source build on the manual path when WHERDR_INSTALL is unset', async () => {
    const fetch = vi.fn(async () => ({ ok: true, json: async () => releases }))
    const check = createUpdateChecker({ current: '1.3.2', env: {}, fetch })
    // Fork build: the notice still arrives, but installs stay manual.
    expect(await check()).toMatchObject({ latest: '1.3.3', oneTap: false, mode: 'native' })
  })
  for (const mode of ['npm', 'npm-global']) {
    it(`${mode} waits for the tarball and retries after an hour`, async () => {
      let available = false, time = 0
      const fetch = vi.fn(async (url: string) => ({ ok: url === RELEASES_URL || available, json: async () => url.endsWith('/latest') ? { version: '1.3.3' } : releases }))
      const check = createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: mode }, fetch, now: () => time })
      expect((await check()).latest).toBeNull()
      available = true; time = 3600e3
      expect((await check()).latest).toBe('1.3.3')
    })
    it(`${mode} fails closed on a network error`, async () => {
      const fetch = async (url: string) => {
        if (url !== RELEASES_URL) throw new Error('offline')
        return { ok: true, json: async () => releases }
      }
      expect((await createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: mode }, fetch })()).latest).toBeNull()
    })
  }
  it('Homebrew waits for its formula, independently of npm', async () => {
    const check = (text: string) => createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: 'brew' },
      fetch: async () => ({ ok: true, json: async () => releases, text: async () => text }) })()
    expect((await check('url "old"')).latest).toBeNull()
    expect((await check('url "https://github.com/example/wherdr/releases/download/v1.3.3/wherdr-1.3.3.tgz"')).latest).toBe('1.3.3')
  })
})

describe('provider HTTP requests', () => {
  it('keeps GitHub Accept away from npm metadata, which would reject it with 406', async () => {
    const request: typeof fetch = vi.fn(async (url, init) => {
      const headers = new Headers(init?.headers)
      const githubAccept = headers.get('accept') === 'application/vnd.github+json'
      if (String(url) === RELEASES_URL) {
        expect(githubAccept).toBe(true)
        return new Response(JSON.stringify([{ tag_name: 'v1.3.3' }]))
      }
      if (String(url).endsWith('/latest')) {
        return githubAccept ? new Response('', { status: 406 }) : new Response('{"version":"1.3.3"}')
      }
      expect(githubAccept).toBe(false)
      return new Response('')
    })
    const check = createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: 'npm' },
      fetch: url => fetchUpdateResource(url, request) })
    expect((await check()).latest).toBe('1.3.3')
    await fetchUpdateResource('https://github.com/example/wherdr/releases/download/v1.3.3/wherdr-1.3.3.tgz', request)
    await fetchUpdateResource('https://raw.githubusercontent.com/example/tap/main/Formula/wherdr.rb', request)
  })

  it.each(['archive', 'checksum'])('hides plugin updates when the %s is missing', async missing => {
    const check = createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: 'plugin' },
      fetch: async url => ({ ok: url === RELEASES_URL || (missing === 'archive' ? !url.endsWith('.tgz') : !url.endsWith('.sha256')),
        json: async () => [{ tag_name: 'v1.3.3' }] }) })
    expect((await check()).latest).toBeNull()
  })

  it('keeps a previously validated notice through a transient error and an unavailable new candidate', async () => {
    let time = 0, phase = 'available'
    const check = createUpdateChecker({ current: '1.3.2', env: { WHERDR_INSTALL: 'plugin' }, now: () => time,
      fetch: async url => {
        if (phase === 'offline') throw new Error('offline')
        return { ok: url === RELEASES_URL || phase === 'available', json: async () => [{ tag_name: phase === 'new' ? 'v1.3.4' : 'v1.3.3' }] }
      } })
    expect((await check()).latest).toBe('1.3.3')
    phase = 'offline'; time += 86400e3
    expect(await check()).toMatchObject({ latest: '1.3.3', checked: true })
    phase = 'new'; time += 3600e3
    expect((await check()).latest).toBe('1.3.3')
    phase = 'available'; time += 3600e3
    expect((await check()).latest).toBe('1.3.3')
  })
})
