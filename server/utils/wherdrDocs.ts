// wherdr's docs on its own machine, for Alfred and the local coordinators:
// the first folder with llms.txt (the index) among
// 1. the build's own copy, .output/docs, under WHERDR_ROOT or the running
//    server (auto-deploy packages ship it: they replace .output only, so the
//    clone's docs/ may be older);
// 2. WHERDR_ROOT/docs (the package root the CLI sets);
// 3. the docs/ next to the running .output (started without the CLI, from
//    another folder: a service without a working directory);
// 4. the working folder's docs/ (npm start in a checkout).
// None has it: the last one tried, so the role text names a place.
import fs from 'node:fs'
import path from 'node:path'
import { HerdrError } from './herdr'

export function findDocsDir(env: NodeJS.ProcessEnv = process.env, entry = process.argv[1], cwd = process.cwd()): string {
  const root = env.WHERDR_ROOT
  // The server's entry is .output/server/index.mjs.
  const up = entry ? path.resolve(path.dirname(entry), '..') : ''
  const output = path.basename(up) === '.output' ? up : ''
  const tries = [
    root && path.join(root, '.output', 'docs'),
    output && path.join(output, 'docs'),
    root && path.join(root, 'docs'),
    output && path.join(output, '..', 'docs'),
    path.join(cwd, 'docs'),
  ].filter((d): d is string => !!d)
  return tries.find(d => fs.existsSync(path.join(d, 'llms.txt'))) ?? tries.at(-1)!
}

// `wherdr pm docs [<page>[#<section>]]`: the running wherdr's docs, for an
// agent on any machine. No page: the index (llms.txt). A section: from its
// heading to the next heading of the same or a higher level. Read-only, one
// file of the docs folder (no sub-folder, no path), cut at DOCS_CAP.
export const DOCS_CAP = 80_000
const PAGE_RE = /^[a-z0-9][a-z0-9.-]{0,80}\.(md|txt)$/

// A heading's anchor, as GitHub makes it: lower case, punctuation dropped, spaces to dashes.
const docsAnchor = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')

export function readDocs(dir: string, arg?: string): { page: string, section?: string, text: string, cut?: string, sections?: string[] } {
  const [rawPage = 'llms.txt', section] = (arg ?? '').split('#', 2)
  const page = rawPage.replace(/^docs\//, '') || 'llms.txt'
  if (!PAGE_RE.test(page)) throw new HerdrError('bad_input', `"${page}" is not a docs page: a file name such as workspaces.md (wherdr pm docs lists them)`)
  let all: string
  try { all = fs.readFileSync(path.join(dir, page), 'utf8') }
  catch { throw new HerdrError('not_found', `No docs page ${page}: wherdr pm docs (the index) lists them`) }
  const lines = all.split('\n')
  // Headings outside code blocks, with their level and anchor.
  let fence = false
  const heads = lines.flatMap((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence
    const m = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l)
    return m ? [{ i, level: m[1]!.length, anchor: docsAnchor(m[2]!) }] : []
  })
  let text = all
  if (section) {
    const at = heads.findIndex(h => h.anchor === section.toLowerCase())
    if (at < 0) throw new HerdrError('not_found', `No section #${section} in ${page}: ${heads.map(h => `#${h.anchor}`).join(', ')}`)
    const h = heads[at]!, end = heads.slice(at + 1).find(x => x.level <= h.level)
    text = lines.slice(h.i, end?.i).join('\n')
  }
  if (text.length <= DOCS_CAP) return { page, ...(section ? { section } : {}), text }
  return { page, ...(section ? { section } : {}), text: text.slice(0, DOCS_CAP), cut: `cut at ${DOCS_CAP} characters: ask for one section (wherdr pm docs ${page}#<section>)`, sections: heads.map(x => `#${x.anchor}`) }
}
