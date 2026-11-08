// v3's own version, so /api/health and Settings › About tell it apart from v2
// (whose version is package.json's). The commit is read at build time
// (nuxt.config.ts); a build without git still gets "3.0.0-dev".
export const V3_BASE_VERSION = '3.0.0-dev'

/** "3.0.0-dev+<short commit>", or the base alone when the commit is unknown. */
export function v3Version(commit?: string | null): string {
  const sha = (commit ?? '').trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(sha) ? `${V3_BASE_VERSION}+${sha.slice(0, 7)}` : V3_BASE_VERSION
}
