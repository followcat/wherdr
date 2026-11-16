import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { checkDocLinks } from '../scripts/check-doc-links.mjs'
import { REPO } from '../website/app/utils/site'
import { AGENT_PROMPTS, promptOf } from '../website/app/utils/agentPrompts'

// website/public/agent.md guides coding agents through a v3 install: every
// command and variable it cites must be one the documentation really uses, so the
// guide cannot drift from it.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const documentation = ['installation', 'install-with-an-agent', 'migrate-from-v2', 'update-with-an-agent', 'networks', 'security', 'troubleshooting'].map(page => read(`../docs/${page}.md`)).join('\n')
const guide = read('../website/public/agent.md')
const llms = read('../website/public/llms.txt')

// Checks an agent runs to verify a step: harmless, read-only.
const CHECKS = ['curl -fsSL https://wherdr.dev/agent.md', 'git --version', 'node --version', 'tailscale status', 'tailscale serve status', 'hc --version', 'systemctl --user status']
// Words and placeholders the guide names, not commands.
const PLAIN = /^(v3|sudo|--yes)$/

const snippets = [
  ...[...guide.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap(([, block]) =>
    block!.split('\n').map(l => l.replace(/\s+#.*$/, '').trim()).filter(Boolean)),
  ...[...guide.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map(([, s]) => s!),
]

describe('agent.md', () => {
  it.each(snippets.filter(s => !CHECKS.includes(s) && !PLAIN.test(s)))('`%s` is in the documentation', (snippet) => {
    // The agent prompts write the repository as REPO.
    expect(documentation).toContain(snippet.replace(`${REPO}.git`, 'REPO'))
  })

  it('names no v2 install method', () => {
    expect(guide).not.toMatch(/npx wherdr|npm install -g|brew install|herdr plugin install|wherdr\.dev\/install/)
  })

  it('stays short enough for fetch tools to return it whole, and says how to read the raw file', () => {
    expect(Buffer.byteLength(guide)).toBeLessThan(5000)
    expect(guide.slice(0, 300)).toContain('curl -fsSL https://wherdr.dev/agent.md')
  })

  it('keeps the passkey lock optional, as the documentation says', () => {
    expect(guide).not.toMatch(/passkey[^\n]*\(required|\brequired\b[^\n]*passkey/i)
    expect(guide).toMatch(/\*\*Passkey lock\*\* \(optional/)
  })

  it('documentation links resolve to existing pages and anchors', () => {
    expect(checkDocLinks()).toEqual([])
  })
})

describe('the install card', () => {
  it('shows the prompts of docs/install-with-an-agent.md with the repository filled in', () => {
    expect(AGENT_PROMPTS.map(p => p.text.split('\n')[0])).toEqual([
      expect.stringContaining('Install wherdr v3'),
      expect.stringContaining('NEXT TO the wherdr v2'),
    ])
    for (const p of AGENT_PROMPTS) expect(p.text).toContain(`the v3 branch of ${REPO}`)
    expect(() => promptOf('# no prompt', 'New install of v3')).toThrow()
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

  it.each(links.filter(u => u.startsWith(`${REPO}/blob/v3/`)))('%s is a file of the repository', (url) => {
    expect(existsSync(new URL(`../${url.slice(`${REPO}/blob/v3/`.length)}`, import.meta.url))).toBe(true)
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
