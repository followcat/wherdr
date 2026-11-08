import { describe, expect, it } from 'vitest'
import { cleanupOf, cleanupRefusal, factsRefusal, parseFacts, underRoot } from '../shared/pm/cleanup'
import type { Run, Task } from '../shared/pm/run'

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
