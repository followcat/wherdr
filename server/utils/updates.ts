// Latest wherdr release on GitHub, checked at most once a day
// (public API without a token, nothing is sent). WHERDR_UPDATE_CHECK=off disables the call.
import pkg from '../../package.json'
import { compareVersions, isNewerRelease, UPDATE_COMMAND, type UpdateInfo } from '../../shared/updates'

export const REPO = 'afloury/wherdr'
export const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=100`
const DAY_MS = 24 * 60 * 60 * 1000
// Failure (offline, API limit): new attempt in an hour.
const RETRY_MS = 60 * 60 * 1000
// Release notes kept for What's new (GitHub allows 125 000 characters).
const NOTES_MAX = 50_000

interface Release { version: string, url: string, notes: string, missed: string[], truncated: boolean }
type Fetcher = (url: string) => Promise<{ ok: boolean, json: () => Promise<unknown> }>

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
      const releases = await res.json() as { tag_name?: unknown, html_url?: unknown, body?: unknown, draft?: boolean, prerelease?: boolean }[]
      // Only newer releases of the running major (isNewerRelease): a 2.x is never offered to v3.
      const stable = releases.filter(r => !r.draft && !r.prerelease && /^v\d+\.\d+\.\d+$/.test(String(r.tag_name))
        && isNewerRelease(String(r.tag_name), opts.current))
        .sort((a, b) => compareVersions(String(b.tag_name), String(a.tag_name)))
      const body = stable[0]
      if (!body || typeof body.tag_name !== 'string') {
        if (!Array.isArray(releases)) throw new Error('tag')
        cached = { version: opts.current, url: '', notes: '', missed: [], truncated: false }
        nextAt = now() + DAY_MS
        return
      }
      const missed = [...new Set(stable.map(r => String(r.tag_name).replace(/^v/, '')))]
      const candidate = { version: body.tag_name.replace(/^v/, ''), url: typeof body.html_url === 'string' ? body.html_url : '',
        notes: typeof body.body === 'string' ? body.body.slice(0, NOTES_MAX) : '', missed, truncated: releases.length >= 100 }
      cached = candidate
      nextAt = now() + DAY_MS
    } catch { nextAt = now() + RETRY_MS }
  }

  return async function check(): Promise<UpdateInfo> {
    const base = { current: opts.current, command: UPDATE_COMMAND, behind: 0, missed: [] as string[], behindAtLeast: false }
    if (String(opts.env.WHERDR_UPDATE_CHECK || '').toLowerCase() === 'off') return { ...base, latest: null, url: null, notes: null, checked: false }
    if (now() >= nextAt) {
      pending ??= refresh().finally(() => { pending = null })
      await pending
    }
    const newer = cached && isNewerRelease(cached.version, opts.current)
    return { ...base, latest: newer ? cached!.version : null, url: newer ? cached!.url || null : null, notes: newer ? cached!.notes || null : null, checked: !!cached,
      ...(newer ? { behind: cached!.missed.length, missed: cached!.missed.slice(0, 5), behindAtLeast: cached!.truncated } : {}) }
  }
}

// GitHub's releases API, with its JSON media type.
export function fetchUpdateResource(url: string, request: typeof fetch = fetch) {
  return request(url, {
    headers: { 'accept': 'application/vnd.github+json', 'user-agent': 'wherdr' },
    signal: AbortSignal.timeout(10_000),
  })
}

export const checkUpdate = createUpdateChecker({
  current: pkg.version,
  env: process.env,
  fetch: fetchUpdateResource,
})
