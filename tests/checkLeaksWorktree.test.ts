// Leak check in a linked worktree: patterns of the main checkout, warning otherwise.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error JS module without declarations
import { findPatternsFile, mainCheckoutRoot } from '../scripts/check-leaks.mjs'

const script = path.resolve('scripts/check-leaks.mjs')
const dirs: string[] = []
// Without the GIT_* variables of a possible parent hook, which would target the real repository.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')))

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' })

/** Throwaway repository with a commit and a linked worktree; returns both roots. */
function repoWithWorktree() {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'leaks-wt-')))
  dirs.push(base)
  const main = path.join(base, 'main')
  const wt = path.join(base, 'wt')
  execFileSync('git', ['init', '-q', main], { env })
  git(main, 'config', 'user.email', 'test@example.invalid')
  git(main, 'config', 'user.name', 'Test')
  writeFileSync(path.join(main, '.gitignore'), '.leak-patterns\n')
  writeFileSync(path.join(main, 'a.txt'), 'hello forbidden-word\n')
  git(main, 'add', '.')
  git(main, 'commit', '-qm', 'init')
  git(main, 'worktree', 'add', '-q', wt)
  return { main, wt }
}

const run = (cwd: string) => spawnSync(process.execPath, [script, '--no-gitleaks'], { cwd, env, encoding: 'utf8' })

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

// These tests create real repositories: skipped where git is not installed (node:22-alpine image).
const hasGit = spawnSync('git', ['--version']).status === 0

describe.skipIf(!hasGit)('check-leaks in a worktree', () => {
  it('passes the repository gitleaks config when scanning an exported index', () => {
    const { wt } = repoWithWorktree()
    const config = path.join(wt, '.gitleaks.toml')
    writeFileSync(config, '[extend]\nuseDefault = true\n')
    const binary = path.join(wt, 'gitleaks')
    writeFileSync(binary, '#!/usr/bin/env node\nif (process.argv[2] !== "version" && !process.argv.includes(process.env.EXPECTED_CONFIG)) process.exit(1)\n')
    chmodSync(binary, 0o755)
    const r = spawnSync(process.execPath, [script], {
      cwd: wt, encoding: 'utf8', env: { ...env, PATH: `${wt}${path.delimiter}${env.PATH}`, EXPECTED_CONFIG: config },
    })
    expect(r.stdout).toContain('gitleaks: no secret found.')
    expect(r.status).toBe(0)
  })

  it('finds the main checkout from a linked worktree, not from the main one', () => {
    const { main, wt } = repoWithWorktree()
    expect(realpathSync(mainCheckoutRoot(wt))).toBe(main)
    expect(mainCheckoutRoot(main)).toBeNull()
  })

  it('uses the main checkout\'s .leak-patterns when the worktree has none', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(path.join(main, '.leak-patterns'), 'forbidden-word\n')
    const found = findPatternsFile(wt)
    expect(found.from).toBe('main')
    expect(realpathSync(found.file)).toBe(path.join(main, '.leak-patterns'))

    const r = run(wt)
    expect(r.stdout).toContain('(main checkout)')
    expect(r.stdout).toContain('1 forbidden match')
    expect(r.status).toBe(1)
  })

  it('prefers the worktree\'s file when it exists', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(path.join(main, '.leak-patterns'), 'forbidden-word\n')
    writeFileSync(path.join(wt, '.leak-patterns'), 'other-word\n')
    expect(findPatternsFile(wt)).toEqual({ file: path.join(wt, '.leak-patterns'), from: 'checkout' })
  })

  it('warns clearly when no pattern file exists', () => {
    const { main, wt } = repoWithWorktree()
    const found = findPatternsFile(wt)
    expect(found.file).toBeNull()
    expect(found.tried.map((f: string) => realpathSync(path.dirname(f)))).toEqual([wt, main])

    const r = run(wt)
    expect(r.stderr).toContain('WARNING: no .leak-patterns file found')
    expect(r.stderr).toContain(path.join(main, '.leak-patterns'))
  })

  it('warns when the pattern file contains no active pattern', () => {
    const { main, wt } = repoWithWorktree()
    writeFileSync(path.join(main, '.leak-patterns'), '# only comments\n\n')
    expect(run(wt).stderr).toContain('has no active pattern')
  })
})
