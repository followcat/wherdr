import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkDocLinks } from '../scripts/check-doc-links.mjs'
import { AGENT_PROMPT, REPO } from '../website/app/utils/site'

// website/public/agent.md guides coding agents through an install: every
// command, port and variable it cites must be one the documentation really uses,
// so the guide cannot drift from it. The guide is part of the v2 site, kept as is
// until the site moves to v3 (docs/RELEASING.md, transition step 8): the settings
// of v2's installer (2.x branch) it quotes are listed here.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const documentation = ['installation', 'networks', 'command', 'plugins', 'security', 'machines', 'troubleshooting'].map(page => read(`../docs/${page}.md`)).join('\n')
const guide = read('../website/public/agent.md')
const V2_INSTALLER = ['WHERDR_YES=1', 'WHERDR_PORT=7684']
// Shell line continuations joined, as in the guide's snippets below.
const sources = [documentation, ...V2_INSTALLER].join('\n').replace(/\\\n\s*/g, '')
const llms = read('../website/public/llms.txt')

// Checks an agent runs to verify a step: not in the documentation, harmless, read-only.
const CHECKS = ['curl -fsS http://127.0.0.1:7683', 'curl -fsS http://127.0.0.1:7683/manifest.webmanifest', 'curl -fsSL https://wherdr.dev/agent.md', 'tailscale status', 'tailscale serve status', 'herdr --version', 'herdr plugin list', 'brew list wherdr', 'git --version', 'node --version']
// Placeholders and file paths the guide names, not commands.
const PLAIN = /^(~\/[\w./-]+|\.env|plugin\.env|url|https:\/\/<machine>\.<tailnet>\.ts\.net:7683\/)$/
// Quoted from wherdr's own output, checked against the code below.
const OUTPUT = ['"reach":"ok"', '"pending"', 'First passkey: bootstrap token']

const snippets = [
  ...[...guide.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(([, block]) =>
    block!.replace(/\\\n\s*/g, '').split('\n').map(l => l.replace(/\s+#.*$/, '').trim()).filter(Boolean)),
  ...[...guide.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(([, s]) => s!),
]

describe('agent.md', () => {
  it.each(snippets.filter(s => !CHECKS.includes(s) && !OUTPUT.includes(s) && !PLAIN.test(s)))('`%s` is in the documentation or the installer', (snippet) => {
    // The guide fills one placeholder; the documentation writes a sample address.
    const s = snippet.replace('https://<machine>.<tailnet>.ts.net:7683/', 'https://server.example.ts.net:7683/')
    expect(sources).toContain(s)
  })

  it.each([...new Set(guide.match(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g))])('variable %s exists', (name) => {
    expect(sources).toMatch(new RegExp(`\\b${name}\\b`))
  })

  it.each([...new Set(guide.match(/(?<=[:= ])\d{4,5}\b/g))])('port %s exists', (port) => {
    expect(sources).toMatch(new RegExp(`(?:127\\.0\\.0\\.1|localhost|PORT)[:=]${port}\\b`))
  })

  it('quotes the /api/phone states and the bootstrap token line the server really writes', () => {
    const reach = read('../shared/phone.ts').match(/export type PhoneReach = (.+)/)![1]
    expect(reach).toContain('\'ok\'')
    expect(reach).toContain('\'pending\'')
    expect(read('../server/utils/phone.ts')).toMatch(/reach: null/)
    expect(read('../server/utils/auth.ts')).toContain('First passkey: bootstrap token')
  })

  it('stays short enough for fetch tools to return it whole, and says how to read the raw file', () => {
    expect(Buffer.byteLength(guide)).toBeLessThan(5000)
    expect(guide.slice(0, 300)).toContain('curl -fsSL https://wherdr.dev/agent.md')
  })

  it('keeps the passkey lock optional, as the documentation says', () => {
    // wherdr answers only this computer and the tailnet; a passkey is an extra lock.
    expect(documentation).toContain('The passkey lock is never required')
    expect(guide).not.toMatch(/passkey[^\n]*\(required|\brequired\b[^\n]*passkey/i)
    expect(guide).toMatch(/\*\*Passkey lock\*\* \(optional/)
  })

  it('documentation links resolve to existing pages and anchors', () => {
    expect(checkDocLinks()).toEqual([])
  })

  it('keeps the passkey lock optional, as the README says', () => {
    // wherdr answers only this computer and the tailnet; a passkey is an extra lock.
    expect(read('../README.md')).toContain('optional passkey lock')
    expect(guide).not.toMatch(/passkey[^\n]*\(required|\brequired\b[^\n]*passkey/i)
    expect(guide).toMatch(/\*\*Passkey lock\*\* \(optional/)
  })

  it('the install tab prompt points to it', () => {
    expect(AGENT_PROMPT).toContain('https://wherdr.dev/agent.md')
  })
})

describe('llms.txt', () => {
  const links = [...llms.matchAll(/\]\((https?:[^)]+)\)/g)].map(([, url]) => url!)

  it('starts with the llmstxt.org title and summary', () => {
    expect(llms).toMatch(/^# wherdr\n\n> \S/)
  })

  it.each(links.filter(u => u.startsWith('https://wherdr.dev/')))('%s is a file of website/public', (url) => {
    expect(existsSync(new URL(`../website/public/${url.slice('https://wherdr.dev/'.length)}`, import.meta.url))).toBe(true)
  })

  it.each(links.filter(u => u.includes('raw.githubusercontent.com')))('%s is a file of the repository', (url) => {
    const [, repo, path] = url.match(/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/main\/(.+)$/)!
    expect(`https://github.com/${repo}`).toBe(REPO)
    expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true)
  })
})

describe('documentation entry points', () => {
  it('keeps the README short and links to the topic index', () => {
    const readme = read('../README.md')
    expect(Buffer.byteLength(readme)).toBeLessThan(6000)
    expect(readme).toContain('(docs/README.md)')
  })

  it('presents the current demo as an animated README hero with alternative text', () => {
    const readme = read('../README.md')
    // The animated demo replaces the former static desktop screenshot.
    const hero = readme.match(/<img\s+src="(assets\/wherdr-readme\.webp)"[^>]*\balt="([^"]+)"/)
    expect(hero).not.toBeNull()
    expect(hero![2]!.length).toBeGreaterThan(20)
    const webp = readFileSync(new URL(`../${hero![1]}`, import.meta.url))
    expect(webp.toString('ascii', 0, 4)).toBe('RIFF')
    expect(webp.toString('ascii', 8, 12)).toBe('WEBP')
    expect(webp.includes(Buffer.from('ANIM'))).toBe(true)
    expect(webp.includes(Buffer.from('ANMF'))).toBe(true)
  })

  it('indexes every documentation page', () => {
    const index = read('../docs/README.md')
    for (const file of readdirSync(new URL('../docs/', import.meta.url), { recursive: true })) {
      if (typeof file === 'string' && file.endsWith('.md') && file !== 'README.md') expect(index).toContain(`](${file})`)
    }
  })
})
