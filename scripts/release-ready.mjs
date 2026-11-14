// Legacy updaters require both npm and Homebrew before releases/latest moves.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export async function readiness(version, request = fetch, repo = process.env.GITHUB_REPOSITORY) {
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const get = (url, method = 'GET') => request(url, { method, signal: AbortSignal.timeout(15_000) })
  const missing = []
  try {
    const metadata = await get('https://registry.npmjs.org/wherdr/latest')
    if (!metadata.ok || (await metadata.json()).version !== version) missing.push(`npm latest is not ${version}`)
    const tar = await get(`https://registry.npmjs.org/wherdr/-/wherdr-${version}.tgz`, 'HEAD')
    if (!tar.ok) missing.push(`npm archive ${version} is unavailable`)
  } catch { missing.push('npm availability check failed') }
  try {
    const formula = await get(`https://raw.githubusercontent.com/${repo.split('/')[0]}/homebrew-tap/main/Formula/wherdr.rb`)
    if (!formula.ok || !(await formula.text()).includes(`/v${version}/wherdr-${version}.tgz"`)) {
      missing.push(`Homebrew formula is not ready: run scripts/bump-homebrew.sh ${version} after release.yml completes`)
    }
  } catch { missing.push('Homebrew availability check failed') }
  return { ready: missing.length === 0, missing }
}

export async function ready(...args) { return (await readiness(...args)).ready }

export async function promote({ repo, request = fetch, run = execFileSync, log = console.log }) {
  if (!repo) throw new Error('GITHUB_REPOSITORY is required')
  const releases = JSON.parse(run('gh', ['api', `repos/${repo}/releases?per_page=100`], { encoding: 'utf8' }))
  // Only the npm line (1.x, 2.x): v3 is a GitHub release only and never becomes latest.
  const versions = releases.filter(r => !r.draft && !r.prerelease && /^v[12]\.\d+\.\d+$/.test(r.tag_name))
    .sort((a, b) => b.tag_name.slice(1).localeCompare(a.tag_name.slice(1), 'en', { numeric: true }))
  const tag = versions[0]?.tag_name
  if (!tag) { log('No published stable release.'); return }
  const current = JSON.parse(run('gh', ['api', `repos/${repo}/releases/latest`], { encoding: 'utf8' }))
  if (current.tag_name === tag) { log(`Legacy update channel already at ${tag}.`); return }
  const result = await readiness(tag.slice(1), request, repo)
  if (!result.ready) {
    for (const reason of result.missing) log(`Legacy update channel unchanged: ${reason}.`)
    return
  }
  run('gh', ['release', 'edit', tag, '--repo', repo, '--latest'], { stdio: 'inherit' })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await promote({ repo: process.env.GITHUB_REPOSITORY })
}
