// wherdr's version: package.json's (one source), plus the commit read at build
// time (nuxt.config.ts), so /api/health, Settings › About and Alfred's update
// notice tell two builds apart. A build without git keeps the package version.
import pkg from '../package.json'

/** "3.0.0-dev+<short commit>", or the package version alone when the commit is unknown. */
export function v3Version(commit?: string | null): string {
  const sha = (commit ?? '').trim().toLowerCase()
  return /^[0-9a-f]{7,40}$/.test(sha) ? `${pkg.version}+${sha.slice(0, 7)}` : pkg.version
}
