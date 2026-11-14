import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cleanupOf, cleanupRefusal, factsRefusal, parseFacts, underRoot } from '../shared/pm/cleanup'
import { TMP_DIR, agentEnv, tmpRefusal, type Run, type Task } from '../shared/pm/run'
import { TMP_SCRIPT } from '../server/utils/pmLaunch'
import { WORKTREE_PROBE_SCRIPT, WORKTREE_REMOVE_SCRIPT } from '../server/utils/pmCleanup'

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

  it('reads the probe line; anything else is no answer', () => {
    expect(parseFacts('warning\n1 1 0 2\n')).toEqual({ exists: true, listed: true, dirty: 0, unique: 2 })
    for (const out of ['', '1 1 0', '1 1 x 0', '1 1 -1 0']) expect(parseFacts(out)).toBeUndefined()
  })
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
