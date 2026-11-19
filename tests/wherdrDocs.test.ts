// WHR-244: the docs Alfred reads, wherever wherdr was started from.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findDocsDir, readDocs } from '../server/utils/wherdrDocs'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })

// An install at <root>: its clone's docs/ and a built .output, with or without its own docs.
function install(ownDocs: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-docs-'))
  dirs.push(root)
  for (const d of ['docs', '.output/server', ...(ownDocs ? ['.output/docs'] : [])]) {
    fs.mkdirSync(path.join(root, d), { recursive: true })
    if (d.endsWith('docs')) fs.writeFileSync(path.join(root, d, 'llms.txt'), '# wherdr\n')
  }
  return { root, entry: path.join(root, '.output', 'server', 'index.mjs') }
}

describe('findDocsDir', () => {
  it('finds the docs next to the running .output, started from another folder without WHERDR_ROOT', () => {
    const { root, entry } = install(false)
    expect(findDocsDir({}, entry, os.tmpdir())).toBe(path.join(root, 'docs'))
    expect(findDocsDir({ WHERDR_ROOT: root }, undefined, os.tmpdir())).toBe(path.join(root, 'docs'))
  })

  it('an auto-deployed build reads its own docs, not the first clone\'s', () => {
    const { root, entry } = install(true)
    expect(findDocsDir({ WHERDR_ROOT: root }, entry, os.tmpdir())).toBe(path.join(root, '.output', 'docs'))
    expect(findDocsDir({}, entry, os.tmpdir())).toBe(path.join(root, '.output', 'docs'))
  })

  it('no docs anywhere: the working folder\'s docs/', () => {
    expect(findDocsDir({}, undefined, '/nowhere')).toBe(path.join('/nowhere', 'docs'))
  })
})

describe('readDocs: wherdr pm docs (WHR-444)', () => {
  const docs = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-docs-'))
    dirs.push(d)
    fs.writeFileSync(path.join(d, 'llms.txt'), '# wherdr\n- [Workspaces](docs/workspaces.md)\n')
    fs.writeFileSync(path.join(d, 'workspaces.md'), '# Workspaces\n\nIntro.\n\n## Shared workflow\n\nA member runs it.\n\n```sh\n# not a heading\n```\n\n### Its guards\n\nStrictest wins.\n\n## Features\n\nLater.\n')
    return d
  }

  it('the index, a page, a section with its sub-sections', () => {
    const d = docs()
    expect(readDocs(d)).toEqual({ page: 'llms.txt', text: '# wherdr\n- [Workspaces](docs/workspaces.md)\n' })
    expect(readDocs(d, 'docs/workspaces.md').text).toContain('## Features')
    const s = readDocs(d, 'workspaces.md#shared-workflow').text
    expect(s.startsWith('## Shared workflow')).toBe(true)
    expect(s).toContain('Strictest wins.')
    expect(s).not.toContain('Features')
  })

  it('an unknown page or section says so; a path is refused', () => {
    const d = docs()
    expect(() => readDocs(d, 'nope.md')).toThrow('No docs page nope.md')
    expect(() => readDocs(d, 'workspaces.md#nope')).toThrow('#shared-workflow, #its-guards')
    for (const bad of ['../package.json', '/etc/passwd', 'sub/x.md', '..md']) expect(() => readDocs(d, bad)).toThrow('is not a docs page')
  })
})
