import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { RETRY_MS, SCRIPT, commandState, endsMerged, guardAction, isTransient, leaks, prReady, runsState, taskGuards, type Receipt } from '../shared/pm/actions'
import { dropMergedBranch, runAction, watch, type ActionDeps, type ActionJob } from '../server/utils/pmActions'
import { WORKTREE_SCRIPT } from '../server/utils/pmLaunch'
import { initialState, onEvent, planSteps, reviewedCommit } from '../shared/pm/steps'
import { dueText } from '../shared/pm/advance'
import { github, vibe } from '../shared/pm/examples'
import type { Step, Template } from '../shared/pm/workflow'

const t: Template = {
  id: 'p', guards: { protected: ['main'], merge: { protected: 'user', others: 'engine' } },
  taskTypes: { simple: { steps: [] }, careful: { guards: { protected: ['dev'], merge: { others: 'user' } }, steps: [] } },
}
const g = taskGuards(t, 'simple')

describe('guards', () => {
  it('lets the engine land or merge only where the guard says engine; the user always may', () => {
    expect(guardAction(g, { kind: 'git.land', target: 'main' }, { branch: 'task/A-1', by: 'engine' })).toBe('main is protected: only you may merge into it')
    expect(guardAction(g, { kind: 'git.land', target: 'main' }, { branch: 'task/A-1', by: 'user' })).toBeUndefined()
    expect(guardAction(g, { kind: 'git.land', target: 'dev' }, { branch: 'task/A-1', by: 'engine' })).toBeUndefined()
    expect(guardAction(g, { kind: 'github.merge' }, { branch: 'task/A-1', by: 'engine', base: 'main' })).toMatch(/only you/)
    expect(guardAction(g, { kind: 'github.merge' }, { branch: 'task/A-1', by: 'engine', base: 'dev' })).toBeUndefined()
  })

  it('never pushes to a protected branch, and a task type can only harden', () => {
    expect(guardAction(g, { kind: 'git.push' }, { branch: 'main', by: 'user' })).toMatch(/never pushes/)
    expect(guardAction(g, { kind: 'github.pr', base: 'dev' }, { branch: 'main', by: 'engine' })).toMatch(/never pushes/)
    const strict = taskGuards(t, 'careful')
    expect(guardAction(strict, { kind: 'git.land', target: 'dev' }, { branch: 'b', by: 'engine' })).toMatch(/only you/)
    expect(guardAction(strict, { kind: 'git.land', target: 'other' }, { branch: 'b', by: 'engine' })).toMatch(/only you/)
  })

  it('reads PR checks, transient errors and leaks', () => {
    const pr = (checks: object[], head = 'abc') => ({ url: 'u', baseRefName: 'dev', headRefOid: head, statusCheckRollup: checks })
    expect(prReady(undefined, 'abc')).toMatchObject({ ok: false, why: 'no open PR for this task' })
    expect(prReady(pr([], 'zzz'), 'abc')).toMatchObject({ ok: false, why: expect.stringMatching(/head/) })
    expect(prReady(pr([{ status: 'IN_PROGRESS' }]), 'abc')).toMatchObject({ ok: false, later: true })
    expect(prReady(pr([{ status: 'COMPLETED', conclusion: 'FAILURE' }]), 'abc')).toMatchObject({ ok: false, why: '1 check(s) failed' })
    expect(prReady(pr([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'abc')).toEqual({ ok: true })
    // A required check not reported yet (CI not started): later, never merged on no checks.
    expect(prReady(pr([]), 'abc', ['smoke'])).toEqual({ ok: false, later: true, why: 'waiting for check smoke' })
    expect(prReady(pr([{ name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'abc', ['smoke'])).toEqual({ ok: true })
    expect(isTransient(1, 'remote: fatal error in commit_refs')).toBe(true)
    expect(isTransient(1, 'base branch policy prohibits the merge')).toBe(true)
    expect(isTransient(1, 'HTTP 502: Bad Gateway')).toBe(true)
    expect(isTransient(null, '')).toBe(true)
    expect(isTransient(3, 'conflict in app.vue')).toBe(false)
    expect(isTransient(3, 'conflict in src/502.vue')).toBe(false)
    expect(isTransient(5, 'commit abc is not in release-503')).toBe(false)
    expect(leaks(g, ['origin', 'origin/main', 'origin/dev'], [])).toEqual(['main'])
    expect(leaks(g, ['origin/main'], ['main'])).toEqual([])
  })
})

function fakeDeps(replies: { code: number | null, out: string }[]) {
  const receipts = new Map<string, Receipt>()
  const calls: string[][] = [], sleeps: number[] = []
  const deps: ActionDeps = {
    store: { receipt: async id => receipts.get(id) ?? null, saveReceipt: async (r) => { receipts.set(r.id, r) } },
    sh: async (_s, args) => { calls.push(args); return replies.shift() ?? { code: 0, out: '' } },
    sleep: async (ms) => { sleeps.push(ms) },
  }
  return { deps, receipts, calls, sleeps }
}
const job = (over: Partial<ActionJob> = {}): ActionJob => ({
  task: { id: 'A-1', title: 'T', description: 'D' }, step: 'land', attempt: 1, action: { kind: 'git.land', target: 'dev' },
  by: 'engine', guards: g, worktree: '/w', branch: 'task/A-1', ...over,
})

describe('runAction', () => {
  it('tries unreadable PR details again, then says why with the output\'s tail, private parts masked', async () => {
    const cut = { code: 0, out: 'abc123\n[{"url":"https://pr/1","body":"cut\nsh: 1: cd: /home/sam/project: warning' }
    const f = fakeDeps(Array.from({ length: RETRY_MS.length + 1 }, () => cut))
    const r = await runAction(f.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))
    expect(f.sleeps).toEqual(RETRY_MS)
    expect(r).toEqual({ ok: false, error: 'merge: unreadable PR details: abc123 | [{"url":"https://pr/1","body":"cut | sh: 1: cd: [home path]/project: warning' })
  })

  it('refuses before running anything, and keeps the refusal as its receipt', async () => {
    const f = fakeDeps([])
    expect(await runAction(f.deps, job({ action: { kind: 'git.land', target: 'main' } }))).toEqual({ ok: false, error: 'main is protected: only you may merge into it' })
    expect(f.calls).toEqual([])
    expect(f.receipts.get('A-1.1.land')?.state).toBe('done')
  })

  it('tries a transient error again, sends a conflict back, and never replays a receipt', async () => {
    const f = fakeDeps([{ code: 1, out: 'fatal error in commit_refs' }, { code: 0, out: 'c0ffee' }, { code: 0, out: 'origin/dev' }])
    expect(await runAction(f.deps, job())).toEqual({ ok: true, commit: 'c0ffee' })
    expect(f.sleeps).toEqual([60_000])
    expect(await runAction(f.deps, job())).toEqual({ ok: true, commit: 'c0ffee' }) // same attempt: stored result
    expect(f.calls.length).toBe(3)
    const c = fakeDeps([{ code: 3, out: 'conflict in app.vue' }])
    expect(await runAction(c.deps, job())).toEqual({ ok: false, error: 'land: conflict in app.vue', toAgent: true })
    c.receipts.set('A-1.2.land', { id: 'A-1.2.land', task: 'A-1', step: 'land', action: job().action, state: 'pending', at: 0 })
    expect(await runAction(c.deps, job({ attempt: 2 }))).toMatchObject({ ok: false, error: expect.stringMatching(/interrupted/) })
    expect(c.receipts.get('A-1.2.land')?.state).toBe('uncertain')
    expect(c.calls.length).toBe(1)
  })

  it('merges once checks are green, with the task\'s commit, and alerts on a protected branch', async () => {
    const info = (state: string, base = 'dev') => ({ code: 0, out: `abc\n${JSON.stringify([{ url: 'https://pr/1', baseRefName: base, headRefOid: 'abc', statusCheckRollup: [{ status: state, conclusion: 'SUCCESS' }] }])}` })
    const f = fakeDeps([info('QUEUED'), { code: 0, out: 'same' }, info('COMPLETED'), { code: 0, out: 'same' }, { code: 0, out: 'https://pr/1' }, { code: 0, out: 'origin/dev\norigin/main' }])
    // Checks running: no sleep, later; the engine's next pass looks again, as new.
    expect(await runAction(f.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))).toEqual({ ok: false, later: true, error: 'merge: checks still running' })
    expect(f.receipts.get('A-1.1.merge')).toMatchObject({ state: 'later' })
    const r = await runAction(f.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))
    expect(r).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: 'abc', alert: 'A-1\'s commit abc is on main without a step of yours' })
    expect(f.sleeps).toEqual([])
    expect(f.calls[4]).toEqual(['/w', 'https://pr/1', 'abc', '']) // no method: the first the repo allows
    const p = fakeDeps([info('COMPLETED', 'main')])
    expect(await runAction(p.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))).toMatchObject({ error: expect.stringMatching(/only you/) })
    expect(p.calls.length).toBe(1)
    // Stopped while its checks ran: never merged.
    const h = fakeDeps([info('COMPLETED'), { code: 0, out: 'same' }])
    expect(await runAction(h.deps, job({ step: 'merge', action: { kind: 'github.merge' }, halted: async () => true }))).toEqual({ ok: false, error: 'merge: the task was stopped' })
    expect(h.calls.length).toBe(2)
    // Pushed, but the remote branch did not move: refused at once, no wait.
    const stale = { code: 0, out: `abc\n${JSON.stringify([{ url: 'https://pr/1', baseRefName: 'dev', headRefOid: 'old' }])}` }, behind = { code: 0, out: 'behind' }
    const n = fakeDeps([stale, behind, { code: 0, out: 'abc' }, stale, behind, { code: 0, out: 'old' }])
    expect(await runAction(n.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))).toEqual({ ok: false, error: 'merge: the push did not move origin/task/A-1 (at old, the task at abc): push the branch by hand, then try the step again' })
    expect(n.sleeps).toEqual([])
    // GitHub's lag, then checks running at the new head: each a later, never a sleep.
    const fresh = (state: string) => ({ code: 0, out: `abc\n${JSON.stringify([{ url: 'https://pr/1', baseRefName: 'dev', headRefOid: 'abc', statusCheckRollup: [{ status: state, conclusion: 'SUCCESS' }] }])}` }), same = { code: 0, out: 'same' }
    const l = fakeDeps([stale, behind, { code: 0, out: 'abc' }, stale, behind, { code: 0, out: 'abc' }, fresh('IN_PROGRESS'), same, fresh('COMPLETED'), same, { code: 0, out: 'https://pr/1' }])
    const merge = () => runAction(l.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))
    expect(await merge()).toEqual({ ok: false, later: true, error: 'merge: GitHub still shows the PR head at old, origin/task/A-1 is at abc' })
    expect(await merge()).toMatchObject({ ok: false, later: true, error: 'merge: checks still running' })
    expect(await merge()).toMatchObject({ ok: true, commit: 'abc' })
    expect(l.sleeps).toEqual([])
    // GitHub's conflict ends with the commands to fix it: the error keeps none of them.
    const x = fakeDeps([info('COMPLETED'), { code: 0, out: 'same' }, { code: 1, out: 'X Pull request #505 is not mergeable: the merge commit cannot be cleanly created.\nRun the following to resolve the merge conflicts locally:\n  gh pr checkout 505 && git fetch origin dev && git merge origin/dev' }])
    expect(await runAction(x.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))).toMatchObject({ ok: false, error: 'merge: the PR conflicts with dev', catchUp: 'dev' })
    // Approved at an earlier commit: it merges only while the task's own interface is the same.
    const ui = (out: string) => fakeDeps([info('COMPLETED'), same, { code: 0, out }, { code: 0, out: 'https://pr/1' }]).deps
    const approved = job({ step: 'merge', action: { kind: 'github.merge' }, approved: 'old' })
    expect(await runAction(ui('changed'), approved)).toMatchObject({ ok: false, unapproved: true })
    expect(await runAction(ui('same'), approved)).toMatchObject({ ok: true, commit: 'abc' })
  })
})

describe('a merge interrupted by a restart', () => {
  const merge = { kind: 'github.merge' } as const
  const pr = (over: object = {}) => ({ code: 0, out: `abc\n${JSON.stringify([{ url: 'https://pr/1', baseRefName: 'dev', headRefOid: 'abc', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], ...over }])}` })
  const cut = (replies: { code: number | null, out: string }[], over: Partial<Receipt> = {}) => {
    const f = fakeDeps(replies)
    f.receipts.set('A-1.1.merge', { id: 'A-1.1.merge', task: 'A-1', step: 'merge', action: merge, state: 'pending', at: 0, ...over })
    return { ...f, go: () => runAction(f.deps, job({ step: 'merge', action: merge })) }
  }

  it('ends merged when GitHub merged it meanwhile', async () => {
    const f = cut([pr({ merged: true }), { code: 0, out: 'origin/dev' }])
    expect(await f.go()).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: 'abc', note: 'merged before the restart' })
    expect(f.receipts.get('A-1.1.merge')?.state).toBe('done')
  })

  it('reads the PR again after a merge that timed out, never merging it blindly twice', async () => {
    const f = fakeDeps([pr(), { code: 0, out: 'same' }, { code: null, out: '' }, pr({ merged: true }), { code: 0, out: 'origin/dev' }])
    expect(await runAction(f.deps, job({ step: 'merge', action: merge }))).toMatchObject({ ok: true, link: 'https://pr/1', note: 'already merged on GitHub' })
    expect(f.calls).toHaveLength(5)
  })

  it('goes to the user when the PR was closed without a merge', async () => {
    const f = cut([{ code: 0, out: 'abc\n[]' }, { code: 0, out: 'https://pr/1' }])
    expect(await f.go()).toEqual({ ok: false, error: 'merge: the PR was closed without being merged (https://pr/1): reopen it, or open a new one' })
  })

  it('merges an open PR again, with the gesture of whoever started it', async () => {
    // Started by the user into protected main: resumed by the engine, still theirs.
    const f = cut([pr({ baseRefName: 'main' }), { code: 0, out: 'same' }, { code: 0, out: 'https://pr/1' }, { code: 0, out: 'origin/main' }], { by: 'user' })
    expect(await f.go()).toEqual({ ok: true, link: 'https://pr/1', base: 'main', commit: 'abc' })
    expect(f.calls[2]).toEqual(['/w', 'https://pr/1', 'abc', ''])
  })

  it('is run again twice at most, then goes to the user', async () => {
    const once = cut([], { resumes: 1 })
    once.deps.sh = async () => { throw new Error('restarted') }
    await expect(once.go()).rejects.toThrow('restarted')
    expect(once.receipts.get('A-1.1.merge')).toMatchObject({ state: 'pending', resumes: 2 })
    const f = cut([], { resumes: 2 })
    expect(await f.go()).toEqual({ ok: false, error: 'github.merge was interrupted 3 times: check by hand, then try again' })
    expect(f.receipts.get('A-1.1.merge')?.state).toBe('uncertain')
    expect(f.calls).toEqual([])
  })
})

describe('step engine and action results', () => {
  const vibe: Template = { id: 'v', taskTypes: { s: { steps: [
    { id: 'todo' }, { id: 'work', holder: 'worker', ends: 'report' }, { id: 'land', ends: 'action', action: { kind: 'git.land', target: 'dev' } }, { id: 'done' },
  ] } } }
  it('numbers each attempt, keeps proofs and sends a conflict back to the worker', () => {
    const plan = planSteps(vibe, { type: 's' })
    let s = onEvent(plan, initialState(), { kind: 'start' }, 0).state
    let r = onEvent(plan, s, { kind: 'report', from: 'worker' }, 1)
    expect(r.effects).toEqual([{ kind: 'action', step: 'land', action: { kind: 'git.land', target: 'dev' }, attempt: 1 }])
    r = onEvent(plan, r.state, { kind: 'action-result', ok: false, error: 'land: conflict in a.ts', toAgent: true }, 2)
    expect(r.state.at).toBe(1)
    expect(r.effects).toEqual([{ kind: 'instruct', step: 'work', holder: 'worker', text: 'land: conflict in a.ts. Fix it, commit, then say you are done.' }])
    r = onEvent(plan, r.state, { kind: 'report', from: 'worker' }, 3)
    expect(r.effects).toMatchObject([{ kind: 'action', attempt: 2 }])
    s = onEvent(plan, r.state, { kind: 'action-result', ok: true, evidence: { commit: 'abc' } }, 4).state
    expect(s).toMatchObject({ done: true, proofs: { land: { commit: 'abc' } } })
  })
})

// The real scripts on a throwaway repo, with a bare repo as its origin.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-actions-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim()
// A gh that knows no merged PR, so the tests never call GitHub.
const noGh = path.join(tmp, 'no-gh')
fs.mkdirSync(noGh); fs.writeFileSync(path.join(noGh, 'gh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
const localSh: ActionDeps['sh'] = async (script, args, input) => {
  const r = spawnSync('sh', ['-c', script, 'sh', ...args], { input, encoding: 'utf8', env: { ...process.env, PATH: `${noGh}:${process.env.PATH}`, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } })
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() }
}

describe('on a real repo', () => {
  it('tells a change of the task\'s own interface from what a merge of its base brought', async () => {
    const dir = path.join(tmp, 'ui'), origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt')
    const put = (at: string, file: string, text: string) => { fs.mkdirSync(path.dirname(path.join(at, file)), { recursive: true }); fs.writeFileSync(path.join(at, file), text); git(at, 'add', '.'); git(at, 'commit', '-qm', file); return git(at, 'rev-parse', 'HEAD') }
    fs.mkdirSync(dir); git(dir, 'init', '-q', '--bare', '-b', 'main', origin); git(dir, 'clone', '-q', origin, repo)
    put(repo, 'app/components/A.vue', '1\n2\n3\n4\n5\n6\n7\n8\n'); git(repo, 'push', '-q', 'origin', 'main:dev')
    git(repo, 'worktree', 'add', '-q', '-b', 'task/A-1', wt, 'origin/dev')
    const approved = put(wt, 'app/components/A.vue', '1\n2\nmine\n4\n5\n6\n7\n8\n')
    const changed = async (to: string) => (await localSh(SCRIPT.uiChanged, [wt, 'dev', approved, to])).out
    // The base changes the same file elsewhere and another screen; merged in, the task's own change is the same.
    git(repo, 'checkout', '-q', '-B', 'other', 'origin/dev'); put(repo, 'app/components/A.vue', '0\n1\n2\n3\n4\n5\n6\n7\ntheirs\n'); put(repo, 'pages/b.vue', 'b\n'); git(repo, 'push', '-q', 'origin', 'HEAD:dev')
    git(wt, 'fetch', '-q'); git(wt, 'merge', '-q', '--no-edit', 'origin/dev')
    expect(await changed(git(wt, 'rev-parse', 'HEAD'))).toBe('same')
    // A CI fix outside the interface keeps it; a change to a screen does not.
    expect(await changed(put(wt, 'server/x.ts', 'fix\n'))).toBe('same')
    expect(await changed(put(wt, 'app/layouts/default.vue', 'new\n'))).toBe('changed')
    // Over all files: the merge of the base keeps the task's own change, the CI fix moves it.
    const own = async (to: string) => (await localSh(SCRIPT.ownChanged, [wt, 'dev', approved, to])).out
    expect(await own(git(wt, 'rev-parse', 'HEAD~2'))).toBe('same')
    expect(await own(git(wt, 'rev-parse', 'HEAD~1'))).toBe('changed')
  })

  it('lands a task on dev, refuses main, sends a conflict back and verifies the merge', async () => {
    const origin = path.join(tmp, 'origin.git'), repo = path.join(tmp, 'repo'), wt = path.join(tmp, 'wt')
    git(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    git(tmp, 'clone', '-q', origin, repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'push', '-q', 'origin', 'main', 'main:dev')
    git(repo, 'worktree', 'add', '-q', '-b', 'task/A-1', wt, 'origin/dev')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'task\n')
    const receipts = new Map<string, Receipt>()
    const deps: ActionDeps = { store: { receipt: async id => receipts.get(id) ?? null, saveReceipt: async (r) => { receipts.set(r.id, r) } }, sh: localSh, sleep: async () => {} }
    const at = (n: number, over: Partial<ActionJob> = {}) => job({ worktree: wt, attempt: n, ...over })

    expect(await runAction(deps, at(1))).toMatchObject({ ok: false, toAgent: true, error: expect.stringMatching(/uncommitted/) })
    git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'task')
    const head = git(wt, 'rev-parse', 'HEAD')
    expect(await runAction(deps, at(2))).toEqual({ ok: true, commit: head })
    expect(git(origin, 'rev-parse', 'dev')).toBe(head)
    expect(git(origin, 'rev-parse', 'main')).not.toBe(head)
    expect(await runAction(deps, at(3, { action: { kind: 'git.land', target: 'main' } }))).toMatchObject({ ok: false, error: expect.stringMatching(/protected/) })
    expect(await runAction(deps, at(4, { step: 'check', action: { kind: 'git.verify-merged', target: 'main' } }))).toMatchObject({ ok: false, error: expect.stringMatching(/is not in main/) })

    // Someone else changes the same file on dev: the land is sent back.
    git(repo, 'fetch', '-q'); git(repo, 'checkout', '-q', '-b', 'other', 'origin/dev')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'theirs\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'theirs'); git(repo, 'push', '-q', 'origin', 'HEAD:dev')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'mine\n'); git(wt, 'commit', '-qam', 'mine')
    expect(await runAction(deps, at(5))).toEqual({ ok: false, error: 'land: conflict in b.txt', toAgent: true })
    expect(git(wt, 'status', '--porcelain')).toBe('')

    // A merge to main done outside any step of yours raises the alert.
    git(repo, 'push', '-q', 'origin', `${head}:refs/heads/main`, '--force')
    git(wt, 'reset', '-q', '--hard', head)
    expect(await runAction(deps, at(6, { step: 'check', action: { kind: 'git.verify-merged', target: 'dev' } })))
      .toMatchObject({ ok: true, alert: expect.stringMatching(/is on main without a step of yours/) })
    expect(await runAction(deps, at(7, { step: 'check', by: 'user', action: { kind: 'git.verify-merged', target: 'main' } })))
      .toEqual({ ok: true, commit: head })
  })

  it('lands vibe\'s step locally on a fresh git init folder, with no remote', async () => {
    const repo = path.join(tmp, 'fresh'), wt = path.join(tmp, 'fresh-wt')
    git(tmp, 'init', '-q', '-b', 'main', repo); git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
    const land = vibe.taskTypes.simple!.steps.find((s): s is Step => typeof s !== 'string' && s.id === 'land')!.action!
    expect((await localSh(WORKTREE_SCRIPT, [repo, wt, 'task/A-1', ''])).code).toBe(0)
    const deps: ActionDeps = { store: { receipt: async () => null, saveReceipt: async () => {} }, sh: localSh }
    const at = (n: number) => job({ worktree: wt, attempt: n, action: land })

    fs.writeFileSync(path.join(wt, 'b.txt'), 'task\n'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'task')
    expect(await runAction(deps, at(1))).toEqual({ ok: true, commit: git(wt, 'rev-parse', 'HEAD') })
    expect(git(repo, 'rev-parse', 'dev')).toBe(git(wt, 'rev-parse', 'HEAD')) // dev made at the task's commit

    // dev moved meanwhile: merged into the task first; the same file changed is sent back.
    git(repo, 'checkout', '-q', 'dev'); fs.writeFileSync(path.join(repo, 'c.txt'), 'theirs\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'theirs')
    fs.writeFileSync(path.join(wt, 'b.txt'), 'mine\n'); git(wt, 'commit', '-qam', 'mine')
    expect(await runAction(deps, at(2))).toMatchObject({ ok: false, error: expect.stringMatching(/^land: dev is checked out in .*: switch that folder/) })
    git(repo, 'checkout', '-q', 'main'); git(repo, 'tag', 'dev', 'main') // a tag of the same name is not the branch
    expect(await runAction(deps, at(3))).toMatchObject({ ok: true })
    expect(git(repo, 'show', 'refs/heads/dev:c.txt')).toBe('theirs')
    expect(git(repo, 'show', 'refs/heads/dev:b.txt')).toBe('mine')
    git(repo, 'update-ref', 'refs/heads/dev', git(repo, 'commit-tree', '-p', 'refs/heads/dev', '-m', 'x', git(repo, 'rev-parse', 'main^{tree}')))
    fs.writeFileSync(path.join(wt, 'b.txt'), 'again\n'); git(wt, 'commit', '-qam', 'again')
    expect(await runAction(deps, at(4))).toEqual({ ok: false, error: 'land: conflict in b.txt', toAgent: true })
  })

  it('sees a gh error printed on stderr even when only stdout comes back, and tries again', async () => {
    const repo = path.join(tmp, 'gh'), bin = path.join(tmp, 'bin')
    fs.mkdirSync(bin); git(tmp, 'init', '-q', repo); git(repo, 'commit', '-q', '--allow-empty', '-m', 'x')
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "HTTP 502: Bad Gateway" >&2; exit 1\n', { mode: 0o755 })
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` }
    const stdoutOnly: ActionDeps['sh'] = async (script, args) => {
      const r = spawnSync('sh', ['-c', script, 'sh', ...args], { encoding: 'utf8', env })
      return { code: r.status, out: r.stdout.trim() }
    }
    const f = fakeDeps([])
    const r = await runAction({ ...f.deps, sh: stdoutOnly }, job({ worktree: repo, step: 'merge', action: { kind: 'github.merge' } }))
    expect(r).toEqual({ ok: false, error: 'merge: HTTP 502: Bad Gateway' })
    expect(f.sleeps).toEqual([60_000, 120_000, 240_000, 480_000])
  })
})

// verify-merged on a worktree made by the launch script, with a fake gh that
// lists the heads of the merged PRs written in its file.
describe('verify-merged', () => {
  let n = 0
  async function setup() {
    const dir = path.join(tmp, `v${++n}`), origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt'), bin = path.join(dir, 'bin')
    const merged = path.join(dir, 'merged')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\n[ -f "${merged}.err" ] && { cat "${merged}.err" >&2; exit 1; }\ncat "${merged}" 2>/dev/null; exit 0\n`, { mode: 0o755 })
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin)
    git(dir, 'clone', '-q', origin, repo)
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'init'); git(repo, 'push', '-q', 'origin', 'main:dev')
    git(repo, 'fetch', '-q')
    expect((await localSh(WORKTREE_SCRIPT, [repo, wt, 'task/A-1', 'origin/dev'])).code).toBe(0)
    // A base the clone has only on origin: the task's branch, never a new local base branch,
    // from origin's base as it is now (a task merged meanwhile is in it).
    git(repo, 'checkout', '-q', '-b', 'tmp'); fs.writeFileSync(path.join(repo, 'm.txt'), 'merged\n')
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'merged'); git(repo, 'push', '-q', 'origin', 'HEAD:dev'); git(repo, 'checkout', '-q', 'main'); git(repo, 'branch', '-qD', 'tmp')
    git(repo, 'update-ref', 'refs/remotes/origin/dev', 'HEAD') // the clone's view of dev is stale
    expect((await localSh(WORKTREE_SCRIPT, [repo, `${wt}2`, 'task/A-2', 'dev'])).code).toBe(0)
    expect(fs.existsSync(path.join(`${wt}2`, 'm.txt'))).toBe(true)
    expect(git(`${wt}2`, 'branch', '--show-current')).toBe('task/A-2')
    expect(git(repo, 'branch', '--list', 'dev')).toBe('')
    expect(spawnSync('git', ['-C', `${wt}2`, 'rev-parse', '--abbrev-ref', '@{upstream}']).status).not.toBe(0)
    const sh: ActionDeps['sh'] = (script, args, input) => localSh(`PATH="${bin}:$PATH"\n${script}`, args, input)
    const verify = (by: 'user' | 'engine' = 'user') =>
      runAction({ ...fakeDeps([]).deps, sh }, job({ worktree: wt, step: 'check', by, action: { kind: 'git.verify-merged', target: 'dev' } }))
    // Someone else's commit on dev.
    const theirs = () => {
      git(repo, 'checkout', '-q', '-B', 'other', 'origin/dev'); fs.writeFileSync(path.join(repo, 'c.txt'), `theirs ${++n}\n`)
      git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'theirs'); git(repo, 'push', '-q', 'origin', 'HEAD:dev')
    }
    const work = () => { fs.writeFileSync(path.join(wt, 'b.txt'), 'task\n'); git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'task'); return git(wt, 'rev-parse', 'HEAD') }
    return { repo, wt, merged, verify, theirs, work, sh }
  }

  it('records where the branch started, once', async () => {
    const s = await setup()
    expect(git(s.repo, 'config', 'branch.task/A-1.wherdrstart')).toBe(git(s.wt, 'rev-parse', 'HEAD'))
  })

  it('accepts a PR merged with squash or rebase on GitHub', async () => {
    const s = await setup(), head = s.work()
    git(s.repo, 'checkout', '-q', '-B', 'dev', 'origin/dev'); git(s.repo, 'merge', '-q', '--squash', head); git(s.repo, 'commit', '-qm', 'A-1 (#1)'); git(s.repo, 'push', '-q', 'origin', 'dev')
    expect(await s.verify()).toMatchObject({ ok: false, error: expect.stringMatching(/is not in dev$/) })
    // gh unable to answer: the git reason stays, with why GitHub was not asked.
    fs.writeFileSync(`${s.merged}.err`, 'To get started with GitHub CLI, please run:  gh auth login\nGH_TOKEN: x\n')
    expect(await s.verify()).toMatchObject({ ok: false, error: 'verify-merged: commit ' + head.slice(0, 7) + ' is not in dev (GitHub not checked: To get started with GitHub CLI, please run:  gh auth login)' })
    fs.rmSync(`${s.merged}.err`)
    fs.writeFileSync(s.merged, `${head}\n`)
    expect(await s.verify()).toMatchObject({ ok: true, commit: head })
  })

  it('accepts a branch rebased onto dev, then landed', async () => {
    const s = await setup()
    s.work(); s.theirs()
    git(s.wt, 'fetch', '-q', 'origin'); git(s.wt, 'rebase', '-q', 'origin/dev')
    const head = git(s.wt, 'rev-parse', 'HEAD')
    git(s.wt, 'push', '-q', 'origin', 'HEAD:dev')
    expect(await s.verify()).toMatchObject({ ok: true, commit: head })
  })

  it('accepts own work rebuilt with pull --rebase or am, then merged by hand', async () => {
    for (const rebuild of ['pull', 'am'] as const) {
      const s = await setup(), mine = s.work()
      s.theirs()
      if (rebuild === 'pull') git(s.wt, 'pull', '-q', '--rebase', 'origin', 'dev')
      else {
        const patch = git(s.wt, 'format-patch', '-1', mine, '-o', path.join(s.wt, '..', 'p'))
        git(s.wt, 'fetch', '-q', 'origin'); git(s.wt, 'reset', '-q', '--hard', 'origin/dev'); git(s.wt, 'am', '-q', patch)
      }
      const head = git(s.wt, 'rev-parse', 'HEAD')
      git(s.wt, 'push', '-q', 'origin', 'HEAD:dev')
      expect(await s.verify()).toMatchObject({ ok: true, commit: head })
    }
  })

  it('accepts a plain merge into dev', async () => {
    const s = await setup(), head = s.work()
    s.theirs()
    git(s.wt, 'push', '-q', 'origin', 'HEAD:refs/heads/task/A-1'); git(s.repo, 'fetch', '-q')
    git(s.repo, 'checkout', '-q', '-B', 'dev', 'origin/dev'); git(s.repo, 'merge', '-q', '--no-ff', '-m', 'merge A-1', 'origin/task/A-1'); git(s.repo, 'push', '-q', 'origin', 'dev')
    expect(await s.verify()).toMatchObject({ ok: true, commit: head })
  })

  it('refuses a branch with no commit of its own, even fast-forwarded or rebased onto dev', async () => {
    const s = await setup()
    expect(await s.verify()).toMatchObject({ ok: false, error: 'verify-merged: task/A-1 has no commit of its own: nothing was merged' })
    s.theirs()
    git(s.wt, 'fetch', '-q', 'origin'); git(s.wt, 'merge', '-q', '--ff-only', 'origin/dev')
    expect(await s.verify()).toMatchObject({ ok: false, error: expect.stringMatching(/no commit of its own/) })
    s.theirs(); git(s.wt, 'pull', '-q', '--rebase', 'origin', 'dev')
    s.theirs(); git(s.wt, 'fetch', '-q', 'origin'); git(s.wt, 'rebase', '-q', 'origin/dev')
    expect(git(s.wt, 'rev-parse', 'HEAD')).toBe(git(s.wt, 'rev-parse', 'origin/dev'))
    expect(await s.verify()).toMatchObject({ ok: false, error: expect.stringMatching(/no commit of its own/) })
  })

  it('counts the commits a branch taken over had ahead of dev as the task\'s, even once merged and deleted', async () => {
    const s = await setup()
    // A bot's branch, then one with no commit ahead of dev.
    git(s.repo, 'checkout', '-q', '-B', 'bot/deps', 'origin/dev'); fs.writeFileSync(path.join(s.repo, 'lock.txt'), 'bumped\n')
    git(s.repo, 'add', '.'); git(s.repo, 'commit', '-qm', 'bump'); git(s.repo, 'push', '-q', 'origin', 'bot/deps', 'origin/dev:refs/heads/bot/empty')
    git(s.repo, 'checkout', '-q', 'main'); git(s.repo, 'branch', '-qD', 'bot/deps'); git(s.repo, 'fetch', '-q')
    const take = async (b: string) => {
      const wt = path.join(s.wt, '..', b.replace('/', '-'))
      expect((await localSh(WORKTREE_SCRIPT, [s.repo, wt, b, 'dev', `origin/${b}`])).code).toBe(0)
      return { wt, verify: () => runAction({ ...fakeDeps([]).deps, sh: s.sh }, job({ worktree: wt, branch: b, step: 'check', by: 'user', action: { kind: 'git.verify-merged', target: 'dev' } })) }
    }
    // A local copy ahead of origin's (its commits kept) is taken over too.
    git(s.repo, 'branch', 'bot/ahead', 'origin/bot/deps'); git(s.repo, 'push', '-q', 'origin', 'origin/dev:refs/heads/bot/ahead'); git(s.repo, 'fetch', '-q')
    const bot = await take('bot/deps'), empty = await take('bot/empty'), ahead = await take('bot/ahead')
    expect(git(s.repo, 'config', 'branch.bot/deps.wherdrstart')).toBe(git(s.repo, 'rev-parse', 'origin/dev'))
    git(s.repo, 'push', '-q', 'origin', 'origin/bot/deps:refs/heads/dev', ':refs/heads/bot/deps', ':refs/heads/bot/empty', ':refs/heads/bot/ahead')
    expect(await bot.verify()).toMatchObject({ ok: true, commit: git(bot.wt, 'rev-parse', 'HEAD') })
    expect(await ahead.verify()).toMatchObject({ ok: true, commit: git(ahead.wt, 'rev-parse', 'HEAD') })
    expect(await empty.verify()).toMatchObject({ ok: false, error: 'verify-merged: bot/empty has no commit of its own: nothing was merged' })
  })

  it('accepts a PR merged on Bitbucket whose source commit holds HEAD', async () => {
    const s = await setup(), head = s.work()
    const asked: string[] = []
    const sh: ActionDeps['sh'] = async (script, args, input) => {
      if (script !== SCRIPT.bitbucket) return s.sh(script, args, input)
      asked.push(args[3]!)
      return { code: 0, out: `${JSON.stringify({ values: [{ state: 'MERGED', source: { commit: { hash: head.slice(0, 12) } }, links: { html: { href: 'https://bitbucket.example/pr/7' } } }] })}\n200` }
    }
    const verify = () => runAction({ ...fakeDeps([]).deps, sh }, job({ worktree: s.wt, step: 'check', by: 'user', action: { kind: 'git.verify-merged', target: 'dev' } }))
    expect(await verify()).toMatchObject({ ok: true, commit: head, link: 'https://bitbucket.example/pr/7' })
    // gh logged out: GitHub cannot answer, Bitbucket still does.
    fs.writeFileSync(`${s.merged}.err`, 'To get started with GitHub CLI, please run:  gh auth login\n')
    expect(await verify()).toMatchObject({ ok: true, commit: head })
    expect(asked).toEqual(Array(2).fill('q=source.branch.name="task/A-1" AND destination.branch.name="dev"'))
  })
})

// A PR of the branch merged on GitHub before the engine's merge step (by hand,
// or a merge that answered 502): never a second PR. As Shepherdr #706 (MIT).
describe('a PR already merged on GitHub', () => {
  // A gh with no open PR, the merged PRs ("<head> <url>") in its file, and
  // `pr create` printing a new PR's link.
  function setup(name: string) {
    const dir = path.join(tmp, name), repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin'), merged = path.join(dir, 'merged')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"--state merged"*) while read -r h u b; do case "$*" in *tojson*) echo "$h {\\"url\\":\\"$u\\",\\"baseRefName\\":\\"\${b:-dev}\\",\\"headRefOid\\":\\"$h\\",\\"merged\\":true}";; *) echo "$h $u";; esac; done < "${merged}";;
  *"--state open"*" -q .["*) ;;
  *"--state open"*) echo '[]';;
  "pr create"*) echo "https://pr/new";;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`, { mode: 0o755 })
    git(tmp, 'init', '-q', '--bare', path.join(dir, 'origin.git'))
    git(tmp, 'init', '-q', '-b', 'task/A-1', repo); git(repo, 'remote', 'add', 'origin', path.join(dir, 'origin.git'))
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'task')
    fs.writeFileSync(merged, `${git(repo, 'rev-parse', 'HEAD')} https://pr/1\n`)
    const sh: ActionDeps['sh'] = (script, args, input) => localSh(`PATH="${bin}:$PATH"\n${script}`, args, input)
    const f = fakeDeps([])
    const go = (step: string, action: ActionJob['action'], attempt = 1, by: ActionJob['by'] = 'engine') => runAction({ ...f.deps, sh }, job({ worktree: repo, step, attempt, action, by }))
    return { repo, merged, go }
  }

  it('counts as done at the merge step', async () => {
    const s = setup('merged-merge'), head = git(s.repo, 'rev-parse', 'HEAD')
    expect(await s.go('merge', { kind: 'github.merge' })).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: head, note: 'already merged on GitHub' })
    // Merged by hand at a head without the task's commit (a later local commit):
    // the step ends merged, recording what GitHub merged, and says what it left out.
    const at = 'f'.repeat(40)
    fs.writeFileSync(s.merged, `${at} https://pr/1\n`)
    expect(await s.go('merge', { kind: 'github.merge' }, 2)).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: at, note: `already merged on GitHub at fffffff, without the task's commit ${head.slice(0, 7)}`,
      alert: `A-1's commit ${head.slice(0, 7)} was not merged: its PR was merged on GitHub at fffffff without it. Its later commits need a new branch` })
    // Merged into protected main outside your gesture: recorded, with the alert.
    fs.writeFileSync(s.merged, `${head} https://pr/1 main\n`)
    git(s.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    expect(await s.go('merge', { kind: 'github.merge' }, 3)).toMatchObject({ ok: true, alert: 'A-1\'s commit ' + head.slice(0, 7) + ' is on main without a step of yours' })
    // Your gesture: main is yours to merge, no alert.
    expect(await s.go('merge', { kind: 'github.merge' }, 4, 'user')).toEqual({ ok: true, link: 'https://pr/1', base: 'main', commit: head, note: 'already merged on GitHub' })
    // The PR's head pushed from elsewhere, not fetched here yet: found all the same.
    const other = path.join(tmp, 'merged-merge', 'other')
    git(s.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/task/A-1'); git(tmp, 'clone', '-q', '-b', 'task/A-1', path.join(tmp, 'merged-merge', 'origin.git'), other)
    git(other, 'commit', '-q', '--allow-empty', '-m', 'elsewhere'); git(other, 'push', '-q', 'origin', 'HEAD:task/A-1')
    fs.writeFileSync(s.merged, `${git(other, 'rev-parse', 'HEAD')} https://pr/2\n`)
    expect(await s.go('merge', { kind: 'github.merge' }, 5)).toMatchObject({ ok: true, link: 'https://pr/2', commit: head, note: 'already merged on GitHub' })
  })

  it('is the PR step\'s PR at its head, and refuses new commits after it', async () => {
    const s = setup('merged-pr')
    const pr = (attempt: number) => s.go('pr', { kind: 'github.pr', base: 'dev' }, attempt)
    expect(await pr(1)).toEqual({ ok: true, link: 'https://pr/1' })
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'after review')
    expect(await pr(2)).toEqual({ ok: false, error: 'pr: task/A-1 already had PR https://pr/1 merged: new commits need a new branch' })
    // No merged PR: a new one, as before.
    fs.writeFileSync(s.merged, '')
    expect(await pr(3)).toEqual({ ok: true, link: 'https://pr/new' })
  })
})

// The PR head moved after the review. A gh whose open PR's head is the
// remote branch's real tip; `pr merge` only answers.
describe('a PR head that moved after the review', () => {
  function setup(name: string) {
    const dir = path.join(tmp, name), origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"--state open"*) h=$(git --git-dir "${origin}" rev-parse task/A-1)
    # lag: how many more reads answer the stale head, as GitHub's API right after a push.
    n=$(cat "${bin}/lag" 2>/dev/null || echo 0); if [ "$n" -gt 0 ]; then echo $((n-1)) > "${bin}/lag"; h=$(cat "${bin}/stale"); fi
    echo "[{\\"url\\":\\"https://pr/1\\",\\"baseRefName\\":\\"dev\\",\\"headRefOid\\":\\"$h\\"}]";;
  "pr merge"*) ;;
  *) echo "unexpected gh $*" >&2; exit 1;;
esac
`, { mode: 0o755 })
    git(tmp, 'init', '-q', '--bare', '-b', 'dev', origin)
    git(tmp, 'clone', '-q', origin, repo); git(repo, 'commit', '-q', '--allow-empty', '-m', 'base'); git(repo, 'push', '-q', 'origin', 'HEAD:dev')
    git(repo, 'checkout', '-q', '-b', 'task/A-1'); git(repo, 'commit', '-q', '--allow-empty', '-m', 'task'); git(repo, 'push', '-q', 'origin', 'HEAD:task/A-1')
    const sh: ActionDeps['sh'] = (script, args, input) => localSh(`PATH="${bin}:$PATH"\n${script}`, args, input)
    const f = fakeDeps([])
    const merge = (attempt: number, reviewed: string) => runAction({ ...f.deps, sh }, job({ worktree: repo, step: 'merge', attempt, reviewed, action: { kind: 'github.merge', method: 'merge' } }))
    const elsewhere = (msg: string, ref: string) => {
      const other = path.join(dir, `other-${msg}`)
      git(tmp, 'clone', '-q', origin, other); git(other, 'checkout', '-q', ref)
      git(other, 'commit', '-q', '--allow-empty', '-m', msg); git(other, 'push', '-q', 'origin', `HEAD:${ref}`)
    }
    const lagging = (reads: number) => { fs.writeFileSync(path.join(bin, 'stale'), git(repo, 'rev-parse', 'HEAD')); fs.writeFileSync(path.join(bin, 'lag'), `${reads}`) }
    return { repo, origin, sh, f, merge, elsewhere, lagging, head: () => git(repo, 'rev-parse', 'HEAD') }
  }

  it('after a clean catch-up merge of the base, merges with no new review', async () => {
    const s = setup('moved-catchup'), reviewed = s.head()
    s.elsewhere('theirs', 'dev')
    expect((await s.sh(SCRIPT.catchUp, [s.repo, 'dev', 'task/A-1'])).code).toBe(0)
    expect(await s.merge(1, reviewed)).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: s.head() })
  })

  it('after a CI fix committed but not pushed, has it reviewed, pushes it, then merges', async () => {
    const s = setup('moved-cifix'), reviewed = s.head()
    fs.writeFileSync(path.join(s.repo, 'fix.txt'), 'fix\n'); git(s.repo, 'add', '.'); git(s.repo, 'commit', '-q', '-m', 'fix CI')
    const fix = s.head()
    expect(await s.merge(1, reviewed)).toMatchObject({ ok: false, review: { since: reviewed, head: fix }, commit: fix })
    expect(await s.merge(2, fix)).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: fix })
    expect(git(s.repo, '--git-dir', s.origin, 'rev-parse', 'task/A-1')).toBe(fix)
  })

  it('waits for GitHub to show a fresh push as a later, which the next pass looks at again', async () => {
    const s = setup('moved-lag'), old = s.head()
    s.lagging(3) // the read before the push, the one after it, and the next pass's first
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'fix CI')
    const fix = s.head()
    expect(await s.merge(1, fix)).toEqual({ ok: false, later: true, error: `merge: GitHub still shows the PR head at ${old.slice(0, 7)}, origin/task/A-1 is at ${fix.slice(0, 7)}` })
    expect(await s.merge(1, fix)).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: fix })
    expect(s.f.sleeps).toEqual([])
  })

  // GitHub's Update branch runs no local merge driver: its union merge lists an
  // index entry both sides changed twice. The merge step (or the engine's
  // take-update, when not merging) fixes it in the worktree and pushes it.
  it('takes a GitHub update into the worktree, fixes its merge and pushes it, then has it reviewed', async () => {
    const s = setup('moved-update'), other = path.join(tmp, 'moved-update', 'gh')
    const file = (cwd: string, text?: string) => text === undefined ? fs.readFileSync(path.join(cwd, 'docs/llms.txt'), 'utf8') : fs.writeFileSync(path.join(cwd, 'docs/llms.txt'), text)
    git(s.repo, 'checkout', '-q', 'dev'); fs.mkdirSync(path.join(s.repo, 'docs'))
    fs.writeFileSync(path.join(s.repo, '.gitattributes'), 'docs/llms.txt merge=union\n'); file(s.repo, '- [A](docs/a.md): a.\n')
    git(s.repo, 'add', '.'); git(s.repo, 'commit', '-qm', 'index'); git(s.repo, 'push', '-q', 'origin', 'HEAD:dev')
    git(s.repo, 'checkout', '-q', 'task/A-1'); git(s.repo, 'merge', '-q', '--no-edit', 'dev')
    file(s.repo, '- [A](docs/a.md): a, task.\n'); git(s.repo, 'commit', '-qam', 'task'); git(s.repo, 'push', '-q', 'origin', 'HEAD:task/A-1')
    git(s.repo, 'config', 'wherdr.afterMerge', `node ${path.resolve('scripts/llms-merge.mjs')} fix`)
    const reviewed = s.head()
    // On GitHub: dev changes A too, then Update branch merges dev with union.
    git(tmp, 'clone', '-q', '-b', 'dev', s.origin, other)
    file(other, '- [A](docs/a.md): a, dev.\n'); git(other, 'commit', '-qam', 'dev'); git(other, 'push', '-q', 'origin', 'HEAD:dev')
    git(other, 'checkout', '-q', 'task/A-1'); git(other, 'merge', '-q', '--no-edit', 'dev'); git(other, 'push', '-q', 'origin', 'HEAD:task/A-1')
    expect(file(other)).toBe('- [A](docs/a.md): a, task.\n- [A](docs/a.md): a, dev.\n')
    // The fix is pushed at once, before the new head goes back to review.
    const r = await s.merge(1, reviewed), fixed = s.head()
    expect(file(s.repo)).toBe('- [A](docs/a.md): a, task.\n')
    expect(git(s.repo, 'log', '-1', '--format=%s')).toBe('Fix the merge (wherdr.afterMerge)')
    expect(git(s.repo, '--git-dir', s.origin, 'rev-parse', 'task/A-1')).toBe(fixed)
    expect(r).toMatchObject({ ok: false, review: { since: reviewed, head: fixed } })
  })

  it('refuses a head pushed from outside the task\'s worktree', async () => {
    const s = setup('moved-foreign'), reviewed = s.head()
    s.elsewhere('foreign', 'task/A-1')
    expect(await s.merge(1, reviewed)).toEqual({ ok: false, error: expect.stringMatching(/^merge: the PR head [0-9a-f]{7} has commits the task's worktree never had/) })
  })

  // A large PR whose commit messages hold \n (dash's echo used to break the JSON), and gh warning on stderr after it.
  it('reads a large PR with a stderr line after its JSON', async () => {
    const s = setup('large-pr'), head = s.head(), bin = path.join(tmp, 'large-pr', 'bin')
    const pr = {
      url: 'https://pr/1', baseRefName: 'dev', headRefOid: 'HEAD_OID', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
      files: Array.from({ length: 300 }, (_, i) => ({ path: `src/file-${i}.ts`, additions: 3, deletions: 1 })), additions: 900, deletions: 300,
      commits: Array.from({ length: 80 }, (_, i) => ({ oid: `${i}`.padStart(40, '0'), messageHeadline: `change ${i}`, messageBody: 'first line\nsecond line\\n literal' })),
    }
    fs.writeFileSync(path.join(bin, 'pr.json'), `${JSON.stringify([pr])}\n`)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"--state open"*) sed "s/HEAD_OID/$(git --git-dir "${s.origin}" rev-parse task/A-1)/" "${bin}/pr.json"; echo "warning: a newer gh is available" >&2;;
  "pr merge"*) ;;
  *) exit 1;;
esac
`, { mode: 0o755 })
    expect((await s.sh(SCRIPT.prInfo, [s.repo, 'task/A-1'])).out.length).toBeGreaterThan(20_000)
    expect(await s.merge(1, head)).toEqual({ ok: true, link: 'https://pr/1', base: 'dev', commit: head })
  })

  it('sends the task back to its review for the new commits only, then on to merge', () => {
    const plan = planSteps(github, { type: 'simple' })
    const at = (id: string) => plan.findIndex(p => p.id === id)
    let s = onEvent(plan, { ...initialState(), started: true, at: at('review') }, { kind: 'verdict', from: 'reviewer', findings: [], head: 'r1' }, 0).state
    expect(plan[s.at]!.id).toBe('merge')
    expect(reviewedCommit(plan, s)).toBe('r1')
    s = onEvent(plan, s, { kind: 'action-result', ok: false, error: 'merge: new commits since the review', review: { since: 'r1', head: 'h2' }, evidence: { commit: 'h2' } }, 1).state
    expect(plan[s.at]!.id).toBe('review')
    expect(dueText(plan, s)?.text).toMatch(/^Short re-review: .*r1 → h2.*git log --oneline r1\.\.h2.*--remerge-diff/s)
    s = onEvent(plan, s, { kind: 'verdict', from: 'reviewer', findings: [], head: 'h2' }, 2).state
    expect([plan[s.at]!.id, s.acting, s.rereview, reviewedCommit(plan, s), s.rounds.review]).toEqual(['merge', true, undefined, 'h2', undefined])
  })
})

describe('pipeline.watch', () => {
  const run = (o: object) => ({ databaseId: 1, workflowName: 'CI', status: 'completed', conclusion: 'success', headSha: 'h2', url: 'https://ci.example/run/1', ...o })

  it('reads the runs of the latest commit and the command\'s exit code', () => {
    expect(runsState([])).toEqual({ state: 'running' })
    expect(runsState([run({ status: 'in_progress', conclusion: '' })])).toEqual({ state: 'running' })
    // An older commit's failed run does not count.
    expect(runsState([run({}), run({ databaseId: 2, conclusion: 'skipped' }), run({ headSha: 'h1', conclusion: 'failure' })])).toEqual({ state: 'done', link: 'https://ci.example/run/1' })
    expect(runsState([run({}), run({ databaseId: 2, conclusion: 'failure' })])).toMatchObject({ state: 'failed', run: { databaseId: 2 } })
    expect(commandState(0, 'deployed 1.2.3')).toEqual({ ok: true, report: 'deployed 1.2.3' })
    expect(commandState(2, 'pending')).toEqual({ ok: false, later: true })
    expect(commandState(null, '')).toEqual({ ok: false, later: true })
    expect(commandState(1, 'job test: red')).toEqual({ ok: false, error: 'pipeline: the command failed', detail: 'job test: red' })
    expect(commandState(127, 'not found')).toMatchObject({ error: 'pipeline: the command failed (exit code 127)' })
  })

  it('polls GitHub without a receipt and says which job failed, with the log tail', async () => {
    const calls: string[][] = []
    const sh: ActionDeps['sh'] = async (script, args) => {
      calls.push(args)
      if (script === SCRIPT.ghRuns) return { code: 0, out: JSON.stringify([run({ databaseId: 7, conclusion: 'failure', url: 'https://ci.example/run/7' })]) }
      return { code: 0, out: 'unit, e2e\nunit\tnpm test\tFAIL a.test.ts' }
    }
    const job = { action: { kind: 'pipeline.watch' as const, branch: 'develop' }, worktree: '/wt' }
    expect(await watch({ sh }, job)).toEqual({ ok: false, error: 'pipeline: CI failed (unit, e2e): https://ci.example/run/7', detail: 'unit\tnpm test\tFAIL a.test.ts' })
    expect(calls).toEqual([['/wt', 'develop', ''], ['/wt', '7']])
    expect(await watch({ sh: async () => ({ code: 1, out: 'HTTP 502: Bad Gateway' }) }, job)).toEqual({ ok: false, later: true })
  })

  it('watches a branch at its tip on origin: a run of the previous commit never passes for the merge\'s', async () => {
    const dir = path.join(tmp, 'watch'), origin = path.join(dir, 'origin.git'), wt = path.join(dir, 'wt'), bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true }); git(dir, 'init', '-q', '--bare', '-b', 'main', origin); git(dir, 'clone', '-q', origin, wt)
    const commit = (m: string) => { fs.writeFileSync(path.join(wt, 'a.txt'), m); git(wt, 'add', '.'); git(wt, 'commit', '-qm', m); return git(wt, 'rev-parse', 'HEAD') }
    const old = commit('old'); git(wt, 'push', '-q', 'origin', 'HEAD:develop')
    commit('merged'); git(wt, 'push', '-q', 'origin', 'HEAD:develop'); git(wt, 'reset', '-q', '--hard', old)
    // GitHub has registered only the old commit's green run, also the newest listed by branch.
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *"--commit ${old}"*|*"--branch develop"*) echo '${JSON.stringify([run({ headSha: old })])}';; *) echo '[]';; esac\n`, { mode: 0o755 })
    const sh: ActionDeps['sh'] = (script, args) => localSh(`PATH="${bin}:$PATH"\n${script}`, args)
    expect(await watch({ sh }, { action: { kind: 'pipeline.watch', branch: 'develop' }, worktree: wt })).toEqual({ ok: false, later: true })
    expect((await sh(SCRIPT.ghRuns, [wt, 'develop', ''])).code).toBe(0)
    expect(await watch({ sh }, { action: { kind: 'pipeline.watch', branch: 'nope' }, worktree: wt })).toEqual({ ok: false, error: 'pipeline: no branch nope on origin' })
  })
})

describe('the remote branch after a merge', () => {
  // A clone whose task branch is on origin; a stub gh answers the open and merged PR heads from files.
  function setup(name: string) {
    const dir = path.join(tmp, name), origin = path.join(dir, 'origin.git'), wt = path.join(dir, 'wt'), bin = path.join(dir, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\ncase "$*" in *"--state open"*) cat "${dir}/open" 2>/dev/null;; *"--state merged"*) cat "${dir}/merged" 2>/dev/null;; *api*) echo false;; *"repo view"*) echo main;; esac; exit 0\n`, { mode: 0o755 })
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin); git(dir, 'clone', '-q', origin, wt)
    git(wt, 'commit', '-q', '--allow-empty', '-m', 'task'); git(wt, 'push', '-q', 'origin', 'HEAD:main', 'HEAD:task/A-1')
    const sh: ActionDeps['sh'] = (script, args) => localSh(`PATH="${bin}:$PATH"\n${script}`, args)
    const drop = (o: { on?: boolean, bases?: string[] } = {}) => dropMergedBranch(sh, { worktree: wt, branch: 'task/A-1', guards: g, bases: o.bases ?? ['dev'], on: o.on ?? true })
    const onOrigin = () => git(origin, 'branch', '--list', 'task/A-1')
    return { dir, wt, drop, onOrigin, merged: (h: string) => fs.writeFileSync(path.join(dir, 'merged'), `${h}\n`) }
  }

  it('goes after a merge by the engine or one the user confirmed, once its merged PR has its head', async () => {
    expect(['github.merge', 'bitbucket.merge', 'git.verify-merged'].every(endsMerged)).toBe(true)
    expect(endsMerged('git.push')).toBe(false)
    const s = setup('drop')
    s.merged(git(s.wt, 'rev-parse', 'HEAD'))
    expect(await s.drop()).toBe('deleted the remote branch task/A-1')
    expect(s.onOrigin()).toBe('')
    expect(await s.drop()).toBeUndefined() // already gone: nothing said
  })

  it('stays after a commit pushed since the merge, a closed PR, an open PR, or with the setting off', async () => {
    const s = setup('keep')
    const merged = git(s.wt, 'rev-parse', 'HEAD')
    expect(await s.drop()).toBe('kept the remote branch task/A-1: no merged PR of it') // closed without a merge
    s.merged(merged)
    git(s.wt, 'commit', '-q', '--allow-empty', '-m', 'later'); git(s.wt, 'push', '-q', 'origin', 'HEAD:task/A-1')
    expect(await s.drop()).toBe(`kept the remote branch task/A-1: commit ${git(s.wt, 'rev-parse', '--short=7', 'HEAD')} was pushed after its merge`)
    s.merged(git(s.wt, 'rev-parse', 'HEAD')); fs.writeFileSync(path.join(s.dir, 'open'), 'https://example.invalid/pr/2\n')
    expect(await s.drop()).toBe('kept the remote branch task/A-1: an open PR uses it (https://example.invalid/pr/2)')
    expect(await s.drop({ on: false })).toBeUndefined()
    expect(s.onOrigin()).not.toBe('')
  })

  it('never touches a protected or base branch', async () => {
    const sh = async () => { throw new Error('no shell') }
    expect(await dropMergedBranch(sh, { worktree: '/w', branch: 'main', guards: g, bases: [], on: true })).toBe('kept the remote branch main: it is a protected branch')
    expect(await dropMergedBranch(sh, { worktree: '/w', branch: 'dev', guards: g, bases: [undefined, 'dev'], on: true })).toBe('kept the remote branch dev: it is a base branch')
  })

  it('asks Bitbucket for its PRs and restrictions, and deletes only at the merged head', async () => {
    const head = 'a'.repeat(40)
    const bb = (o: { open?: boolean, rules?: object[], main?: string } = {}) => {
      const calls: string[] = []
      const sh: ActionDeps['sh'] = async (script, args) => {
        calls.push(args[1]!)
        if (script === SCRIPT.dropBranch) return { code: 0, out: 'bitbucket' }
        if (script === SCRIPT.remoteHead) return { code: 0, out: head }
        if (script === SCRIPT.deleteRef) return { code: 0, out: 'deleted' }
        const [p, q] = [args[2]!, args[3]!]
        const body = p === '' ? { mainbranch: { name: o.main ?? 'main' } }
          : p.startsWith('/branch-restrictions') ? { values: o.rules ?? [] }
            : p === '/branching-model' ? { branch_types: [{ kind: 'release', prefix: 'release/' }] }
              : p.includes('state=OPEN') ? { values: o.open && q.startsWith('q=source') ? [{ state: 'OPEN' }] : [] }
                : { values: [{ state: 'MERGED', source: { commit: { hash: head.slice(0, 12) } } }] }
        return { code: 0, out: `${JSON.stringify(body)}\n200` }
      }
      return { calls, drop: (branch = 'task/A-1') => dropMergedBranch(sh, { worktree: '/w', branch, guards: g, bases: [], on: true }) }
    }
    const ok = bb()
    expect(await ok.drop()).toBe('deleted the remote branch task/A-1')
    expect(ok.calls.at(-1)).toBe('task/A-1')
    // An open PR is asked apart from the merged ones, so a page of merged PRs cannot hide it.
    expect(await bb({ open: true }).drop()).toBe('kept the remote branch task/A-1: an open PR uses it')
    expect(await bb({ main: 'task/A-1' }).drop()).toBe('kept the remote branch task/A-1: it is the repository\'s main branch')
    const locked = 'kept the remote branch task/A-1: a Bitbucket branch restriction forbids deleting it'
    expect(await bb({ rules: [{ branch_match_kind: 'glob', pattern: 'task/*' }] }).drop()).toBe(locked)
    expect(await bb({ rules: [{ branch_match_kind: 'branching_model', branch_type: 'release' }] }).drop('release/1')).toBe(locked.replace(/task\/A-1/, 'release/1'))
    expect(await bb({ rules: [{ branch_match_kind: 'glob', pattern: 'release/*' }] }).drop()).toBe('deleted the remote branch task/A-1')
  })
})
