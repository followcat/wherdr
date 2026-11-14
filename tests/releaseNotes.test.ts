import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { checkReleaseNotes } from '../scripts/check-release-notes.mjs'
import { prereleaseSummary } from '../scripts/prerelease-summary.mjs'

const link = '[Full changelog](https://github.com/example/wherdr/blob/v2.0.0/CHANGELOG.md)'
const summary = 'Downloads now work correctly on supported Node versions. Temporary links are released after the browser saves the file.'

for (const heading of ['New', 'Improved', 'Fixed', 'Update']) {
  it(`accepts reviewed prose under ${heading}`, () => {
    expect(() => checkReleaseNotes(`## ${heading}\n${summary}\n\n${link}`, 'example/wherdr', 'v2.0.0')).not.toThrow()
  })
}
for (const body of [
  '', 'See CHANGELOG.md', link, `## Fixed\nSee CHANGELOG.md.\n${link}`,
  `## Fixed\n${link}`, `## Fixed\nShort sentence. Another one.\n${link}`,
  `## Fixed\nDownloads now work correctly on all supported Node versions and platforms\n${link}`,
  `## Other\n${summary}\n${link}`, `## Fixed\n## Other\n${summary}\n${link}`,
  `## Fixed\n<!-- ${summary} -->\n${link}`, `## Fixed\n\`\`\`\n${summary}\n\`\`\`\n${link}`,
  `${link}\n## Fixed\n${summary}`, `## Fixed\n${summary}`, `## Fixed\n${summary}\n${link.replace('v2.0.0', 'main')}`,
]) {
  it(`rejects insufficient notes: ${JSON.stringify(body).slice(0, 90)}`, () => {
    expect(() => checkReleaseNotes(body, 'example/wherdr', 'v2.0.0')).toThrow()
  })
}
it('accepts CRLF and sentences spread across categories', () => {
  expect(() => checkReleaseNotes(`## New\r\nDownloads now work correctly on supported Node versions.\r\n## Fixed\r\nTemporary links are released after the browser saves the file.\r\n${link}`, 'example/wherdr', 'v2.0.0')).not.toThrow()
})

it('summarizes only current prerelease changes and links to their immutable commit', () => {
  const notes = prereleaseSummary('# Changelog\n## [Unreleased]\n\n- First change.\n  More detail about the new download behavior.\n- Second change.\n- Third change.\n- Fourth change.\n## [1.0.0]\n- Old change.', 'example/wherdr', 'a'.repeat(40))
  expect(notes).toContain('## Update')
  expect(notes).toContain('First change.\n  More detail about the new download behavior.')
  expect(notes).toContain('Third change.')
  expect(notes).not.toMatch(/Fourth|Old/)
  expect(notes).toContain(`/blob/${'a'.repeat(40)}/CHANGELOG.md`)
})
it('refuses a prerelease without current change descriptions', () => {
  for (const changelog of ['', '## [Unreleased]\n\n## [1.0.0]\n- Old change.', '## [Unreleased]\n- See CHANGELOG.md']) {
    expect(() => prereleaseSummary(changelog, 'example/wherdr', 'a'.repeat(40))).toThrow()
  }
})

it('summarizes the versioned unreleased section used by the repository', () => {
  const changelog = '# Changelog\n\n## 2.0.1 (unreleased)\n\n- A future patch improves task navigation across machines. Tasks keep their current selection when a machine reconnects.\n\n## [2.0.0] — 2026-10-24\n- Stable changes.'
  const notes = prereleaseSummary(changelog, 'example/wherdr', 'a'.repeat(40))
  expect(notes).toContain(changelog.split('\n').find(line => line.startsWith('- ')))
  expect(notes).not.toContain('## [2.0.0]')
})

it('validates the reviewed 2.0.0 release notes', () => {
  const notes = readFileSync('docs/release-notes-2.0.0.md', 'utf8')
  const repo = JSON.parse(readFileSync('package.json', 'utf8')).repository.url.replace('git+https://github.com/', '').replace(/\.git$/, '')
  expect(() => checkReleaseNotes(notes, repo, 'v2.0.0')).not.toThrow()
})

it('validates the prepared release notes and matching package metadata', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const plugin = readFileSync('herdr-plugin.toml', 'utf8').match(/^version = "([^"]+)"$/m)?.[1]
  expect(lock.version).toBe(pkg.version)
  expect(lock.packages[''].version).toBe(pkg.version)
  expect(plugin).toBe(pkg.version)
  // A development version (3.0.0-dev) has no release notes yet: the release sets 3.0.0 and adds them.
  if (/-/.test(pkg.version)) return
  expect(readFileSync('CHANGELOG.md', 'utf8')).toContain(`## [${pkg.version}]`)
  const repo = pkg.repository.url.replace('git+https://github.com/', '').replace(/\.git$/, '')
  expect(() => checkReleaseNotes(readFileSync(`docs/release-notes-${pkg.version}.md`, 'utf8'), repo, `v${pkg.version}`)).not.toThrow()
})
