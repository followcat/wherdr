// New version notice: version comparison and the update command
// (shared by server / app, no dependency).

// wherdr 3 installs from source only (git clone, npm ci, npm run build): no npm
// package, Homebrew formula or one-tap update (docs/installation.md#updating).
export const UPDATE_COMMAND = 'git pull && npm ci && npm run build'

export interface UpdateInfo {
  current: string
  // Latest published release, if newer than `current`; otherwise null.
  latest: string | null
  url: string | null
  // Its release notes (Markdown, as on GitHub), shown by the banner's What's new.
  notes?: string | null
  // The latest release could be read (check enabled, GitHub reachable).
  checked: boolean
  command: string
  // Stable releases newer than current, among the latest 100 API entries.
  // Optional so cached state and older API responses remain usable.
  behind?: number
  missed?: string[] // newest first, at most five versions (including latest)
  behindAtLeast?: boolean // the API page was full: the count is a lower bound
}

// "v1.2.3", "1.2.3-beta.1" -> [1, 2, 3]; null if unreadable. Pre-releases
// are ignored (never offered: GitHub's "latest" release is never one).
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// > 0 if a is newer than b; 0 if equal or unreadable.
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

// Is this release one to offer to the running version? Only within its major
// (v3 never offers a 2.x, nor a 4.0), and a release counts as newer than its
// own pre-release ("3.0.0" after "3.0.0-dev").
export function isNewerRelease(release: string, current: string): boolean {
  const r = parseVersion(release), c = parseVersion(current)
  if (!r || !c || r[0] !== c[0]) return false
  const diff = compareVersions(release, current)
  return diff > 0 || (diff === 0 && /^v?\d+\.\d+\.\d+-/.test(current.trim()) && !/-/.test(release))
}

// What the banner's "Update with Alfred" sends, as the user, to Alfred, which
// follows docs/update-with-an-agent.md from the installed checkout.
export function alfredUpdateRequest(info: Pick<UpdateInfo, 'latest' | 'url'>): string {
  return `Update wherdr to ${info.latest}${info.url ? `: ${info.url}` : ''}`
}
