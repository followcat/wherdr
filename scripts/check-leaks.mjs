#!/usr/bin/env node
// Leak check: gitleaks + forbidden patterns read from a local, untracked file (.leak-patterns).
//   (default)          scans the content of the git index (tracked or staged files)
//   --staged           only scans staged files (pre-commit hook)
//   --range <revs>     scans every commit of a revision range (`origin/main..HEAD`): the lines
//                      each commit adds and its message, so a leak added then removed is caught
//   --no-gitleaks      skips gitleaks (patterns only)
// gitleaks runs from the `gitleaks` binary when installed, otherwise it is skipped.
// In a linked worktree (`git worktree add`), .leak-patterns (ignored by git) often only
// exists in the main checkout: we then fall back to that one.
//
// .leak-patterns format (see .leak-patterns.example):
//   # comment
//   <regex>                        forbidden pattern (case-insensitive)
//   <regex>  !! LICENSE, docs/*.md pattern allowed in these files
//   ! <glob>                       file never scanned by the patterns
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PATTERNS_FILE = '.leak-patterns'
const ALWAYS_SKIPPED = ['.leak-patterns', '.leak-patterns.example', 'package-lock.json']

/** Simple glob: `*` = anything but `/`, `**` = anything, `?` = one character. */
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++ }
    else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

const matchesAny = (file, globs) => globs.some((g) => g.test(file))

/** Parses the pattern file text. Throws a readable error on an invalid regex. */
export function parsePatterns(text) {
  const rules = []
  const skip = []
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith('#')) return
    if (line.startsWith('!') && !line.startsWith('!!')) {
      skip.push(globToRegExp(line.slice(1).trim()))
      return
    }
    const [source, allowed = ''] = line.split(/\s+!!\s+/)
    let regex
    try { regex = new RegExp(source.trim(), 'gi') }
    catch (e) { throw new Error(`${PATTERNS_FILE}:${i + 1}: invalid regex (${e.message})`) }
    const allow = allowed.split(',').map((s) => s.trim()).filter(Boolean).map(globToRegExp)
    rules.push({ source: source.trim(), regex, allow })
  })
  return { rules, skip }
}

/** Reads the pattern file; `null` if it does not exist. */
export function loadPatterns(file) {
  if (!existsSync(file)) return null
  return parsePatterns(readFileSync(file, 'utf8'))
}

const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20 })

/** Root of the main checkout when `root` is a linked worktree; `null` otherwise. */
export function mainCheckoutRoot(root) {
  let common
  try { common = git(['rev-parse', '--git-common-dir'], root).trim() }
  catch { return null }
  common = path.resolve(root, common)
  // Bare repository or submodule: no main checkout next to the common .git folder.
  if (path.basename(common) !== '.git') return null
  const main = path.dirname(common)
  return path.resolve(main) === path.resolve(root) ? null : main
}

/**
 * Pattern file to use: the current checkout's, otherwise the main checkout's.
 * Returns `{ file, from: 'checkout' | 'main' }`, or `{ file: null, tried }` if none exists.
 */
export function findPatternsFile(root) {
  const own = path.join(root, PATTERNS_FILE)
  if (existsSync(own)) return { file: own, from: 'checkout' }
  const tried = [own]
  const main = mainCheckoutRoot(root)
  if (main) {
    const shared = path.join(main, PATTERNS_FILE)
    if (existsSync(shared)) return { file: shared, from: 'main' }
    tried.push(shared)
  }
  return { file: null, tried }
}

/** Shows enough to find the value without displaying it in full. */
export function redact(value) {
  if (value.length <= 4) return `${value[0] ?? ''}…`
  return `${value.slice(0, Math.min(4, Math.floor(value.length / 3)))}…(${value.length} chars)`
}

/** Hits of the rules in numbered lines (`[{ n, text }]`), without the file filters. */
function matchLines(lines, rules) {
  const hits = []
  for (const rule of rules) {
    for (const { n, text } of lines) {
      for (const m of text.matchAll(rule.regex)) {
        if (!m[0]) continue
        hits.push({ line: n, pattern: rule.source, excerpt: redact(m[0]) })
      }
    }
  }
  return hits
}

/** Looks for the patterns in some lines of a file, honouring ignored files and exceptions. */
function scanLines(file, lines, patterns) {
  if (ALWAYS_SKIPPED.includes(path.basename(file)) || matchesAny(file, patterns.skip)) return []
  const rules = patterns.rules.filter((rule) => !matchesAny(file, rule.allow))
  return matchLines(lines, rules).map((h) => ({ file, ...h }))
}

/** Looks for the patterns in a file's content. */
export function scanText(file, text, patterns) {
  return scanLines(file, text.split('\n').map((t, i) => ({ n: i + 1, text: t })), patterns)
}

/** Unquotes a path as git prints it in a diff header (`"a\303\251.txt"` when quoted). */
function diffPath(raw) {
  if (!raw.startsWith('"')) return raw
  const bytes = []
  const s = raw.slice(1, -1)
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { bytes.push(...Buffer.from(s[i])); continue }
    const c = s[++i]
    if (/[0-7]/.test(c)) { bytes.push(parseInt(s.slice(i, i + 3), 8)); i += 2 }
    else bytes.push(({ n: 10, t: 9, '"': 34, '\\': 92 })[c] ?? c.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Lines a commit adds, per file, from `git diff-tree -p` output. Merges use the combined
 * format (`--cc`: one marker column per parent), which only keeps conflict resolutions:
 * the lines of the merged commits are scanned with those commits.
 */
export function addedLines(patch) {
  const files = new Map()
  let lines = null
  let parents = 1
  let next = 0
  for (const row of patch.split('\n')) {
    if (row.startsWith('diff ')) { lines = null; continue }
    if (row.startsWith('+++ ')) {
      const target = row.slice(4)
      if (target === '/dev/null') { lines = null; continue }
      const file = diffPath(target).replace(/^b\//, '')
      lines = files.get(file) ?? []
      files.set(file, lines)
      continue
    }
    const hunk = /^(@@+) .*?\+(\d+)/.exec(row)
    if (hunk) { parents = hunk[1].length - 1; next = Number(hunk[2]); continue }
    if (!lines || !next) continue
    const marks = row.slice(0, parents)
    if (marks.includes('-')) continue
    if (marks.includes('+')) lines.push({ n: next, text: row.slice(parents) })
    next++
  }
  return files
}

/**
 * Scans each commit of `range` (as `git rev-list` reads it): the lines it adds, with the file
 * rules, and its message, with every rule. Hits carry the short commit and `file: null` for
 * the message.
 */
export function scanRange(root, range, patterns) {
  const commits = git(['rev-list', '--reverse', range], root).split('\n').filter(Boolean)
  const hits = []
  for (const sha of commits) {
    const commit = sha.slice(0, 9)
    const message = git(['log', '-1', '--format=%B', sha], root)
    const msgLines = message.split('\n').map((t, i) => ({ n: i + 1, text: t }))
    hits.push(...matchLines(msgLines, patterns.rules).map((h) => ({ commit, file: null, ...h })))
    const patch = git(['diff-tree', '-p', '--cc', '--root', '-r', '--no-color', '--no-ext-diff', '--no-textconv', '-U0', sha], root)
    for (const [file, lines] of addedLines(patch)) {
      hits.push(...scanLines(file, lines, patterns).map((h) => ({ commit, ...h })))
    }
  }
  return { commits: commits.length, hits }
}

/** Copies the index content (all files or only staged ones) into a temporary folder. */
function exportIndex(root, staged) {
  const list = staged
    ? git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root)
    : git(['ls-files', '-z'], root)
  const files = list.split('\0').filter(Boolean)
  const dir = mkdtempSync(path.join(tmpdir(), 'leaks-'))
  if (files.length) {
    execFileSync('git', ['checkout-index', '-z', '--stdin', `--prefix=${dir}/`], { cwd: root, input: files.join('\0') })
  }
  return { dir, files }
}

/** Whether the `gitleaks` binary is installed. */
const hasGitleaks = () => !spawnSync('gitleaks', ['version'], { encoding: 'utf8' }).error

/** Runs gitleaks on a folder (`dir` mode) or on a commit range (`git` mode). */
function runGitleaks({ dir, root, range }) {
  // --verbose lists each finding (commit, file, line, rule); --redact hides the secret itself.
  const opts = ['--redact', '--verbose', '--no-banner', '--exit-code', '1']
  // Index scans run on a temporary export, outside the repository config discovery.
  const config = path.join(root ?? git(['rev-parse', '--show-toplevel']).trim(), '.gitleaks.toml')
  if (existsSync(config)) opts.push('--config', config)
  const args = range ? ['git', root, `--log-opts=${range}`, ...opts] : ['dir', dir, ...opts]
  if (!hasGitleaks()) {
    console.log('gitleaks: not installed, skipped (https://github.com/gitleaks/gitleaks). Forbidden patterns still run.')
    return true
  }
  const r = spawnSync('gitleaks', args, { stdio: 'inherit' })
  if (r.status === 0) console.log('gitleaks: no secret found.')
  else if (r.status !== 1) console.error(`gitleaks: failed to run (exit ${r.status ?? r.signal}).`)
  return r.status === 0
}

/** Loads the pattern file and says which one is used; `null` (with a warning) if none. */
function patternsFor(root) {
  const found = findPatternsFile(root)
  const patterns = found.file && loadPatterns(found.file)
  if (!patterns) {
    console.warn([
      `WARNING: no ${PATTERNS_FILE} file found, forbidden patterns were NOT checked.`,
      ...found.tried.map((f) => `  looked for: ${f}`),
      `  Copy ${PATTERNS_FILE}.example to ${PATTERNS_FILE} in the main checkout and fill it.`,
    ].join('\n'))
    return null
  }
  console.log(`patterns: using ${found.file}${found.from === 'main' ? ' (main checkout)' : ''}`)
  if (!patterns.rules.length) console.warn(`WARNING: ${found.file} has no active pattern, nothing is forbidden.`)
  return patterns
}

function mainRange(root, range, gitleaks) {
  let ok = gitleaks ? runGitleaks({ root, range }) : true
  const patterns = patternsFor(root)
  if (!patterns) return ok ? 0 : 1
  const { commits, hits } = scanRange(root, range, patterns)
  for (const h of hits) {
    console.log(h.file === null
      ? `${h.commit} message:${h.line}  ${h.excerpt}  [${h.pattern}]`
      : `${h.commit} ${h.file}:${h.line}  ${h.excerpt}  [${h.pattern}]`)
  }
  console.log(hits.length
    ? `patterns: ${hits.length} forbidden match(es) in ${commits} commit(s) of ${range}.`
    : `patterns: ${patterns.rules.length} pattern(s), ${commits} commit(s) of ${range}, no match.`)
  if (hits.length) ok = false
  return ok ? 0 : 1
}

function main(argv) {
  const staged = argv.includes('--staged')
  const gitleaks = !argv.includes('--no-gitleaks')
  const root = git(['rev-parse', '--show-toplevel']).trim()
  const r = argv.indexOf('--range')
  if (r !== -1) {
    const range = argv[r + 1]
    if (!range || range.startsWith('--')) throw new Error('--range needs a revision range, e.g. origin/main..HEAD')
    return mainRange(root, range, gitleaks)
  }
  const { dir, files } = exportIndex(root, staged)
  try {
    if (!files.length) { console.log('check:leaks: nothing to scan.'); return 0 }
    let ok = gitleaks ? runGitleaks({ dir }) : true
    const patterns = patternsFor(root)
    if (patterns) {
      const hits = []
      for (const file of files) {
        const buf = readFileSync(path.join(dir, file))
        if (buf.includes(0)) continue // binaire
        hits.push(...scanText(file, buf.toString('utf8'), patterns))
      }
      for (const h of hits) console.log(`${h.file}:${h.line}  ${h.excerpt}  [${h.pattern}]`)
      console.log(hits.length
        ? `patterns: ${hits.length} forbidden match(es) in ${files.length} file(s).`
        : `patterns: ${patterns.rules.length} pattern(s), ${files.length} file(s), no match.`)
      if (hits.length) ok = false
    }
    return ok ? 0 : 1
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exit(main(process.argv.slice(2))) }
  catch (e) { console.error(`check:leaks: ${e.message}`); process.exit(2) }
}
