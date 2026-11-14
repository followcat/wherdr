// "SOURCE: unbound variable" in `herdr-plugin.sh update` (issue #45): in
// "$SOURCE…", macOS's bash 3.2 reads the first byte of "…" as a letter in a
// UTF-8 locale (as any bash does in a Latin-1 one), looks up "SOURCE\xe2",
// and `set -u` stops the script. A variable followed by a non-ASCII character
// must be written ${NAME}. Only expansions count: comments, single-quoted
// strings and escaped dollars expand nothing.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO = path.resolve(import.meta.dirname, '..')
const UNBRACED = /^\$[A-Za-z_]\w*[^\x00-\x7F]/

// Unbraced variables followed by a non-ASCII character, among the dollars of
// a line that the shell expands: outside comments, single quotes and after no
// backslash. (Heredoc bodies are scanned like any line: stricter, never laxer.)
function unbracedExpansions(line: string): string[] {
  const found: string[] = []
  let single = false, double = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (single) { if (c === "'") single = false; continue }
    if (c === '\\') { i++; continue }
    if (c === "'" && !double) { single = true; continue }
    if (c === '"') { double = !double; continue }
    if (c === '#' && !double && (i === 0 || /\s/.test(line[i - 1]!))) break
    if (c === '$') {
      const m = UNBRACED.exec(line.slice(i))
      if (m) found.push(m[0])
    }
  }
  return found
}

const SKIP = new Set(['node_modules', '.git', '.nuxt', '.output', '.data', '.shots', 'dist', 'test-results', 'playwright-report'])

function shellScripts(dir = REPO): string[] {
  const out: string[] = []
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name) || d.name.startsWith('.herdr')) continue
    const full = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...shellScripts(full))
    else if (d.isFile() && (d.name.endsWith('.sh') || isShellBin(full))) out.push(path.relative(REPO, full))
  }
  return out
}

function isShellBin(file: string) {
  if (path.extname(file)) return false
  try { return /^#!.*\b(ba|da|z)?sh\b/.test(readFileSync(file, 'utf8').slice(0, 80)) }
  catch { return false }
}

describe('shell scripts', () => {
  it('include the v3 installer', () => {
    expect(shellScripts()).toContain('scripts/install-v3-beside-v2.sh')
  })

  it('flag only expanded variables', () => {
    expect(unbracedExpansions('say "from $SOURCE…"')).toEqual(['$SOURCE…'])
    expect(unbracedExpansions('echo $A…')).toHaveLength(1)
    expect(unbracedExpansions('say "from ${SOURCE}…"')).toEqual([])
    expect(unbracedExpansions('# from $SOURCE…')).toEqual([])
    expect(unbracedExpansions('say ok  # from $SOURCE…')).toEqual([])
    expect(unbracedExpansions("echo 'from $SOURCE…'")).toEqual([])
    expect(unbracedExpansions('echo "from \\$SOURCE…"')).toEqual([])
    expect(unbracedExpansions('echo "it\'s $SOURCE…"')).toHaveLength(1)
    expect(unbracedExpansions('echo "a#$SOURCE…"')).toHaveLength(1)
  })

  it('brace every variable followed by a non-ASCII character', () => {
    const bad: string[] = []
    for (const f of shellScripts()) {
      readFileSync(path.join(REPO, f), 'utf8').split('\n').forEach((line, i) => {
        if (unbracedExpansions(line).length) bad.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(bad).toEqual([])
  })

  // The failure itself, where bash and a Latin-1 locale exist. Not macOS's
  // case (bash 3.2, UTF-8 locale) and often skipped: the scan above is the
  // guard, this only shows the mechanism.
  const norm = (l: string) => l.toLowerCase().replace(/[-_]/g, '')
  const r = spawnSync('bash', ['-c', 'locale -a'], { encoding: 'utf8' })
  const known = r.status === 0 ? r.stdout.split('\n').map(norm) : []
  const latin1 = ['en_US.iso885915', 'en_US.ISO8859-1', 'fr_FR.ISO8859-1'].find(l => known.includes(norm(l)))
  it.skipIf(!latin1)('fails unbraced and works braced under set -u', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'wherdr-shvar-'))
    try {
      const run = (body: string) => {
        const f = path.join(dir, 's.sh')
        writeFileSync(f, `set -u\nSOURCE=owner/wherdr\necho "from ${body}…"\n`)
        return spawnSync('bash', [f], { encoding: 'utf8', env: { ...process.env, LC_ALL: latin1 } })
      }
      expect(run('$SOURCE').stderr).toMatch(/unbound variable/)
      const ok = run('${SOURCE}')
      expect(ok.status).toBe(0)
      expect(ok.stdout).toBe('from owner/wherdr…\n')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
