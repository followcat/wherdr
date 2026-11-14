import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { docAnchors } from '../scripts/check-doc-links.mjs'

// docs/llms.txt is the index an agent reads first: every link must lead to an
// existing page and heading, and every page must be listed.
const root = fileURLToPath(new URL('../', import.meta.url))
const index = readFileSync(`${root}docs/llms.txt`, 'utf8')
const links = [...index.matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]!)
// Release notes are left out on purpose: the documentation home lists them.
const unlisted = (page: string) => /^release-notes-/.test(page)

describe('docs/llms.txt', () => {
  it('stays small', () => {
    expect(index.split('\n').length).toBeLessThan(150)
  })

  it.each(links)('%s leads to a page and a heading', (link) => {
    const [path, anchor] = link.split('#')
    expect(path).toMatch(/^docs\/[\w.-]+\.md$/)
    expect(existsSync(`${root}${path}`)).toBe(true)
    if (anchor) expect([...docAnchors(`${root}${path}`)]).toContain(anchor)
  })

  // A union merge keeps both sides' lines, so a line two tasks added twice stays twice.
  it('has no duplicated line', () => {
    const lines = index.split('\n').filter(l => l.trim())
    expect(lines.filter((l, i) => lines.indexOf(l) !== i)).toEqual([])
  })

  // Two tasks that both edit one entry's line leave both versions after a union merge.
  it('keeps one line per entry', () => {
    const targets = index.split('\n').map(l => /^- \[[^\]]+\]\(([^)]+)\)/.exec(l)?.[1]).filter(t => t)
    const twice = [...new Set(targets.filter((t, i) => targets.indexOf(t) !== i))]
    expect(twice, `${twice.join(', ')} listed more than once: keep one line per entry`).toEqual([])
  })

  // As a catch-up: the branch (two) and the base (one) each add a line and change A.
  it('merges both sides\' lines without a conflict, one line per entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-union-'))
    try {
      const driver = `node ${root}scripts/llms-merge.mjs driver %O %A %B`
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', `merge.llms-index.driver=${driver}`, ...args], { cwd: dir, stdio: 'pipe' })
      git('init', '-q', '-b', 'base')
      execFileSync('node', [`${root}scripts/llms-merge.mjs`, 'install'], { cwd: dir })
      writeFileSync(join(dir, '.gitattributes'), readFileSync(`${root}.gitattributes`))
      const file = join(dir, 'docs/llms.txt')
      mkdirSync(join(dir, 'docs'))
      writeFileSync(file, '# Index\n\n- [A](docs/a.md): a.\n')
      git('add', '.')
      git('commit', '-qm', 'base')
      for (const [branch, line] of [['one', '- [B](docs/b.md): b.'], ['two', '- [C](docs/c.md): c.']]) {
        git('checkout', '-qb', branch!, 'base')
        writeFileSync(file, `${readFileSync(file, 'utf8').replace(': a.', `: a, ${branch}.`)}${line}\n`)
        git('commit', '-qam', branch!)
      }
      git('merge', '-q', '--no-edit', 'one')
      expect(readFileSync(file, 'utf8')).toBe('# Index\n\n- [A](docs/a.md): a, two.\n- [C](docs/c.md): c.\n- [B](docs/b.md): b.\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('lists every documentation page', () => {
    const pages = readdirSync(`${root}docs`).filter(f => f.endsWith('.md') && !unlisted(f))
    const listed = new Set(links.map(l => l.split('#')[0]!.slice('docs/'.length)))
    expect(pages.filter(p => !listed.has(p))).toEqual([])
  })
})

// A "Needs:" line names the section to read first: it must exist too.
describe('Needs: lines', () => {
  const pages = readdirSync(`${root}docs`).filter(f => f.endsWith('.md'))
  const needs = pages.flatMap(page => [...readFileSync(`${root}docs/${page}`, 'utf8').matchAll(/^Needs: \[[^\]]+\]\(([^)]*)\)/gm)]
    .map(m => [page, m[1]!] as const))
  it.each(needs)('%s needs %s', (page, link) => {
    const [path, anchor] = link.split('#')
    expect([...docAnchors(`${root}docs/${path || page}`)]).toContain(anchor)
  })
})
