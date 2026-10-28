// Latest wherdr release on GitHub, checked at most once a day
// (public API without a token, nothing is sent). WHERDR_UPDATE_CHECK=off disables the call.
import pkg from '../../package.json'
import { compareVersions, installMode, oneTapMode, updateCommand, type InstallMode, type UpdateInfo } from '../../shared/updates'

export const REPO = 'afloury/wherdr'
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const DAY_MS = 24 * 60 * 60 * 1000
// Failure (offline, API limit): new attempt in an hour.
const RETRY_MS = 60 * 60 * 1000

interface Release { version: string, url: string }
type Fetcher = (url: string) => Promise<{ ok: boolean, json: () => Promise<unknown>, text?: () => Promise<string> }>

export function createUpdateChecker(opts: {
  current: string
  env: NodeJS.ProcessEnv
  fetch: Fetcher
  now?: () => number
}) {
  const now = opts.now ?? Date.now
  let cached: Release | null = null
  let nextAt = 0
  let pending: Promise<void> | null = null

  async function refresh() {
    try {
      const res = await opts.fetch(RELEASES_URL)
      if (!res.ok) throw new Error('http')
      const releases = await res.json() as { tag_name?: unknown, html_url?: unknown, draft?: boolean, prerelease?: boolean }[]
      const body = releases.filter(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(String(r.tag_name)))
        .sort((a, b) => compareVersions(String(b.tag_name), String(a.tag_name)))[0]
      if (!body || typeof body.tag_name !== 'string') throw new Error('tag')
      const candidate = { version: body.tag_name.replace(/^v/, ''), url: typeof body.html_url === 'string' ? body.html_url : '' }
      const mode = installMode(opts.env.WHERDR_INSTALL)
      if (mode === 'plugin') {
        const archive = `https://github.com/${REPO}/releases/download/v${candidate.version}/wherdr-${candidate.version}.tgz`
        if (!(await opts.fetch(archive)).ok || !(await opts.fetch(`${archive}.sha256`)).ok) {
          nextAt = now() + RETRY_MS; return
        }
      }
      if (mode === 'npm' || mode === 'npm-global') {
        // Check the actual tarball, rather than trusting npm publish's exit code.
        const registry = (opts.env.npm_config_registry || 'https://registry.npmjs.org').replace(/\/$/, '')
        const available = await opts.fetch(`${registry}/wherdr/-/wherdr-${candidate.version}.tgz`)
        if (!available.ok) { nextAt = now() + RETRY_MS; return }
        if (mode === 'npm') {
          const latest = await opts.fetch(`${registry}/wherdr/latest`)
          if (!latest.ok || (await latest.json() as { version?: string }).version !== candidate.version) {
            nextAt = now() + RETRY_MS; return
          }
        }
      }
      if (mode === 'brew') {
        const formula = await opts.fetch('https://raw.githubusercontent.com/afloury/homebrew-tap/main/Formula/wherdr.rb')
        const text = formula.ok ? await formula.text?.() : ''
        if (!text?.includes(`/v${candidate.version}/wherdr-${candidate.version}.tgz"`)) {
          nextAt = now() + RETRY_MS; return
        }
      }
      cached = candidate
      nextAt = now() + DAY_MS
    } catch { nextAt = now() + RETRY_MS }
  }

  return async function check(): Promise<UpdateInfo> {
    // Local fork build: the release notice stays as a rebase reminder, but a
    // one-tap update or a plugin/npm install would replace it with pristine
    // upstream. Report native mode so the app shows the source-build command.
    const mode: InstallMode = 'native'
    const base = { current: opts.current, mode, command: updateCommand(mode, REPO), oneTap: oneTapMode(mode) }
    if (String(opts.env.WHERDR_UPDATE_CHECK || '').toLowerCase() === 'off') return { ...base, latest: null, url: null, checked: false }
    if (now() >= nextAt) {
      pending ??= refresh().finally(() => { pending = null })
      await pending
    }
    const newer = cached && compareVersions(cached.version, opts.current) > 0
    return { ...base, latest: newer ? cached!.version : null, url: newer ? cached!.url || null : null, checked: !!cached }
  }
}

// Keep provider-specific headers off npm and release asset requests. In
// particular npm's version metadata endpoint rejects GitHub's Accept with 406.
export function fetchUpdateResource(url: string, request: typeof fetch = fetch) {
  return request(url, {
    method: /\.tgz(?:\.sha256)?$/.test(url) ? 'HEAD' : 'GET',
    headers: {
      ...(new URL(url).hostname === 'api.github.com' ? { accept: 'application/vnd.github+json' } : {}),
      'user-agent': 'wherdr',
    },
    signal: AbortSignal.timeout(10_000),
  })
}

export const checkUpdate = createUpdateChecker({
  current: pkg.version,
  env: process.env,
  fetch: fetchUpdateResource,
})
