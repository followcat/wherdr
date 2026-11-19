import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupOf, cleanupRefusal, factsRefusal, mergedByStep, mergedCommit, parseFacts, underRoot } from '../shared/pm/cleanup'
import type { PlannedStep } from '../shared/pm/steps'
import { TMP_DIR, agentEnv, tmpRefusal, type Run, type Task } from '../shared/pm/run'
import { TMP_SCRIPT } from '../server/utils/pmLaunch'
import { REMOVING, WORKTREE_PROBE_SCRIPT, WORKTREE_REMOVE_SCRIPT } from '../server/utils/pmCleanup'

const root = '/home/user/.wherdr/pm/worktrees'
const task = (step: Partial<NonNullable<Task['step']>> = {}): Task => ({
  id: 'WH-1', project: 'WH', title: 'Fix it', description: '', type: 'simple', state: 'working', createdAt: 0,
  step: { at: 5, since: 0, started: true, ...step } as Task['step'],
})
const run = (state: Run['state']) => ({ task: 'WH-1', state }) as Run
const clean = { exists: true, listed: true, dirty: 0, unique: 0 }

describe('which worktree may go', () => {
  it('merged and done: worktree and branch; archived: the worktree only; not done: nothing', () => {
    expect(cleanupOf(task({ done: true }))).toBe('worktree+branch')
    expect(cleanupOf(task({ done: true, abandoned: true }))).toBe('worktree')
    expect(cleanupOf(task())).toBeUndefined()
  })

  it('only a folder inside the pm worktrees folder', () => {
    expect(underRoot(`${root}/WH-1`, root)).toBe(true)
    expect(underRoot(`${root}/WH-1`, `${root}/`)).toBe(true)
    for (const dir of [root, `${root}/`, `${root}/../WH-1`, `${root}/a/./b`, `${root}x/WH-1`, '/home/user/project', 'WH-1'])
      expect(underRoot(dir, root)).toBe(false)
    expect(underRoot('/x/WH-1', 'x')).toBe(false)
  })

  it('refuses a task not done, one with an agent still running, a folder elsewhere', () => {
    const done = task({ done: true })
    expect(cleanupRefusal(done, [run('ended')], `${root}/WH-1`, root)).toBeUndefined()
    expect(cleanupRefusal(task(), [], `${root}/WH-1`, root)).toMatch(/not done/)
    expect(cleanupRefusal(done, [run('running')], `${root}/WH-1`, root)).toMatch(/agent still runs/)
    expect(cleanupRefusal(done, [], '/home/user/project', root)).toMatch(/not under/)
  })

  it('keeps a worktree with changes, unknown to git, or with commits found nowhere else', () => {
    expect(factsRefusal(clean)).toBeUndefined()
    expect(factsRefusal({ ...clean, exists: false, listed: false })).toBeUndefined()
    expect(factsRefusal({ ...clean, listed: false })).toMatch(/not a worktree/)
    expect(factsRefusal({ ...clean, dirty: 2 })).toBe('2 uncommitted changes')
    expect(factsRefusal({ ...clean, unique: 1 })).toBe('1 commit neither pushed nor merged')
    // Worktree gone, branch with its own commits: the branch stays.
    expect(factsRefusal({ ...clean, exists: false, unique: 3 })).toMatch(/3 commits/)
  })

  it('a merge step\'s proof: merged, and the commit it merged', () => {
    const plan = [{ id: 'pr', action: { kind: 'github.pr' } }, { id: 'merge', action: { kind: 'github.merge' } }] as PlannedStep[]
    const sha = 'a'.repeat(40)
    expect(mergedByStep(plan, task({ done: true, proofs: { merge: { link: 'https://example.com/pull/1' } } }).step)).toBe(true)
    expect(mergedByStep(plan, task({ done: true, proofs: { pr: { link: 'https://example.com/pull/1' } } }).step)).toBe(false)
    expect(mergedCommit(plan, task({ done: true, proofs: { pr: { commit: 'b'.repeat(40) }, merge: { commit: sha } } }).step)).toBe(sha)
    expect(mergedCommit(plan, task({ proofs: { merge: { commit: sha } } }).step)).toBeUndefined()
    expect(mergedCommit(plan, task({ done: true, proofs: { merge: { commit: '-x' } } }).step)).toBeUndefined()
  })

  it('reads the probe line; anything else is no answer', () => {
    expect(parseFacts('warning\n1 1 0 2\n')).toEqual({ exists: true, listed: true, dirty: 0, unique: 2 })
    for (const out of ['', '1 1 0', '1 1 x 0', '1 1 -1 0']) expect(parseFacts(out)).toBeUndefined()
  })
})

describe('removing a squash-merged worktree, in a temporary folder', () => {
  it('removes the merged one with its size; keeps one with uncommitted changes or a commit after the merged one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-sweep-'))
    const sh = (script: string, ...args: string[]) => execFileSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' })
    const git = 'git -c user.name=t -c user.email=t@example.com'
    try {
      const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), wts = path.join(dir, 'worktrees')
      sh(`git init -q --bare -b main "$1" && git clone -q "$1" "$2" 2>/dev/null && ${git} -C "$2" commit -q --allow-empty -m init && git -C "$2" push -q origin main`, origin, repo)
      for (const id of ['WH-1', 'WH-2']) {
        // Its commit pushed, squash-merged on main, its remote branch deleted.
        sh(`git -C "$1" worktree add -q -b task/$2 "$3/$2" && echo $2 > "$3/$2/$2.txt" && ${git} -C "$3/$2" add . && ${git} -C "$3/$2" commit -q -m $2 && git -C "$3/$2" push -q origin task/$2
          git -C "$1" checkout -q main && git -C "$1" pull -q && ${git} -C "$1" merge -q --squash task/$2 && ${git} -C "$1" commit -q -m "$2 (#1)" && git -C "$1" push -q origin main --delete task/$2 2>/dev/null; git -C "$1" fetch -q --prune`, repo, id, wts)
      }
      const head = (id: string) => sh('git -C "$1" rev-parse HEAD', `${wts}/${id}`).trim()
      const merged1 = head('WH-1'), merged2 = head('WH-2')
      fs.writeFileSync(path.join(wts, 'WH-2', 'notes.txt'), 'wip')
      const probe = (id: string, merged: string) => parseFacts(sh(WORKTREE_PROBE_SCRIPT, repo, `${wts}/${id}`, `task/${id}`, merged))!
      expect(probe('WH-1', '').unique).toBeGreaterThan(0)
      // A commit added after the merged one is not merged: kept.
      sh(`${git} -C "$1" commit -q --allow-empty -m later`, `${wts}/WH-1`)
      expect(factsRefusal(probe('WH-1', merged1))).toBe('1 commit neither pushed nor merged')
      sh('git -C "$1" reset -q --hard HEAD~1', `${wts}/WH-1`)
      expect(factsRefusal(probe('WH-1', merged1))).toBeUndefined()
      expect(sh(WORKTREE_REMOVE_SCRIPT, repo, `${wts}/WH-1`, 'task/WH-1', '1')).toMatch(/^freed \d+$/m)
      expect(fs.existsSync(`${wts}/WH-1`)).toBe(false)
      expect(sh('git -C "$1" branch --list task/WH-1', repo)).toBe('')
      expect(factsRefusal(probe('WH-2', merged2))).toBe('1 uncommitted change')
      expect(fs.existsSync(`${wts}/WH-2/notes.txt`)).toBe(true)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})

describe('a worktree an earlier removal left halfway, in a temporary folder', () => {
  it('only tracked files deleted (its .git file too): finished; a file changed besides: kept', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-half-'))
    const sh = (script: string, ...args: string[]) => execFileSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' })
    const status = (script: string, ...args: string[]) => { try { sh(script, ...args); return 0 } catch (e) { return (e as { status: number }).status } }
    try {
      const repo = path.join(root, 'repo')
      sh('git init -q "$1" && for f in a b c; do echo $f > "$1/$f.txt"; done && git -C "$1" add . && git -C "$1" -c user.name=t -c user.email=t@example.com commit -q -m init', repo)
      // As a removal killed halfway leaves them: locked, some tracked files and the .git file gone.
      for (const id of ['WH-1', 'WH-2']) sh('git -C "$1" worktree add -q -b task/$2 "$3/$2" && git -C "$1" worktree lock --reason "$4" "$3/$2" && rm "$3/$2/a.txt" "$3/$2/.git"', repo, id, root, REMOVING)
      // WH-1: only deletions. Its removal's prune does not forget WH-2 (locked).
      const wt1 = path.join(root, 'WH-1')
      expect(parseFacts(sh(WORKTREE_PROBE_SCRIPT, repo, wt1, 'task/WH-1'))).toMatchObject({ exists: true, listed: true, dirty: 0 })
      // No timeout command (a plain macOS) and a du that never ends: removed all the same, its size not said.
      const bin = path.join(root, 'bin')
      fs.mkdirSync(bin)
      for (const d of (process.env.PATH ?? '').split(':').filter(d => fs.existsSync(d))) {
        for (const f of fs.readdirSync(d)) {
          if (['timeout', 'gtimeout', 'du'].includes(f) || fs.existsSync(path.join(bin, f))) continue
          fs.symlinkSync(path.join(d, f), path.join(bin, f))
        }
      }
      fs.writeFileSync(path.join(bin, 'du'), '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })
      const out = execFileSync('sh', ['-c', WORKTREE_REMOVE_SCRIPT, 'sh', repo, wt1, 'task/WH-1', '0'], { encoding: 'utf8', env: { ...process.env, PATH: bin } })
      expect(out).not.toMatch(/^freed/m)
      expect(fs.existsSync(wt1)).toBe(false)
      // WH-2: a modified file besides the deletions: kept, the probe and the removal both say so.
      const wt2 = path.join(root, 'WH-2')
      fs.writeFileSync(path.join(wt2, 'b.txt'), 'edited')
      expect(factsRefusal(parseFacts(sh(WORKTREE_PROBE_SCRIPT, repo, wt2, 'task/WH-2'))!)).toBe('1 uncommitted change')
      expect(status(WORKTREE_REMOVE_SCRIPT, repo, wt2, 'task/WH-2', '0')).toBe(3)
      expect(fs.readFileSync(path.join(wt2, 'b.txt'), 'utf8')).toBe('edited')
      // A worktree locked by someone else stays.
      const wt3 = path.join(root, 'WH-3')
      sh('git -C "$1" worktree add -q -b task/WH-3 "$2" && git -C "$1" worktree lock --reason mine "$2"', repo, wt3)
      expect(status(WORKTREE_REMOVE_SCRIPT, repo, wt3, 'task/WH-3', '0')).toBe(3)
      expect(fs.existsSync(path.join(wt3, 'b.txt'))).toBe(true)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
   }, 30_000)
})

describe('the agents\' temp folder', () => {
  it('points every temp variable into the worktree, and refuses a nearly full /tmp', () => {
    const tmp = `/home/user/.wherdr/pm/worktrees/WH-1/${TMP_DIR}`
    expect(agentEnv('/home/user/.wherdr/pm/worktrees/WH-1')).toEqual({ DISABLE_AUTOUPDATER: '1', TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, NODE_COMPILE_CACHE: tmp })
    expect(tmpRefusal(`${300 * 1024}\n`)).toMatch(/only 300 MB free/)
    for (const out of [`${600 * 1024}`, '', 'df: no such file']) expect(tmpRefusal(out)).toBeUndefined()
  })

  it('is ignored by git, does not keep the worktree, and goes with it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-tmp-'))
    const sh = (script: string, ...args: string[]) => execFileSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8' })
    try {
      const repo = path.join(root, 'repo'), wt = path.join(root, 'WH-1')
      sh('git init -q "$1" && git -C "$1" -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init && git -C "$1" worktree add -q -b task/WH-1 "$2"', repo, wt)
      expect(Number(sh(TMP_SCRIPT, wt, TMP_DIR))).toBeGreaterThan(0)
      sh(TMP_SCRIPT, wt, TMP_DIR)
      fs.writeFileSync(path.join(wt, TMP_DIR, 'cache.bin'), 'x')
      expect(fs.readFileSync(path.join(repo, '.git/info/exclude'), 'utf8').split('\n').filter(l => l === `/${TMP_DIR}/`)).toHaveLength(1)
      expect(parseFacts(sh(WORKTREE_PROBE_SCRIPT, repo, wt, 'task/WH-1'))).toMatchObject({ exists: true, listed: true, dirty: 0 })
      // A shell left looping in it, re-parented to init, is killed first.
      const loop = Number(sh('cd "$1" || exit 1; sh -c "while :; do sleep 1; done" >/dev/null 2>&1 & echo $!', path.join(wt, TMP_DIR)))
      expect(sh(WORKTREE_REMOVE_SCRIPT, repo, wt, 'task/WH-1', '0')).toMatch(/^killed [12]$/m)
      expect(fs.existsSync(wt)).toBe(false)
      expect(() => process.kill(loop, 0)).toThrow()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })
})
