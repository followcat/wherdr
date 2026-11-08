import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SCRIPT, guardAction, isTransient, leaks, prReady, taskGuards, type Receipt } from '../shared/pm/actions'
import { runAction, type ActionDeps, type ActionJob } from '../server/utils/pmActions'
import { WORKTREE_SCRIPT } from '../server/utils/pmLaunch'
import { initialState, onEvent, planSteps, reviewedCommit } from '../shared/pm/steps'
import { dueText } from '../shared/pm/advance'
import { github } from '../shared/pm/examples'
import type { Template } from '../shared/pm/workflow'

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
    const r = await runAction(f.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))
    expect(r).toEqual({ ok: true, link: 'https://pr/1', commit: 'abc', alert: 'A-1\'s commit abc is on main without a step of yours' })
    expect(f.sleeps).toEqual([60_000])
    expect(f.calls[4]).toEqual(['/w', 'https://pr/1', 'abc', '']) // no method: the first the repo allows
    const p = fakeDeps([info('COMPLETED', 'main')])
    expect(await runAction(p.deps, job({ step: 'merge', action: { kind: 'github.merge' } }))).toMatchObject({ error: expect.stringMatching(/only you/) })
    expect(p.calls.length).toBe(1)
    // Stopped while its checks ran: never merged.
    const h = fakeDeps([info('QUEUED'), { code: 0, out: 'same' }, info('COMPLETED'), { code: 0, out: 'same' }])
    expect(await runAction(h.deps, job({ step: 'merge', action: { kind: 'github.merge' }, halted: async () => true }))).toEqual({ ok: false, error: 'merge: the task was stopped' })
    expect(h.calls.length).toBe(4)
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
    return { repo, wt, merged, verify, theirs, work }
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
  *"--state open"*" -q "*) ;;
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
    expect(await s.go('merge', { kind: 'github.merge' })).toEqual({ ok: true, link: 'https://pr/1', commit: head, note: 'already merged on GitHub' })
    // Merged by hand at a head without the task's commit (a later local commit):
    // the step ends merged, recording what GitHub merged, and says what it left out.
    const at = 'f'.repeat(40)
    fs.writeFileSync(s.merged, `${at} https://pr/1\n`)
    expect(await s.go('merge', { kind: 'github.merge' }, 2)).toEqual({ ok: true, link: 'https://pr/1', commit: at, note: `already merged on GitHub at fffffff, without the task's commit ${head.slice(0, 7)}`,
      alert: `A-1's commit ${head.slice(0, 7)} was not merged: its PR was merged on GitHub at fffffff without it. Its later commits need a new branch` })
    // Merged into protected main outside your gesture: recorded, with the alert.
    fs.writeFileSync(s.merged, `${head} https://pr/1 main\n`)
    git(s.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main')
    expect(await s.go('merge', { kind: 'github.merge' }, 3)).toMatchObject({ ok: true, alert: 'A-1\'s commit ' + head.slice(0, 7) + ' is on main without a step of yours' })
    // Your gesture: main is yours to merge, no alert.
    expect(await s.go('merge', { kind: 'github.merge' }, 4, 'user')).toEqual({ ok: true, link: 'https://pr/1', commit: head, note: 'already merged on GitHub' })
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
  *"--state open"*) echo "[{\\"url\\":\\"https://pr/1\\",\\"baseRefName\\":\\"dev\\",\\"headRefOid\\":\\"$(git --git-dir "${origin}" rev-parse task/A-1)\\"}]";;
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
    return { repo, origin, sh, merge, elsewhere, head: () => git(repo, 'rev-parse', 'HEAD') }
  }

  it('after a catch-up push, goes back to review for the new head, then merges it', async () => {
    const s = setup('moved-catchup'), reviewed = s.head()
    s.elsewhere('theirs', 'dev')
    expect((await s.sh(SCRIPT.catchUp, [s.repo, 'dev', 'task/A-1'])).code).toBe(0)
    const caught = s.head()
    expect(await s.merge(1, reviewed)).toEqual({ ok: false, error: `merge: new commits since the review (${reviewed.slice(0, 7)}..${caught.slice(0, 7)})`, review: { since: reviewed, head: caught }, commit: caught })
    expect(await s.merge(2, caught)).toEqual({ ok: true, link: 'https://pr/1', commit: caught })
  })

  it('after a CI fix committed but not pushed, has it reviewed, pushes it, then merges', async () => {
    const s = setup('moved-cifix'), reviewed = s.head()
    git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'fix CI')
    const fix = s.head()
    expect(await s.merge(1, reviewed)).toMatchObject({ ok: false, review: { since: reviewed, head: fix }, commit: fix })
    expect(await s.merge(2, fix)).toEqual({ ok: true, link: 'https://pr/1', commit: fix })
    expect(git(s.repo, '--git-dir', s.origin, 'rev-parse', 'task/A-1')).toBe(fix)
  })

  it('refuses a head pushed from outside the task\'s worktree', async () => {
    const s = setup('moved-foreign'), reviewed = s.head()
    s.elsewhere('foreign', 'task/A-1')
    expect(await s.merge(1, reviewed)).toEqual({ ok: false, error: expect.stringMatching(/^merge: the PR head [0-9a-f]{7} has commits the task's worktree never had/) })
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
