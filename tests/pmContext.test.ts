// Context folders: read-only snapshots of other members of a task's workspace
// (shared/pm/context.ts, CONTEXT_SCRIPT, the sweep). The scripts run for real,
// in made-up repositories under a temp folder.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkTaskContext, contextArgs, contextBase, contextLine, contextMembers, contextRoot, contextSection, staleSnapshots, taskContext, type ContextFolder } from '../shared/pm/context'
import { agentLine, dirArgs, type Run, type Task } from '../shared/pm/run'
import { parseContext, readContext, validateTemplate, type Template } from '../shared/pm/workflow'
import { parseCommand } from '../shared/pm/coordinator'
import type { Project } from '../shared/pm/project'
import { createPmStore } from '../server/utils/pmStore'
import { CONTEXT_SCRIPT, startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { CONTEXT_LIST_SCRIPT, CONTEXT_REMOVE_SCRIPT, sweepWorktrees } from '../server/utils/pmCleanup'

const ws: Project = { key: 'WS', name: 'Work', machine: 'home', path: '/h/work', kind: 'workspace', git: false, addedAt: 1 }
const member = (key: string, more: Partial<Project> = {}): Project => ({ key, name: key.toLowerCase(), machine: 'home', path: `/h/work/${key.toLowerCase()}`, workspace: 'WS', addedAt: 1, ...more })
const list = [ws, member('PAY'), member('WEB'), member('API'), { key: 'OT', name: 'other', machine: 'home', path: '/h/other', addedAt: 1 } as Project, member('DOC', { git: false })]
const byKey = (k: string) => list.find(p => p.key === k)!

describe('the context setting', () => {
  it('parses --context: all, none, or member keys', () => {
    expect(parseContext('all')).toBe('all')
    expect(parseContext(' none ')).toEqual([])
    expect(parseContext('PAY, WEB,PAY')).toEqual(['PAY', 'WEB'])
    for (const bad of ['', 'pay', 'PAY;WEB', 'PAY,', 'all,PAY']) expect(parseContext(bad)).toMatchObject({ error: expect.stringContaining('all, none, or a list of member projects') })
    expect(readContext(undefined)).toBeUndefined()
    expect(readContext(['PAY'])).toEqual(['PAY'])
    expect(readContext(['pay'])).toMatchObject({ error: expect.any(String) })
    expect(readContext(3)).toMatchObject({ error: expect.any(String) })
  })

  it('a task type holds it in the workflow JSON, checked there; a task\'s own setting wins', () => {
    const t: Template = { id: 'x', taskTypes: { spec: { context: 'all', steps: [{ id: 'work', holder: 'worker', ends: 'report' }] } } }
    expect(validateTemplate(t)).toEqual([])
    expect(validateTemplate({ ...t, taskTypes: { spec: { ...t.taskTypes.spec!, context: ['PAY', 'WEB'] } } })).toEqual([])
    expect(validateTemplate({ ...t, taskTypes: { spec: { ...t.taskTypes.spec!, context: 'some' } } })).toEqual([{ path: 'taskTypes.spec.context', message: expect.stringContaining('all, none') }])
    expect(validateTemplate({ ...t, taskTypes: { spec: { ...t.taskTypes.spec!, context: '' } } })).toEqual([{ path: 'taskTypes.spec.context', message: expect.any(String) }])
    expect(validateTemplate({ ...t, taskTypes: { spec: { ...t.taskTypes.spec!, context: [1] } } })).toHaveLength(1)
    expect(taskContext(t, { type: 'spec' })).toBe('all')
    expect(taskContext(t, { type: 'spec', context: ['PAY'] })).toEqual(['PAY'])
    expect(taskContext(t, { type: 'spec', context: [] })).toEqual([])
    expect(taskContext(t, { type: 'other' })).toBeUndefined()
  })

  it('task add and task edit take --context; an empty one on edit gives the task type\'s back', () => {
    expect(parseCommand(['task', 'add', 'Spec', '--type', 'spec', '--context', 'PAY,WEB'])).toMatchObject({ name: 'task add', context: ['PAY', 'WEB'] })
    expect(parseCommand(['task', 'add', 'Spec', '--type', 'spec', '--context', 'all'])).toMatchObject({ context: 'all' })
    expect(parseCommand(['task', 'add', 'Spec', '--type', 'spec', '--context', 'none'])).toMatchObject({ context: [] })
    expect(parseCommand(['task', 'add', 'Spec', '--type', 'spec', '--context', 'pay'])).toEqual({ error: expect.stringMatching(/^--context is all, none, or a list/) })
    expect(parseCommand(['task', 'add', 'Spec', '--type', 'spec'])).not.toHaveProperty('context')
    expect(parseCommand(['task', 'edit', 'WEB-1', '--context', 'PAY', '--reason', 'Needs the API'])).toEqual({ name: 'task edit', task: 'WEB-1', context: ['PAY'], reason: 'Needs the API' })
    expect(parseCommand(['task', 'edit', 'WEB-1', '--context', '', '--reason', 'Back'])).toMatchObject({ context: null })
    expect(parseCommand(['task', 'edit', 'WEB-1', '--context', 'x1', '--reason', 'Back'])).toMatchObject({ error: expect.any(String) })
  })
})

describe('which members a setting names', () => {
  it('all is every other member of the task\'s workspace: never its own project, nor a folder without git', () => {
    const r = contextMembers('all', byKey('WEB'), list)
    expect(r.members.map(m => m.key)).toEqual(['PAY', 'API'])
    expect(r.skipped).toEqual([{ key: 'DOC', why: 'not a git repository' }])
  })

  it('a list names members, each skipped with its reason when it cannot be one', () => {
    const r = contextMembers(['PAY', 'OT', 'WEB', 'NOPE', 'PAY'], byKey('WEB'), list)
    expect(r.members.map(m => m.key)).toEqual(['PAY'])
    expect(r.skipped).toEqual([{ key: 'OT', why: 'not a member of WS' }, { key: 'WEB', why: 'the task\'s own project' }, { key: 'NOPE', why: 'not a member of WS' }])
  })

  it('outside a workspace nothing resolves, and the reason says so', () => {
    expect(contextMembers('all', byKey('OT'), list)).toEqual({ members: [], skipped: [{ key: 'all', why: 'the project is not in a workspace' }] })
    expect(contextMembers([], byKey('OT'), list)).toEqual({ members: [], skipped: [] })
  })

  it('a task may be given only members of its own workspace, stored by key', () => {
    expect(checkTaskContext('all', byKey('WEB'), list)).toEqual({ context: 'all' })
    expect(checkTaskContext(['PAY'], byKey('WEB'), list)).toEqual({ context: ['PAY'] })
    expect(checkTaskContext([], byKey('WEB'), list)).toEqual({ context: [] })
    expect(checkTaskContext('all', byKey('OT'), list)).toMatchObject({ error: expect.stringContaining('not in one') })
    expect(checkTaskContext('all', ws, list)).toMatchObject({ error: expect.stringContaining('not in one') })
    expect(checkTaskContext(['OT'], byKey('WEB'), list)).toEqual({ error: 'Context: OT: not a member of WS' })
    expect(checkTaskContext(['WEB'], byKey('WEB'), list)).toEqual({ error: 'Context: WEB: the task\'s own project' })
    const renamed = list.map(p => (p.key === 'PAY' ? { ...p, label: 'PY', aliases: ['PAYROLL'] } : p))
    expect(checkTaskContext(['PY'], byKey('WEB'), renamed)).toEqual({ context: ['PAY'] })
  })
})

describe('what the agent is told', () => {
  const folders: ContextFolder[] = [
    { member: 'PAY', repo: 'payroll-api', sha: '1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b', dir: '/h/.wherdr/pm/context/PAY/1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b' },
    { member: 'WEB', repo: 'web', sha: '5d6e7f85d6e7f85d6e7f85d6e7f85d6e7f85d6e7', dir: '/h/.wherdr/pm/context/WEB/5d6e7f85d6e7f85d6e7f85d6e7f85d6e7f85d6e7' },
  ]

  it('the instructions list each folder: member, repository, commit, path; with the rule', () => {
    const text = contextSection(folders).join('\n')
    expect(text).toContain('## Context (read only)')
    expect(text).toContain('Read only; cite path:line from these folders.')
    expect(text).toContain('- PAY: payroll-api @ 1a2b3c4, in /h/.wherdr/pm/context/PAY/1a2b3c4d5e6f1a2b3c4d5e6f1a2b3c4d5e6f1a2b')
    expect(text).toContain('- WEB: web @ 5d6e7f8, in /h/.wherdr/pm/context/WEB/5d6e7f85d6e7f85d6e7f85d6e7f85d6e7f85d6e7')
    expect(contextSection([])).toEqual([])
  })

  it('a branch not fetched, or a clone with no origin, is said in the section and the log line', () => {
    const odd: ContextFolder[] = [{ ...folders[0]!, how: 'not-fetched' }, { ...folders[1]!, how: 'local' }]
    expect(contextSection(odd).join('\n')).toContain('- PAY: payroll-api @ 1a2b3c4 (not fetched), in /h/')
    expect(contextSection(odd).join('\n')).toContain('- WEB: web @ 5d6e7f8 (local branch), in /h/')
    expect(contextLine(odd, [])).toBe('context: PAY @ 1a2b3c4 (not fetched), WEB @ 5d6e7f8 (local branch)')
  })

  it('the task log has one line: what it got, what it skipped and why', () => {
    expect(contextLine(folders, [{ key: 'API', why: 'no clone on laptop' }])).toBe('context: PAY @ 1a2b3c4, WEB @ 5d6e7f8 (skipped API: no clone on laptop)')
    expect(contextLine(folders, [])).toBe('context: PAY @ 1a2b3c4, WEB @ 5d6e7f8')
    expect(contextLine([{ ...folders[0]!, changed: true }], [])).toBe('context: PAY @ 1a2b3c4 (it had been changed: built again)')
    expect(contextLine([], [{ key: 'API', why: 'no branch main' }, { key: 'DOC', why: 'not a git repository' }])).toBe('context: none (skipped API: no branch main; DOC: not a git repository)')
  })

  it('Claude and omp get --add-dir per folder, before the options that take a value; Codex gets none (its sandbox reads everywhere)', () => {
    const dirs = ['/c/PAY/a b', '/c/WEB/c\'d']
    expect(agentLine('claude', 'opus', '/h/i.md', { id: 's1' }, undefined, dirs))
      .toBe(`exec claude '--add-dir' '/c/PAY/a b' '--add-dir' '/c/WEB/c'\\''d' '--model' 'opus' '--session-id' 's1' 'Read /h/i.md and follow it.'`)
    expect(agentLine('claude', 'opus', '/h/i.md', { id: 's1', resume: 'Go on.' }, undefined, ['/c/PAY/x'])).toBe(`exec claude '--add-dir' '/c/PAY/x' '--model' 'opus' '--resume' 's1' 'Go on.'`)
    expect(agentLine('codex', 'gpt-5', '/h/i.md', undefined, undefined, dirs)).toBe(agentLine('codex', 'gpt-5', '/h/i.md'))
    expect(agentLine('omp', 'sonnet', '/h/i.md', undefined, undefined, ['/c/PAY/x'])).toBe(`exec omp '--add-dir' '/c/PAY/x' '--model' 'sonnet' 'Read /h/i.md and follow it.'`)
    expect(agentLine('claude', 'opus', '/h/i.md', { id: 's1' }, undefined, [])).toBe(agentLine('claude', 'opus', '/h/i.md', { id: 's1' }))
    expect(dirArgs('other', dirs)).toEqual([])
  })

  it('the snapshot script gets the clone, the member\'s folder, the base and a pinned commit', () => {
    expect(contextRoot('/h', '.wherdr/pm', 'PAY')).toBe('/h/.wherdr/pm/context/PAY')
    expect(contextBase('/h', '.wherdr/pm')).toBe('/h/.wherdr/pm/context')
    expect(contextArgs('/h/work/pay', contextRoot('/h', '.wherdr/pm', 'PAY'), 'develop')).toEqual(['/h/work/pay', '/h/.wherdr/pm/context/PAY', 'develop', ''])
    expect(contextArgs('/h/work/pay', '/r', '', 'abc')).toEqual(['/h/work/pay', '/r', '', 'abc'])
  })
})

describe('which snapshots may go', () => {
  const root = '/h/.wherdr/pm/context'
  const dir = (k: string, s: string) => `${root}/${k}/${s}`
  const folder = (k: string, s: string): ContextFolder => ({ member: k, repo: k.toLowerCase(), sha: s, dir: dir(k, s) })
  const task = (id: string, more: Partial<Task> = {}): Task => ({ id, project: 'WEB', title: id, description: '', type: 'task', state: 'working', createdAt: 1, ...more })
  const run = (id: string, t: string, role: Run['role'], startedAt: number, context: ContextFolder[], machine = 'home'): Run => ({ id, task: t, role, program: 'claude', model: 'm', machine, worktree: '/w', branch: 'b', instructions: '', attempt: 1, state: 'ended', startedAt, context })

  it('keeps what an unfinished task\'s latest worker or reviewer reads on that machine; the rest is stale', () => {
    const found = [dir('PAY', 'aaa'), dir('PAY', 'bbb'), dir('WEB', 'ccc'), dir('API', 'ddd'), dir('API', 'eee'), '/elsewhere/PAY/fff', `${root}/../x/y`]
    const tasks = [task('WEB-1'), task('WEB-2', { step: { at: 2, started: true, since: 1, done: true, proofs: {}, rounds: {} } }), task('WEB-3')]
    const runs = [
      run('r1', 'WEB-1', 'worker', 1, [folder('PAY', 'aaa')]),
      run('r2', 'WEB-1', 'worker', 5, [folder('PAY', 'bbb')]), // its latest worker: the old one's no longer counts
      run('r3', 'WEB-1', 'reviewer', 6, [folder('WEB', 'ccc')]),
      run('r4', 'WEB-2', 'worker', 1, [folder('API', 'ddd')]), // done task
      run('r5', 'WEB-3', 'worker', 1, [folder('API', 'eee')], 'big'), // another machine
      run('r6', 'WEB-9', 'worker', 1, [folder('API', 'ddd')]), // task gone
    ]
    expect(staleSnapshots(found, root, 'home', tasks, runs)).toEqual([dir('PAY', 'aaa'), dir('API', 'ddd'), dir('API', 'eee')])
    expect(staleSnapshots(found, root, 'big', tasks, runs)).toEqual([dir('PAY', 'aaa'), dir('PAY', 'bbb'), dir('WEB', 'ccc'), dir('API', 'ddd')])
  })

  it('with no unfinished task, every snapshot found is stale', () => {
    expect(staleSnapshots([dir('PAY', 'aaa')], root, 'home', [], [])).toEqual([dir('PAY', 'aaa')])
  })
})

// The real scripts, in made-up repositories.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-context-'))
const home = path.join(tmp, 'home')
const env = { PATH: process.env.PATH!, HOME: home, GIT_CEILING_DIRECTORIES: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd: string, ...a: string[]) => { const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout.trim() }
const sh = (script: string, ...args: string[]) => { const r = spawnSync('sh', ['-c', script, 'sh', ...args], { env, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim() } }
const commit = (dir: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', '-A'); git(dir, 'commit', '-q', '-m', text); return git(dir, 'rev-parse', 'HEAD') }
// What the sweep's list script prints, sorted.
const listed = (base: string) => sh(CONTEXT_LIST_SCRIPT, base).out.split('\n').filter(Boolean).sort()
const isReadOnly = (f: string) => (fs.statSync(f).mode & 0o222) === 0
const SHA = /^[0-9a-f]{40}$/

// A member repository: a clone at `dest` of a bare origin; ahead() adds a commit only origin has, from a second clone.
let repos = 0
function member2(dest: string) {
  const id = ++repos, bare = path.join(tmp, 'origin', `${id}.git`), other = path.join(tmp, 'other', String(id))
  fs.mkdirSync(path.dirname(bare), { recursive: true }); fs.mkdirSync(path.dirname(dest), { recursive: true })
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare)
  git(tmp, 'clone', '-q', bare, dest)
  git(dest, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  const first = commit(dest, 'src/a.txt', 'one')
  git(dest, 'push', '-q', 'origin', 'main')
  return { clone: dest, first, ahead: () => { git(tmp, 'clone', '-q', bare, other); commit(other, 'src/b.txt', 'two'); git(other, 'push', '-q', 'origin', 'main'); return git(other, 'rev-parse', 'HEAD') } }
}
beforeAll(() => { fs.mkdirSync(home, { recursive: true }) })
// Snapshots are read-only: writable again, or the folder cannot be removed.
afterAll(() => { spawnSync('chmod', ['-R', 'u+w', tmp]); fs.rmSync(tmp, { recursive: true, force: true }) })

describe('CONTEXT_SCRIPT', () => {
  it('fetches origin\'s base branch, snapshots that commit read-only under <root>/<sha> and reuses it', () => {
    const m = member2(path.join(tmp, 'clones', 'pay')), root = path.join(tmp, 'ctx', 'PAY')
    const ahead = m.ahead()
    expect(ahead).not.toBe(m.first)
    const r = sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main'))
    expect(r).toEqual({ code: 0, out: `${ahead} fetched` })
    const dir = path.join(root, ahead)
    expect(fs.readFileSync(path.join(dir, 'src/b.txt'), 'utf8')).toBe('two')
    expect(isReadOnly(path.join(dir, 'src/b.txt'))).toBe(true)
    expect(isReadOnly(path.join(dir, 'src'))).toBe(true)
    expect(git(m.clone, 'worktree', 'list').split('\n')).toHaveLength(2)
    // The same commit again: the same folder, no second worktree.
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main'))).toEqual({ code: 0, out: `${ahead} fetched` })
    expect(git(m.clone, 'worktree', 'list').split('\n')).toHaveLength(2)
    // The clone's own branch is not touched: it stays on its commit, and a snapshot is detached.
    expect(git(m.clone, 'rev-parse', 'main')).toBe(m.first)
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD')
    // A pinned commit stays, however far the branch moved; one that is gone is said, never replaced by the branch's.
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main', m.first))).toEqual({ code: 0, out: `${m.first} pinned` })
    expect(fs.existsSync(path.join(root, m.first, 'src/a.txt'))).toBe(true)
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main', 'f'.repeat(40)))).toEqual({ code: 5, out: 'commit fffffff pinned at the task\'s first start is gone' })
    // A snapshot changed in place (made writable, edited) is not reused as is: built again, read-only, and said.
    const file = path.join(dir, 'src/b.txt')
    fs.chmodSync(path.dirname(file), 0o755); fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'tampered')
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main', ahead))).toEqual({ code: 0, out: `${ahead} pinned changed` })
    expect(fs.readFileSync(file, 'utf8')).toBe('two')
    expect(isReadOnly(file)).toBe(true)
    // Only writable again, unchanged: built again all the same (nothing writable is reused).
    fs.chmodSync(file, 0o644)
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main', ahead)).out).toBe(`${ahead} pinned changed`)
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main', ahead)).out).toBe(`${ahead} pinned`)
  })

  it('a tracked symlink (always lrwxrwxrwx) does not make the snapshot look changed: reused, not rebuilt', () => {
    const local = path.join(tmp, 'linked'), root = path.join(tmp, 'ctx', 'LNK')
    fs.mkdirSync(local); git(local, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(local, 'AGENTS.md'), 'rules'); fs.symlinkSync('AGENTS.md', path.join(local, 'CLAUDE.md'))
    git(local, 'add', '-A'); git(local, 'commit', '-q', '-m', 'linked')
    const sha = git(local, 'rev-parse', 'HEAD')
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(local, root, 'main'))).toEqual({ code: 0, out: `${sha} local` })
    // A rebuild would say `changed`.
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(local, root, 'main'))).toEqual({ code: 0, out: `${sha} local` })
  })

  it('a clone without an origin gives its local branch; the default branch when no base is named', () => {
    const local = path.join(tmp, 'local'), root = path.join(tmp, 'ctx', 'LOC')
    fs.mkdirSync(local); git(local, 'init', '-q', '-b', 'develop')
    const sha = commit(local, 'x.txt', 'x')
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(local, root, 'develop'))).toEqual({ code: 0, out: `${sha} local` })
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(local, root, ''))).toEqual({ code: 0, out: `${sha} local` })
    const m = member2(path.join(tmp, 'clones', 'web')), webRoot = path.join(tmp, 'ctx', 'WEB')
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, webRoot, ''))).toEqual({ code: 0, out: `${m.first} fetched` })
  })

  it('says why it cannot: no such branch (exit 4), not a repository (exit 3)', () => {
    const m = member2(path.join(tmp, 'clones', 'api')), root = path.join(tmp, 'ctx', 'API')
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'nope'))).toEqual({ code: 4, out: 'no branch nope' })
    const empty = path.join(tmp, 'empty'); fs.mkdirSync(empty)
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(empty, root, 'main'))).toMatchObject({ code: 3, out: expect.stringContaining('no git repository') })
    expect(fs.existsSync(root)).toBe(false)
  })

  it('the sweep scripts list snapshots older than an hour and remove one through its clone, its folder writable again', () => {
    const m = member2(path.join(tmp, 'clones', 'doc')), base = path.join(tmp, 'ctx2'), root = path.join(base, 'DOC')
    const sha = sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main')).out.split(' ')[0]!
    expect(sha).toMatch(SHA)
    const dir = path.join(root, sha)
    // Just made: not listed (it may not be on its run's record yet).
    expect(sh(CONTEXT_LIST_SCRIPT, base)).toEqual({ code: 0, out: '' })
    const old = new Date(Date.now() - 2 * 3600_000)
    fs.utimesSync(dir, old, old); fs.utimesSync(`${dir}.ok`, old, old)
    expect(listed(base)).toEqual([dir, `${dir}.ok`])
    expect(sh(CONTEXT_LIST_SCRIPT, path.join(tmp, 'none'))).toEqual({ code: 0, out: '' })
    expect(sh(CONTEXT_REMOVE_SCRIPT, dir, base)).toEqual({ code: 0, out: '' })
    expect(fs.existsSync(dir)).toBe(false)
    expect(fs.existsSync(`${dir}.ok`)).toBe(false)
    expect(fs.existsSync(root)).toBe(false)
    expect(git(m.clone, 'worktree', 'list').split('\n')).toHaveLength(1)
    // Never anything outside the context folder, nor a way out of it.
    fs.mkdirSync(path.join(tmp, 'keep', 'y'), { recursive: true })
    expect(sh(CONTEXT_REMOVE_SCRIPT, path.join(tmp, 'keep', 'y'), base).code).toBe(3)
    expect(sh(CONTEXT_REMOVE_SCRIPT, `${base}/X/../../keep/y`, base).code).toBe(3)
    expect(fs.existsSync(path.join(tmp, 'keep', 'y'))).toBe(true)
  })

  it('a folder without its marker (a creator that died) is rebuilt, never reused', () => {
    const m = member2(path.join(tmp, 'clones', 'partial')), root = path.join(tmp, 'ctx3', 'PAR')
    const sha = sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main')).out.split(' ')[0]!
    const dir = path.join(root, sha)
    // Half made: the checkout lost a file and the marker is not there; a stray file is in it.
    spawnSync('chmod', ['-R', 'u+w', dir])
    fs.rmSync(`${dir}.ok`); fs.rmSync(path.join(dir, 'src/a.txt')); fs.writeFileSync(path.join(dir, 'stray.txt'), 'x')
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main'))).toEqual({ code: 0, out: `${sha} fetched` })
    expect(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8')).toBe('one')
    expect(fs.existsSync(path.join(dir, 'stray.txt'))).toBe(false)
    expect(fs.existsSync(`${dir}.ok`)).toBe(true)
    expect(isReadOnly(path.join(dir, 'src/a.txt'))).toBe(true)
    expect(git(m.clone, 'worktree', 'list').split('\n')).toHaveLength(2)
    // A folder git does not know at all (its clone's record gone): rebuilt as well.
    spawnSync('chmod', ['-R', 'u+w', dir]); fs.rmSync(`${dir}.ok`)
    fs.rmSync(path.join(m.clone, '.git/worktrees'), { recursive: true })
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main')).code).toBe(0)
    expect(fs.existsSync(`${dir}.ok`) && fs.existsSync(path.join(dir, 'src/a.txt'))).toBe(true)
    expect(fs.existsSync(`${dir}.lock`)).toBe(false)
  })

  it('parallel runs on the same commit end with one complete read-only snapshot and no lock', async () => {
    const m = member2(path.join(tmp, 'clones', 'parallel')), root = path.join(tmp, 'ctx3', 'PARALLEL')
    const run = () => new Promise<{ code: number | null, out: string }>((resolve) => {
      const c = spawn('sh', ['-c', CONTEXT_SCRIPT, 'sh', ...contextArgs(m.clone, root, 'main')], { env })
      let out = ''; c.stdout.on('data', d => (out += d)); c.on('close', code => resolve({ code, out: out.trim() }))
    })
    const results = await Promise.all([run(), run(), run(), run()])
    expect(results).toEqual(Array(4).fill({ code: 0, out: `${m.first} fetched` }))
    const dir = path.join(root, m.first)
    expect(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8')).toBe('one')
    expect(isReadOnly(path.join(dir, 'src/a.txt'))).toBe(true)
    expect(fs.existsSync(`${dir}.ok`)).toBe(true)
    expect(fs.readdirSync(root).sort()).toEqual([m.first, `${m.first}.ok`])
    expect(git(m.clone, 'worktree', 'list').split('\n')).toHaveLength(2)
  })

  it('a stale lock is broken; a creator that fails leaves nothing behind', () => {
    const m = member2(path.join(tmp, 'clones', 'locks')), root = path.join(tmp, 'ctx3', 'LOCKS')
    fs.mkdirSync(root, { recursive: true })
    // A lock older than 5 minutes belongs to a creator that died.
    const lock = path.join(root, `${m.first}.lock`)
    fs.mkdirSync(lock); const old = new Date(Date.now() - 10 * 60_000); fs.utimesSync(lock, old, old)
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main'))).toEqual({ code: 0, out: `${m.first} fetched` })
    expect(fs.existsSync(lock)).toBe(false)
    // A git that fails midway, with a half checkout on disk: no folder, no marker, the lock released.
    const fake = path.join(tmp, 'fakegit'), real = spawnSync('sh', ['-c', 'command -v git'], { env, encoding: 'utf8' }).stdout.trim()
    fs.mkdirSync(fake, { recursive: true })
    fs.writeFileSync(path.join(fake, 'git'), `#!/bin/sh\ncase "$*" in *"worktree add"*) for a; do d=$p; p=$a; done; mkdir -p "$d/src"; echo half > "$d/src/x"; chmod -R a-w "$d"; exit 1;; esac\nexec ${real} "$@"\n`, { mode: 0o755 })
    const bad = path.join(tmp, 'ctx3', 'BAD')
    const r = spawnSync('sh', ['-c', CONTEXT_SCRIPT, 'sh', ...contextArgs(m.clone, bad, 'main')], { env: { ...env, PATH: `${fake}:${env.PATH}` }, encoding: 'utf8' })
    expect(r.status).toBe(1)
    expect(fs.readdirSync(bad)).toEqual([])
  })

  it('every use touches the snapshot: one used within the hour is not listed as stale', () => {
    const m = member2(path.join(tmp, 'clones', 'touch')), base = path.join(tmp, 'ctx4'), root = path.join(base, 'TOUCH')
    const sha = sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main')).out.split(' ')[0]!
    const dir = path.join(root, sha), old = new Date(Date.now() - 3 * 3600_000)
    fs.utimesSync(dir, old, old); fs.utimesSync(`${dir}.ok`, old, old)
    expect(listed(base)).toEqual([dir, `${dir}.ok`])
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main')).code).toBe(0)
    expect(listed(base)).toEqual([])
    expect(Date.now() - fs.statSync(dir).mtimeMs).toBeLessThan(60_000)
    expect(Date.now() - fs.statSync(`${dir}.ok`).mtimeMs).toBeLessThan(60_000)
  })

  it('removes a snapshot whose clone is gone, an incomplete folder, a leftover lock and an orphan marker; the clone is pruned when it exists', () => {
    const m = member2(path.join(tmp, 'clones', 'gone')), base = path.join(tmp, 'ctx5'), root = path.join(base, 'GONE')
    const sha = sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main')).out.split(' ')[0]!
    const dir = path.join(root, sha), old = new Date(Date.now() - 2 * 3600_000), age = (...ps: string[]) => ps.forEach(p => fs.utimesSync(p, old, old))
    fs.rmSync(m.clone, { recursive: true, force: true })
    // Used within the hour (since it was listed), or locked by a start: it stays.
    expect(sh(CONTEXT_REMOVE_SCRIPT, dir, base)).toEqual({ code: 0, out: '' })
    expect(fs.existsSync(dir)).toBe(true)
    age(dir)
    fs.mkdirSync(`${dir}.lock`)
    expect(sh(CONTEXT_REMOVE_SCRIPT, dir, base).code).toBe(0)
    expect(fs.existsSync(dir)).toBe(true)
    fs.rmdirSync(`${dir}.lock`)
    expect(sh(CONTEXT_REMOVE_SCRIPT, dir, base)).toEqual({ code: 0, out: '' })
    expect(fs.existsSync(dir) || fs.existsSync(`${dir}.ok`)).toBe(false)
    // Incomplete: a folder with no .git, a lock, a marker without its folder.
    const other = path.join(base, 'OTHER')
    fs.mkdirSync(path.join(other, 'abc', 'src'), { recursive: true }); fs.writeFileSync(path.join(other, 'abc', 'src', 'f'), 'x'); fs.chmodSync(path.join(other, 'abc', 'src'), 0o500)
    fs.mkdirSync(path.join(other, 'abc.lock')); fs.writeFileSync(path.join(other, 'lost.ok'), '')
    age(path.join(other, 'abc'), path.join(other, 'abc.lock'))
    expect(sh(CONTEXT_REMOVE_SCRIPT, path.join(other, 'abc'), base).code).toBe(0)
    expect(sh(CONTEXT_REMOVE_SCRIPT, path.join(other, 'abc.lock'), base).code).toBe(0)
    expect(sh(CONTEXT_REMOVE_SCRIPT, path.join(other, 'lost.ok'), base).code).toBe(0)
    expect(fs.existsSync(other)).toBe(false)
    // A marker whose folder is still there stays.
    const m2 = member2(path.join(tmp, 'clones', 'gone2')), root2 = path.join(base, 'KEEP')
    const sha2 = sh(CONTEXT_SCRIPT, ...contextArgs(m2.clone, root2, 'main')).out.split(' ')[0]!
    expect(sh(CONTEXT_REMOVE_SCRIPT, path.join(root2, `${sha2}.ok`), base).code).toBe(0)
    expect(fs.existsSync(path.join(root2, `${sha2}.ok`))).toBe(true)
    age(path.join(root2, sha2))
    expect(sh(CONTEXT_REMOVE_SCRIPT, path.join(root2, sha2), base).code).toBe(0)
    expect(git(m2.clone, 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('a fetch that fails is said (not-fetched) and the clone\'s own copy of the branch is used; a branch name that is an option is refused', () => {
    const m = member2(path.join(tmp, 'clones', 'offline')), root = path.join(tmp, 'ctx6', 'OFF')
    git(m.clone, 'remote', 'set-url', 'origin', path.join(tmp, 'no-such-origin.git'))
    expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, 'main'))).toEqual({ code: 0, out: `${m.first} not-fetched` })
    for (const bad of ['--upload-pack=touch pwned', '-x', '@{-1}']) expect(sh(CONTEXT_SCRIPT, ...contextArgs(m.clone, root, bad))).toEqual({ code: 4, out: `no branch ${bad}` })
    expect(fs.existsSync('pwned')).toBe(false)
  })
})

describe('a task\'s start and the sweep', () => {
  // A fake herdr-core: the context scripts run here for real, the rest is answered.
  async function started(over: Partial<Template['taskTypes'][string]> = {}, taskInput: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(tmp, 'store-'))
    const store = createPmStore(dir)
    await store.setEnabled(true)
    const template: Template = { id: 'vibe', prefs: { agent: 'claude', model: 'opus' }, taskTypes: { spec: { ...over, steps: [{ id: 'todo' }, { id: 'work', holder: 'worker', ends: 'report' }] } } }
    await store.saveTemplate(template)
    const okFolder = async (_m: string, p: string) => p.replace(/^~/, home)
    await store.addProject({ key: 'WS', name: 'Work', machine: '', path: '~/work', kind: 'workspace' }, okFolder)
    for (const k of ['pay', 'web', 'api']) await store.addProject({ key: k.toUpperCase(), machine: '', path: `~/work/${k}`, workspace: 'WS' }, okFolder)
    await store.updateProject('API', { base: 'nope' })
    await store.setTemplate('WEB', 'vibe')
    await store.addTask({ project: 'WEB', title: 'Spec the export', type: 'spec', ...taskInput })
    const runs: Record<string, unknown>[] = [], files: Record<string, string> = {}
    const call = async (method: string, p: Record<string, unknown>) => {
      if (method === 'machine.exec') {
        const [, , script, , ...args] = p.argv as string[]
        const b64 = (s: string) => Buffer.from(s).toString('base64')
        if ([CONTEXT_SCRIPT, CONTEXT_LIST_SCRIPT, CONTEXT_REMOVE_SCRIPT].includes(script!)) { const r = sh(script!, ...args); return { code: r.code, stdout: b64(r.out) } }
        if (script!.includes('command -v')) return { code: 0, stdout: b64('claude') }
        if (script!.includes('printf %s "$HOME"')) return { code: 0, stdout: b64(home) }
        if (script!.includes('df -Pk /tmp')) return { code: 0, stdout: b64('9000000') }
        if (p.input) files[args[0]!] = Buffer.from(p.input as string, 'base64').toString()
        return { code: 0, stdout: '' }
      }
      if (method === 'terminal.run') { runs.push(p); return { address: `t${runs.length}` } }
      if (method === 'terminal.get') return { state: 'running' }
      throw new Error(`unexpected ${method}`)
    }
    const deps = { call, store, machines: () => [{ key: '', label: 'laptop', local: true, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    return { store, deps, runs, files }
  }

  it('a task type\'s context: snapshots of the other members, the section, the log line, --add-dir; a member that cannot is skipped and said', async () => {
    for (const k of ['pay', 'web', 'api']) member2(path.join(home, 'work', k))
    const sha = git(path.join(home, 'work', 'pay'), 'rev-parse', 'HEAD')
    const { store, deps, runs, files } = await started({ context: 'all' })
    await startTask(deps, 'WEB-1')
    const dir = path.join(home, '.wherdr/pm/context/PAY', sha)
    expect(fs.existsSync(path.join(dir, 'src/a.txt'))).toBe(true)
    expect(runs[0]!.line).toContain(`exec claude '--add-dir' '${dir}' '--model' 'opus'`)
    expect(runs[0]!.line).not.toContain('context/API')
    const text = files[path.join(home, '.wherdr/pm/tasks/WEB-1/instructions.md')]!
    expect(text).toContain('## Context (read only)')
    expect(text).toContain(`- PAY: pay @ ${sha.slice(0, 7)}, in ${dir}`)
    expect(text).not.toContain('- WEB:')
    const task = (await store.task('WEB-1'))!
    expect(task.log!.map(e => e.text)).toContain(`context: PAY @ ${sha.slice(0, 7)} (skipped API: no branch nope)`)
    expect((await store.runs())[0]!.context).toEqual([{ member: 'PAY', repo: 'pay', sha, dir }])

    // The sweep: its snapshot is read by an unfinished task, however old.
    const old = new Date(Date.now() - 3 * 3600_000)
    fs.utimesSync(dir, old, old)
    await sweepWorktrees(deps)
    expect(fs.existsSync(dir)).toBe(true)
    // Done: nothing reads it, and it goes.
    await store.saveTask({ ...task, step: { ...task.step!, done: true } })
    await sweepWorktrees(deps)
    expect(fs.existsSync(dir)).toBe(false)
    expect(git(path.join(home, 'work', 'pay'), 'worktree', 'list').split('\n')).toHaveLength(1)
  })

  it('a task\'s own context wins over its type\'s; none turns it off; a task refused outside a workspace or for a non-member', async () => {
    const { store, deps, runs } = await started({ context: 'all' }, { context: 'none' })
    expect((await store.task('WEB-1'))!.context).toEqual([])
    await startTask(deps, 'WEB-1')
    expect(runs[0]!.line).not.toContain('--add-dir')
    expect(((await store.task('WEB-1'))!.log ?? []).some(e => e.text.startsWith('context:'))).toBe(false)
    await expect(store.addTask({ project: 'WEB', title: 'x', type: 'spec', context: 'PAY,NOPE' })).rejects.toThrow('Context: NOPE: not a member of WS')
    await expect(store.addTask({ project: 'WEB', title: 'x', type: 'spec', context: 'WEB' })).rejects.toThrow('the task\'s own project')
    await expect(store.addTask({ project: 'WEB', title: 'x', type: 'spec', context: 'bad one' })).rejects.toThrow('context is all, none')
    expect((await store.addTask({ project: 'WEB', title: 'x', type: 'spec', context: 'PAY,API' })).context).toEqual(['PAY', 'API'])
    await store.addProject({ key: 'OT', machine: '', path: path.join(home, 'work', 'ot') }, async (_m, p) => p)
    await expect(store.addTask({ project: 'OT', title: 'x', type: 'spec', context: 'all' })).rejects.toThrow('not in one')
  })
})

describe('a reviewer\'s start', () => {
  it('gets the commits its worker read in its --add-dir and its review file, though the base moved on; a running reviewer keeps its folders for the next round', async () => {
    const { advanceTick } = await import('../server/utils/pmAdvance')
    const { actionsSettled } = await import('../server/utils/pmBoard')
    const { github } = await import('../shared/pm/examples')
    const { initialState, onEvent, planSteps } = await import('../shared/pm/steps')
    const { READ_SEP } = await import('../shared/pm/advance')
    const tick = async (d: Parameters<typeof advanceTick>[0]) => { await advanceTick(d); await actionsSettled() }
    const pay = member2(path.join(home, 'work', 'pay3')); member2(path.join(home, 'work', 'rv'))
    const sha = pay.first, snap = path.join(home, '.wherdr/pm/context/PAY', sha)
    const moved = pay.ahead()
    const dir = fs.mkdtempSync(path.join(tmp, 'store-'))
    const store = createPmStore(dir)
    await store.setEnabled(true)
    const template: Template = { ...github, taskTypes: { ...github.taskTypes, simple: { ...github.taskTypes.simple!, context: ['PAY'] } } }
    await store.saveTemplate(template)
    const okFolder = async (_m: string, p: string) => p.replace(/^~/, home)
    await store.addProject({ key: 'WS', name: 'Work', machine: '', path: '~/work', kind: 'workspace' }, okFolder)
    await store.addProject({ key: 'PAY', machine: '', path: '~/work/pay3', workspace: 'WS' }, okFolder)
    await store.addProject({ key: 'RV', machine: '', path: '~/work/rv', workspace: 'WS' }, okFolder)
    await store.setTemplate('RV', 'github')
    await store.saveWorkflow('RV', template)
    const t = await store.addTask({ project: 'RV', title: 'Fix', type: 'simple' })
    const first = onEvent(planSteps(template, { type: 'simple' }), initialState(), { kind: 'start' }, 1).state
    const instructions = `${home}/.wherdr/pm/tasks/${t.id}/instructions.md`
    await store.saveRun({ id: 'r1', task: t.id, role: 'worker', program: 'claude', model: 'sonnet', machine: '', worktree: '/w', branch: `task/${t.id}`, instructions, terminal: 'h/t1', attempt: 1, state: 'running', startedAt: 1, context: [{ member: 'PAY', repo: 'pay3', sha, dir: snap }] })
    await store.saveTask({ ...t, state: 'working', run: 'r1', step: { ...first, told: first.since } })
    const terms: Record<string, Record<string, string>> = { 'h/t1': { 'wherdr.report': 'done' } }
    const calls: [string, Record<string, unknown>][] = [], files: Record<string, string> = {}
    let verdict = ''
    const call = async (method: string, p: Record<string, unknown>) => {
      calls.push([method, p])
      if (method === 'terminal.list') return { terminals: Object.entries(terms).map(([address, labels]) => ({ address, labels })) }
      if (method === 'terminal.label') Object.assign(terms[p.terminal as string]!, p.labels)
      if (method === 'terminal.run') { terms['h/t2'] = {}; return { address: 'h/t2' } }
      if (method === 'terminal.get') return { state: 'running' }
      if (method !== 'machine.exec') return {}
      const [, , script, , ...args] = p.argv as string[]
      if (script === CONTEXT_SCRIPT) { const r = sh(script, ...args); return { code: r.code, stdout: Buffer.from(r.out).toString('base64') } }
      if (p.input) files[args.at(-1)!.endsWith('.md') ? args.at(-2)! : args[0]!] = Buffer.from(p.input as string, 'base64').toString()
      const out = script!.includes(READ_SEP) ? ['abc1234', '5', '', verdict, `task/${t.id}`].join(`\n${READ_SEP}\n`)
        : script!.includes('gh pr create') ? 'https://github.com/o/r/pull/9'
          : script!.includes('command -v') ? 'claude' : script!.includes('$HOME') ? home : ''
      return { code: script!.includes('--contains') ? 1 : 0, stdout: Buffer.from(out).toString('base64') }
    }
    const deps = { store, call, machines: () => [{ key: '', local: true, label: 'host' }], launchWatchMs: 0 } as unknown as Parameters<typeof advanceTick>[0]
    await tick(deps)
    await tick(deps)
    const started = calls.find(([m]) => m === 'terminal.run')![1]
    expect(started.line).toContain(`exec claude '--add-dir' '${snap}' '--model' 'opus' 'Read ${home}/.wherdr/pm/tasks/${t.id}/review.md and follow it.'`)
    expect(fs.existsSync(path.join(snap, 'src/a.txt'))).toBe(true)
    const review = Object.entries(files).find(([f]) => f.endsWith('review.md'))?.[1]
    expect(review).toContain('## Context (read only)')
    expect(review).toContain(`- PAY: pay3 @ ${sha.slice(0, 7)}, in ${snap}`)
    expect((await store.task(t.id))!.log!.map(l => l.text)).toContain(`context: PAY @ ${sha.slice(0, 7)}`)
    expect((await store.runs()).find(r => r.role === 'reviewer')!.context).toEqual([{ member: 'PAY', repo: 'pay3', sha, dir: snap }])
    // A finding sends the task back, the review again: the running reviewer keeps its folders.
    verdict = '{"findings":[{"id":"a","severity":"major","title":"A","proof":"p"}]}'
    terms['h/t2']!['wherdr.report'] = 'done'
    await tick(deps)
    await tick(deps)
    terms['h/t1']!['wherdr.report'] = 'done'
    await tick(deps)
    await tick(deps)
    expect(calls.filter(([m, p]) => m === 'terminal.send' && p.terminal === 'h/t2').at(-1)![1].text).toBe(`Review again: read ${home}/.wherdr/pm/tasks/${t.id}/review.md and follow it.`)
    const again = Object.entries(files).find(([f]) => f.endsWith('review.md'))?.[1]
    expect(again).toContain(`- PAY: pay3 @ ${sha.slice(0, 7)}, in ${snap}`)
    expect(again).not.toContain(moved.slice(0, 7))
    expect(calls.filter(([m]) => m === 'terminal.run')).toHaveLength(1)
  })
})
