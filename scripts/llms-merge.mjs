#!/usr/bin/env node
// Merges of docs/llms.txt keep one line per entry. A union merge keeps every
// line of both sides, so an entry both sides changed would be listed twice.
//
//   install          set up the merge driver and the engine's after-merge fix
//                    in this clone's git config and info/attributes (which
//                    win over .gitattributes' union here only; run by prepare)
//   driver O A B     git merge driver: union of the three versions, then one
//                    line per entry, written to A (the branch's side)
//   fix [file]       one line per entry after a merge done elsewhere (GitHub's
//                    Update branch runs no local driver): run by the engine
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'

const INDEX = 'docs/llms.txt'
const SELF = 'node scripts/llms-merge.mjs'
const ATTR = `${INDEX} merge=llms-index`

// An entry is a list line, named by its link: `- [Title](docs/page.md#anchor): …`.
const entryOf = line => /^- \[[^\]]+\]\(([^)]+)\)/.exec(line)?.[1]

const linesByEntry = (text) => {
  const map = new Map()
  for (const line of text.split('\n')) {
    const e = entryOf(line)
    if (e && !map.has(e)) map.set(e, line)
  }
  return map
}

// The merged text with one line per entry. For an entry listed more than once,
// the branch's line (ours) when the branch changed it, else the other side's.
// Lines of a single entry, and every other line, stay as they are, in order.
export function dedupe(merged, ours = '', base = '') {
  const lines = merged.split('\n'), oursOf = linesByEntry(ours), baseOf = linesByEntry(base)
  const at = new Map()
  lines.forEach((line, i) => {
    const e = entryOf(line)
    if (e) at.set(e, [...(at.get(e) ?? []), i])
  })
  const drop = new Set()
  for (const [e, idx] of at) {
    if (idx.length < 2) continue
    const mine = oursOf.get(e), changed = mine !== undefined && mine !== baseOf.get(e)
    const keep = (changed ? idx.find(i => lines[i] === mine) : idx.find(i => lines[i] !== mine)) ?? idx[0]
    for (const i of idx) if (i !== keep) drop.add(i)
  }
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const show = (rev, file) => { try { return git('show', `${rev}:${file}`) } catch { return '' } }

// The three-way union, then one line per entry.
export function mergeIndex(base, ours, theirs) {
  let merged
  try { merged = git('merge-file', '-p', '--union', ours, base, theirs) }
  catch (e) { merged = e.stdout } // exits with the conflict count; --union leaves none
  return dedupe(merged, readFileSync(ours, 'utf8'), readFileSync(base, 'utf8'))
}

// After a merge already committed: the branch is the last merge's first parent.
function fix(file) {
  const text = readFileSync(file, 'utf8')
  const m = git('log', '-1', '--merges', '--first-parent', '--format=%H').trim()
  let ours = '', base = ''
  if (m) {
    ours = show(`${m}^1`, file)
    try { base = show(git('merge-base', `${m}^1`, `${m}^2`).trim(), file) } catch {}
  }
  const out = dedupe(text, ours, base)
  if (out !== text) writeFileSync(file, out)
}

function install() {
  try {
    git('rev-parse', '--git-dir')
    git('config', 'merge.llms-index.name', 'docs/llms.txt: union, one line per entry')
    git('config', 'merge.llms-index.driver', `${SELF} driver %O %A %B`)
    git('config', 'wherdr.afterMerge', `${SELF} fix`)
    // Shared by the clone's worktrees; .gitattributes keeps union for GitHub.
    const attrs = git('rev-parse', '--git-path', 'info/attributes').trim()
    const text = existsSync(attrs) ? readFileSync(attrs, 'utf8') : ''
    if (!text.split('\n').includes(ATTR)) {
      mkdirSync(dirname(attrs), { recursive: true })
      writeFileSync(attrs, `${text}${text && !text.endsWith('\n') ? '\n' : ''}${ATTR}\n`)
    }
  }
  catch {} // not a git clone (a package install): nothing to set up
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...args] = process.argv.slice(2)
  if (cmd === 'install') install()
  else if (cmd === 'driver') writeFileSync(args[1], mergeIndex(args[0], args[1], args[2]))
  else if (cmd === 'fix') fix(args[0] ?? INDEX)
  else { console.error('usage: llms-merge.mjs install | driver O A B | fix [file]'); process.exit(2) }
}
