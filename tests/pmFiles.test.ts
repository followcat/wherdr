import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { beyond, fileConflict, overlap, parseFiles, pastAgents } from '../shared/pm/files'
import { FILES_SCRIPT, parseFilesRead, releaseReason } from '../server/utils/pmFiles'
import type { Task } from '../shared/pm/run'

const task = (id: string, over: Partial<Task> = {}): Task => ({ id, project: 'WEB', title: 'T', description: '', type: 'simple', state: 'working', createdAt: 0, ...over })
const started = { at: 1, started: true, since: 1, proofs: {}, rounds: {} }

describe('declared files', () => {
  it('reads a list as written: one form per path, each once, comments and outside paths left out', () => {
    expect(parseFiles('./app/\ndocs/**\n# a note\n\nshared\\pm\\files.ts, app\n../secret\n.')).toEqual(['app', 'docs', 'shared/pm/files.ts'])
    expect(parseFiles(['a/', 'a'])).toEqual(['a'])
    expect(parseFiles(undefined)).toEqual([])
  })

  it('a folder covers what is in it; a shared prefix is not a folder', () => {
    expect(overlap('app', 'app/x.vue')).toBe(true)
    expect(overlap('app/x.vue', 'app')).toBe(true)
    expect(overlap('app', 'apps/x.vue')).toBe(false)
  })

  it('a start waits behind a started task of its project, not done, that declared or changed the same files', () => {
    const mine = task('WEB-3', { state: 'todo', files: ['server/utils', 'docs/a.md'] })
    const others = [
      task('WEB-1', { step: { ...started, done: true }, changed: ['docs/a.md'] }), // done
      task('OTHER-1', { project: 'OTHER', step: started, files: ['docs'] }), // another project
      task('WEB-4', { state: 'todo', files: ['docs'] }), // not started
      task('WEB-2', { state: 'waiting', step: started, files: ['app'], changed: ['server/utils/pmLaunch.ts'] }),
    ]
    expect(fileConflict(mine, others)).toEqual({ task: 'WEB-2', files: ['server/utils'] })
    expect(fileConflict({ ...mine, files: ['README.md'] }, others)).toBeUndefined()
    expect(fileConflict({ ...mine, files: undefined }, others)).toBeUndefined()
    // Only waiting for its merge (past its work and review): it holds no files.
    expect(fileConflict(mine, others, t => t.id === 'WEB-2')).toBeUndefined()
    expect(pastAgents([{ holder: 'worker' }, { holder: 'reviewer' }, { holder: 'none' }], 1)).toBe(false)
    expect(pastAgents([{ holder: 'worker' }, { holder: 'reviewer' }, { holder: 'none' }], 2)).toBe(true)
    // docs/llms.txt, merged by the engine, is never a reason to wait.
    const index = [task('WEB-5', { step: started, files: ['docs/llms.txt'], changed: ['docs/llms.txt'] })]
    expect(fileConflict({ ...mine, files: ['docs/llms.txt'] }, index)).toBeUndefined()
    expect(fileConflict({ ...mine, files: ['docs'] }, index)).toBeUndefined()
  })

  it('says what changed beyond the declared paths', () => {
    expect(beyond({ files: ['app'], changed: ['app/x.vue', 'docs/a.md'] })).toEqual(['docs/a.md'])
    expect(beyond({ changed: ['docs/a.md'] })).toEqual([])
  })

  it('reads the marker and the diff of a worktree', () => {
    expect(parseFilesRead('app/\n\n--wherdr-files--\napp/x.vue\nnew.ts\n')).toEqual({ files: ['app'], changed: ['app/x.vue', 'new.ts'] })
  })

  it('a worktree\'s changes leave out what merging its base brought in', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-files-'))
    const git = (...a: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=user@example.com', ...a], { stdio: 'pipe' }).toString().trim()
    const put = (f: string) => fs.writeFileSync(path.join(dir, f), f)
    try {
      git('init', '-q', '-b', 'main'); put('a'); git('add', '.'); git('commit', '-qm', 'a')
      git('switch', '-qc', 'task/X-1'); git('config', 'branch.task/X-1.wherdrstart', git('rev-parse', 'HEAD'))
      put('mine'); git('add', '.'); git('commit', '-qm', 'mine')
      git('switch', '-q', 'main'); put('theirs'); git('add', '.'); git('commit', '-qm', 'theirs')
      git('switch', '-q', 'task/X-1'); git('merge', '-q', '--no-edit', 'main'); put('new')
      const out = execFileSync('sh', ['-c', FILES_SCRIPT, 'sh', dir, 'task/X-1', path.join(dir, 'none.txt'), 'main']).toString()
      expect(parseFilesRead(out).changed).toEqual(['mine', 'new'])
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it('counts only what differs from origin\'s base, fetched now, even from a stale local base and with no base named', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-files-'))
    const origin = path.join(root, 'origin.git'), up = path.join(root, 'up'), dir = path.join(root, 'wt')
    const git = (d: string, ...a: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=user@example.com', ...a], { stdio: 'pipe' }).toString().trim()
    const commit = (d: string, f: string) => { fs.writeFileSync(path.join(d, f), f); git(d, 'add', '.'); git(d, 'commit', '-qm', f) }
    try {
      git(root, 'init', '-q', '--bare', '-b', 'main', origin)
      git(root, 'clone', '-q', origin, up); git(up, 'switch', '-qc', 'main'); commit(up, 'a'); git(up, 'push', '-q', 'origin', 'main')
      git(root, 'clone', '-q', origin, dir)
      // Origin moves on; the task's clone has not fetched: its main and origin/main are behind.
      commit(up, 'theirs'); git(up, 'push', '-q', 'origin', 'main')
      git(dir, 'switch', '-qc', 'task/X-1', 'main'); git(dir, 'config', 'branch.task/X-1.wherdrstart', git(dir, 'rev-parse', 'HEAD'))
      // The worker brings origin's base in (without moving origin/main here) and makes its own change.
      git(dir, 'pull', '-q', '--no-rebase', '--no-edit', origin, 'main'); commit(dir, 'mine')
      const read = (base: string) => parseFilesRead(execFileSync('sh', ['-c', FILES_SCRIPT, 'sh', dir, 'task/X-1', path.join(dir, 'none.txt'), base]).toString()).changed
      expect(read('')).toEqual(['mine'])
      expect(read('main')).toEqual(['mine'])
      // No origin/HEAD (git init + remote add): origin is asked for its default branch.
      git(dir, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD')
      expect(read('')).toEqual(['mine'])
      // A base origin does not have: the local one.
      git(dir, 'branch', 'local-base', 'task/X-1~1'); expect(read('local-base')).toEqual(['mine'])
      // Origin out of reach: nothing is read, rather than from a stale origin/main.
      fs.renameSync(origin, `${origin}.off`)
      expect(() => read('main')).toThrow()
      expect(() => read('')).toThrow()
    }
    finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  it('says why a waiting task is released', () => {
    const holder = task('WEB-1', { step: started, files: ['app'] })
    expect(releaseReason('WEB-1', [{ ...holder, step: { ...started, done: true } }], () => false)).toBe('WEB-1 is done')
    expect(releaseReason('WEB-1', [holder], () => true)).toBe('WEB-1 is at merge')
    expect(releaseReason('WEB-1', [holder], () => false)).toBe('WEB-1 no longer changes these files')
    expect(releaseReason('WEB-1', [], () => false)).toBe('WEB-1 is gone')
  })
})
