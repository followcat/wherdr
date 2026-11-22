import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { releaseIdle, wakeReleased } from '../server/utils/pmRelease'
import { chatPolled, forgetTalk, userWrote } from '../server/utils/pmTalk'
import { advanceTick } from '../server/utils/pmAdvance'
import { mechanicTick } from '../server/utils/pmMechanic'
import { forgetMemory } from '../server/utils/pmMemory'
import { askAgentFix } from '../server/utils/pmFix'
import { CODEX_SESSION_SCRIPT, FIX_QUIET_MS, RELEASE_IDLE_MS, RELEASE_TALK_MS, ROOM_WAKE_MS, agentBack, agentsAtWork, fixAskText, fixAskedStep, fixWatch, fixableBlock, handFix, handToAgent, idleSince, releaseDue, retriesAction, roomWanted } from '../shared/pm/release'
import { cardStatus } from '../shared/pm/board'
import { initialState, onEvent, type PlannedStep } from '../shared/pm/steps'
import { wherdr } from '../shared/pm/examples'
import type { Run, Task } from '../shared/pm/run'

const task = (over: Partial<Task> = {}): Task => ({
  id: 'WH-1', project: 'WH', title: 'Fix it', description: '', type: 'simple', state: 'working', createdAt: 0,
  step: { ...initialState(), started: true, at: 1, since: 5, told: 5 }, ...over,
})
const yourTurn = (t = task()) => ({ ...t, step: { ...t.step!, at: 4, yourTurn: { reason: 'action' as const, badge: 'Merge: guarded' } } })

describe('the release rules', () => {
  it('counts idle time only while the task waits for the user and no agent works', () => {
    expect(idleSince(undefined, task(), false, 10)).toBeUndefined() // under way
    expect(idleSince(undefined, yourTurn(), false, 10)).toBe(10)
    expect(idleSince(10, yourTurn(), false, 99)).toBe(10)
    expect(idleSince(10, yourTurn(), true, 99)).toBeUndefined() // its agent works again
    // An agent's question keeps its agent; a failure waits for the user.
    expect(idleSince(undefined, task({ state: 'waiting', waitKind: 'question' }), false, 10)).toBeUndefined()
    expect(idleSince(undefined, task({ state: 'waiting', waiting: 'claude stopped' }), false, 10)).toBe(10)
    const late = task({ step: { ...task().step!, yourTurn: { reason: 'timeout', badge: 'Check work: over 2h' } } })
    expect(idleSince(undefined, late, false, 10)).toBeUndefined() // its agent is to be looked at
    expect(releaseDue(10, 10 + RELEASE_IDLE_MS - 1)).toBe(false)
    expect(releaseDue(10, 10 + RELEASE_IDLE_MS)).toBe('idle')
  })

  it('keeps an agent the user talks to: 30 minutes after their last message, never while its conversation is open, unless memory is short', () => {
    const idle = 0, said = 5 * 60_000
    expect(releaseDue(idle, RELEASE_IDLE_MS, { at: said })).toBe(false)
    expect(releaseDue(idle, said + RELEASE_TALK_MS - 1, { at: said })).toBe(false)
    expect(releaseDue(idle, said + RELEASE_TALK_MS, { at: said })).toBe('idle')
    expect(releaseDue(idle, 10 * RELEASE_TALK_MS, { open: true })).toBe(false)
    // A task waiting to start needs the memory: the grace is cut, the plain 10 minutes apply.
    expect(releaseDue(idle, RELEASE_IDLE_MS, { at: said, open: true }, true)).toBe('cut')
    expect(releaseDue(idle, RELEASE_IDLE_MS - 1, { open: true }, true)).toBe(false)
    const room = 'Waits for room (Home first): standard (≈3.4 GB) fits nowhere — m1: 1.0 GB free'
    expect(roomWanted([{ state: 'todo', held: room }], 'm1')).toBe(true)
    expect(roomWanted([{ state: 'todo', held: room, machine: 'm2' }], 'm1')).toBe(false)
    expect(roomWanted([{ state: 'todo', held: 'paused by the pace' }, { state: 'working', held: room }], 'm1')).toBe(false)
  })

  it('work handed to the agent takes the task out of Your turn until it is in', () => {
    const sent = { ...yourTurn(), step: handToAgent(yourTurn().step!, 'catch-up', 'abc', 7) }
    expect(sent.step.yourTurn).toBeUndefined()
    expect(idleSince(10, sent, false, 99)).toBeUndefined() // never released while the engine waits for it
    expect(cardStatus({ plan: [], state: sent.step })).toEqual({ text: 'the agent is updating the PR', tone: 'wait' })
    expect(agentBack(sent.step)).toEqual(yourTurn().step) // pushed or reported: the merge is the user's again
  })

  it('a failed step action handed over with a fix is tried again once fixed, and comes back if not', () => {
    const plan: PlannedStep[] = [
      { id: 'work', holder: 'worker', ends: 'report', text: '' },
      { id: 'pr', ends: 'action', action: { kind: 'github.pr', base: 'main' }, text: '' },
    ]
    const failed = { ...initialState(), started: true, at: 1, yourTurn: { reason: 'action' as const, badge: 'pr: push refused', error: 'push refused' } }
    expect(handFix(plan, { ...failed, yourTurn: { reason: 'user', badge: 'Merge' } }, 'machine', 7)).toBeUndefined() // only a failed action
    // tell --fix: out of Your turn, the card says the agent fixes it.
    const fixing = handFix(plan, failed, 'machine', 7)!
    expect(fixing.yourTurn).toBeUndefined()
    expect(retriesAction(plan, fixing)).toBe(true)
    expect(cardStatus({ plan, state: fixing })?.text).toBe('the agent is fixing it')
    // Its done report: the engine tries the action again itself (agentBack, then the engine's 'user' event).
    const retried = onEvent(plan, agentBack(fixing), { kind: 'user', engine: true }, 8)
    expect(retried.state.acting).toBe(true)
    expect(retried.effects).toContainEqual(expect.objectContaining({ kind: 'action', step: 'pr' }))
    // Failing again: back in Your turn, with the new reason.
    const again = onEvent(plan, retried.state, { kind: 'action-result', ok: false, error: 'no PR opened' }, 9).state
    expect(again.yourTurn).toMatchObject({ reason: 'action', error: 'no PR opened' })
    // Stopped without a report: kept while working or briefly idle, back once quiet, or at once when ended.
    expect(fixWatch(plan, fixing, 'working', 8)).toBeUndefined()
    const quiet = fixWatch(plan, fixing, 'idle', 8)!
    expect(quiet.agent?.idle).toBe(8)
    expect(fixWatch(plan, quiet, 'idle', 8 + FIX_QUIET_MS - 1)).toBeUndefined()
    expect(fixWatch(plan, quiet, 'working', 9)?.agent?.idle).toBeUndefined()
    expect(fixWatch(plan, quiet, 'idle', 8 + FIX_QUIET_MS)).toMatchObject({ yourTurn: { reason: 'action', error: 'fix machine: the agent stopped without saying it is done' } })
    expect(fixWatch(plan, quiet, 'idle', 8 + FIX_QUIET_MS)?.agent).toBeUndefined()
    expect(fixWatch(plan, fixing, 'gone', 8)?.yourTurn?.error).toBe('fix machine: the agent ended without saying it is done')
  })

  it('the machine cap counts only agents holding a step under way', () => {
    const run = (id: string, t: string, role: Run['role'] = 'worker'): Run => ({ id, task: t, role, program: 'claude', model: 'm', machine: 'm1', worktree: '/w', branch: 'b', instructions: '/i', attempt: 1, state: 'running', startedAt: 1 })
    const tasks = [task(), yourTurn(task({ id: 'WH-2' })), task({ id: 'WH-3', step: { ...task().step!, at: 3 } })]
    const holder = (t: Task) => (t.step!.at === 3 ? 'reviewer' : 'worker')
    // WH-1's worker works; WH-2 waits for the user; WH-3 is in review: its idle worker does not count.
    const runs = [run('a', 'WH-1'), run('b', 'WH-2'), run('c', 'WH-2', 'reviewer'), run('d', 'WH-3'), run('e', 'WH-3', 'reviewer'), { ...run('f', 'WH-1'), machine: 'm2' }]
    expect(agentsAtWork(runs, tasks, 'm1', holder)).toHaveLength(2)
  })
})

describe('release and restart on the server', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-release-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  async function setup() {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(wherdr)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/home/u/wh', template: 'wherdr' }, async (_m, p) => p)
    await store.addTask({ project: 'WH', title: 'Fix it', type: 'simple' })
    const calls: [string, Record<string, unknown>][] = [], files: Record<string, string> = {}
    const call = async (method: string, p: Record<string, unknown>) => {
      calls.push([method, p])
      if (method === 'machine.exec') {
        const [, , script, , ...args] = p.argv as string[]
        if (script!.includes('command -v')) return { code: 0, stdout: Buffer.from('claude').toString('base64') }
        if (script!.includes('$HOME')) return { code: 0, stdout: Buffer.from('/home/u').toString('base64') }
        if (p.input) files[args[0]!] = Buffer.from(p.input as string, 'base64').toString()
        return { code: 0, stdout: '' }
      }
      if (method === 'terminal.run') return { address: `m1/t${calls.filter(c => c[0] === 'terminal.run').length}` }
      if (method === 'terminal.list') return { terminals: [{ address: 'm1/t1', labels: {}, state: 'running', status: { state: 'idle' } }] }
      if (['terminal.get', 'terminal.kill', 'terminal.label', 'terminal.send'].includes(method)) return { state: 'running' }
      throw new Error(`unexpected ${method}`)
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    await startTask(deps, 'WH-1')
    await store.saveTask(yourTurn((await store.task('WH-1'))!))
    return { store, calls, files, deps }
  }

  it('ends the idle agents of a task waiting for the user, then starts the worker again on a send-back', async () => {
    const { store, calls, files, deps } = await setup()

    expect(await releaseIdle(deps, 0)).toEqual([])
    // The user wrote to it, then its conversation stays open: kept.
    userWrote('m1/t1', 0)
    chatPolled('m1/t1', RELEASE_TALK_MS)
    expect(await releaseIdle(deps, RELEASE_TALK_MS)).toEqual([])
    forgetTalk('m1/t1')
    expect(await releaseIdle(deps, RELEASE_IDLE_MS)).toEqual(['WH-1'])
    expect(calls.filter(c => c[0] === 'terminal.kill')).toEqual([['terminal.kill', { terminal: 'm1/t1' }]])
    expect((await store.runs())[0]).toMatchObject({ state: 'ended', endedBy: 'released' })
    const t = (await store.task('WH-1'))!
    expect(t).toMatchObject({ state: 'working', step: { yourTurn: { badge: 'Merge: guarded' } } }) // the board shows it as before
    expect(t.log!.slice(-2).map(e => e.text)).toEqual([
      'released its agents: idle for 10 minutes while the task waits for you; they start again when it needs them, or when you open the worker\'s conversation',
      'ended the worker (claude claude-opus-5-5) to free memory; its worktree stays',
    ])

    // Sent back to the worker: a new one in the same worktree, with the handover and what to fix.
    const finding = { id: 'no-test', severity: 'major' as const, title: 'No test', proof: '0 tests' }
    await store.saveTask({ ...t, step: { ...t.step!, at: 1, since: 50, told: undefined, yourTurn: undefined, backFrom: 'review', reviews: { review: [{ findings: [finding] }] } } })
    await advanceTick(deps)
    const runs = calls.filter(c => c[0] === 'terminal.run')
    expect(runs).toHaveLength(2)
    expect(runs[1]![1]).toMatchObject({ cwd: '/home/u/.wherdr/pm/worktrees/WH-1' })
    // The report is copied before the revive: the round's section adds to it (parseRead).
    const copy = calls.findIndex(c => c[0] === 'machine.exec' && String((c[1].argv as string[])[2]).includes('cp -f') && (c[1].argv as string[]).includes('/home/u/.wherdr/pm/tasks/WH-1/report.before.md'))
    expect(copy).toBeGreaterThan(-1)
    expect(copy).toBeLessThan(calls.indexOf(runs[1]!))
    expect(files['/home/u/.wherdr/pm/tasks/WH-1/instructions.md']).toMatch(/## Handover[\s\S]*idle for 10 minutes[\s\S]*No test/)
    const back = (await store.task('WH-1'))!
    expect(back.step).toMatchObject({ at: 1, told: 50 }) // the handover gave it: not sent again
    expect(back.log!.at(-1)!.text).toBe('started the worker again in its worktree: work needs it')
    expect(calls.some(c => c[0] === 'terminal.send')).toBe(false)
  })

  it('opening a released worker starts it again with its conversation, sending it nothing', async () => {
    const { store, calls, deps } = await setup()
    await releaseIdle(deps, 0)
    await expect(wakeReleased(deps, 'WH-1')).rejects.toThrow('not released')
    expect(await releaseIdle(deps, RELEASE_IDLE_MS)).toEqual(['WH-1'])
    const ended = (await store.runs())[0]!
    expect(ended.endedAt).toBeTypeOf('number')
    const t = await wakeReleased(deps, 'WH-1')
    expect(t.state).toBe('working')
    const line = String(calls.filter(c => c[0] === 'terminal.run')[1]![1].line)
    expect(line.endsWith(`'--resume' '${ended.session}'`)).toBe(true)
    expect(t.log!.at(-1)!.text).toBe('started the worker again in its worktree: the user opened its conversation')
  })
})

describe('a released Codex worker\'s conversation', () => {
  it('is the newest rollout whose first message reads the worker\'s instructions, not its reviewer\'s', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-codex-'))
    const day = path.join(home, 'sessions/2026/01/02')
    await fs.mkdir(day, { recursive: true })
    const id = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`
    const rollout = (at: string, n: number, file: string) => fs.writeFile(path.join(day, `rollout-2026-01-02T${at}-${id(n)}.jsonl`), `{"type":"session_meta"}\n{"type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Read ${file} and follow it."}]}}\n`)
    await rollout('10-00-00', 1, '/t/W-1/instructions.md') // an earlier worker conversation
    await rollout('11-00-00', 2, '/t/W-1/instructions.md')
    await rollout('12-00-00', 3, '/t/W-1/review.md')
    const find = (file: string) => execFileSync('sh', ['-c', CODEX_SESSION_SCRIPT, 'sh', file, '60'], { env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8' }).trim()
    expect(find('/t/W-1/instructions.md')).toBe(id(2))
    expect(find('/t/W-2/instructions.md')).toBe('')
    await fs.rm(home, { recursive: true, force: true })
  })
})

describe('work the engine handed the worker', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-handed-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  // A visual task at its merge step, the user's turn, its PR at prHead and in conflict with v3.
  async function setup() {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(wherdr)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/home/u/wh', template: 'wherdr' }, async (_m, p) => p)
    await store.addTask({ project: 'WH', title: 'Fix it', type: 'visual' })
    const env = { head: 'abc1234', prHead: 'abc1234', merge: { code: 3, out: 'conflict with v3 in a.ts' }, push: { code: 0, out: '' }, calls: [] as [string, Record<string, unknown>][],
      pr: { mergeStateStatus: 'DIRTY', statusCheckRollup: [] as unknown[] }, online: true, finished: [] as string[], capacity: '' }
    const out = (code: number, text: string) => ({ code, stdout: Buffer.from(text).toString('base64') })
    const call = async (method: string, p: Record<string, unknown>) => {
      env.calls.push([method, p])
      if (method === 'machine.exec') {
        const script = (p.argv as string[])[2]!
        if (script.includes('gh pr list --head')) return out(0, `${env.head}\n${JSON.stringify([{ url: 'https://github.com/o/r/pull/9', baseRefName: 'v3', headRefOid: env.prHead, ...env.pr }])}`)
        if (script.includes('merge -q --no-edit')) return out(env.merge.code, env.merge.out)
        if (script.includes('ls-remote')) return out(env.push.code, env.push.out)
        if (script.includes('uname -s')) return out(0, env.capacity)
        if (script.includes('command -v')) return out(0, 'claude')
        if (script.includes('$HOME')) return out(0, '/home/u')
        return out(0, '')
      }
      if (method === 'terminal.run') return { address: `m1/t${env.calls.filter(c => c[0] === 'terminal.run').length}` }
      if (method === 'terminal.list') return { terminals: [{ address: 'm1/t1', labels: {}, state: 'running', status: { state: 'idle' } }] }
      return { state: env.finished.includes(String(p.terminal)) ? 'finished' : 'running' }
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: env.online ? 'online' : 'offline' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    await startTask(deps, 'WH-1')
    const t = (await store.task('WH-1'))!, plan = (await store.workflow('WH'))!.taskTypes.visual!.steps
    const at = plan.findIndex(x => typeof x !== 'string' && x.id === 'merge')
    await store.saveTask({ ...t, step: { ...t.step!, at, since: 5, told: 5, yourTurn: { reason: 'user', badge: 'Look at the screenshots, then merge' } } })
    return { store, deps, env, log: async () => (await store.task('WH-1'))!.log!.map(e => e.text) }
  }

  it('a catch-up sent to the agent keeps its agents, then the pushed resolution is checked and reviewed again', async () => {
    const { store, deps, env, log } = await setup()
    await mechanicTick(deps, 0)
    expect(env.calls.some(c => c[0] === 'terminal.send' && /Merge origin\/v3/.test(String(c[1].text)))).toBe(true)
    const sent = (await store.task('WH-1'))!.step!
    expect(sent.yourTurn).toBeUndefined()
    expect(sent.agent).toMatchObject({ kind: 'catch-up', head: 'abc1234' })
    expect(await releaseIdle(deps, 3 * RELEASE_IDLE_MS)).toEqual([])
    // Pushed: the engine checks the PR again; clean now, the resolution is reviewed before the user's turn.
    env.head = env.prHead = 'def5678'
    env.merge = { code: 0, out: 'def5678' }
    await mechanicTick(deps, 4 * RELEASE_IDLE_MS)
    const t = (await store.task('WH-1'))!
    expect(t.step!.agent).toBeUndefined()
    expect(t.step!.catchUp).toBeUndefined()
    expect(t.step!.rereview).toEqual({ since: 'abc1234', head: 'def5678' })
    expect(await log()).toContain('catch-up: the worker pushed it')
  })

  it('pushes committed work before releasing, keeps the agents when it cannot, and restarts the worker on a catch-up', async () => {
    const { store, deps, env, log } = await setup()
    env.prHead = 'def5678' // no catch-up yet: the PR head is not the task's commit
    env.push = { code: 1, out: 'rejected: fetch first' }
    expect(await releaseIdle(deps, 0)).toEqual([])
    expect(await releaseIdle(deps, RELEASE_IDLE_MS)).toEqual([])
    expect(await log()).toContain('kept its agents: could not push the branch\'s unpushed commits (rejected: fetch first)')
    expect(env.calls.some(c => c[0] === 'terminal.kill')).toBe(false)
    env.push = { code: 0, out: 'pushed' }
    expect(await releaseIdle(deps, 2 * RELEASE_IDLE_MS)).toEqual(['WH-1'])
    expect((await log()).slice(-3, -1)).toEqual(['pushed the branch\'s unpushed commits before releasing its agents', 'released its agents: idle for 10 minutes while the task waits for you; they start again when it needs them, or when you open the worker\'s conversation'])

    // The engine needs the worker again: started in its worktree, told what to do, the board says it updates the PR.
    env.prHead = 'abc1234'
    await mechanicTick(deps, 3 * RELEASE_IDLE_MS)
    expect(env.calls.filter(c => c[0] === 'terminal.run')).toHaveLength(2)
    const t = (await store.task('WH-1'))!
    expect(t.step!.yourTurn).toBeUndefined()
    expect(t.step!.agent).toMatchObject({ kind: 'catch-up' })
    expect(await log()).toContain('catch-up: started the worker again with it')
    expect(cardStatus({ plan: [], state: t.step })?.text).toBe('the agent is updating the PR')
  })
  // Its PR clean but its smoke check red: the fix goes to the worker.
  const redSmoke = (env: Awaited<ReturnType<typeof setup>>['env']) => { env.pr = { mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'smoke', status: 'COMPLETED', conclusion: 'FAILURE' }] } }
  const sentTexts = (env: Awaited<ReturnType<typeof setup>>['env']) => env.calls.filter(c => c[0] === 'terminal.send').map(c => String(c[1].text))

  it('a conflict at the merge step starts again a worker a stop ended once the task goes on', async () => {
    const { store, deps, env, log } = await setup()
    await store.saveRun({ ...(await store.runs())[0]!, state: 'ended', endedBy: 'stopped' }) // stopped, then started again: held by nobody
    await mechanicTick(deps, 0)
    expect(env.calls.filter(c => c[0] === 'terminal.run')).toHaveLength(2)
    expect(await log()).toContain('catch-up: started the worker again with it')
    expect((await store.task('WH-1'))!.step!.agent).toMatchObject({ kind: 'catch-up', text: expect.stringContaining('Merge origin/v3') })
  })

  it('the user\'s Send back at the merge step starts again a worker that ended', async () => {
    const { store, deps, env, log } = await setup()
    await store.saveRun({ ...(await store.runs())[0]!, state: 'ended', endedBy: 'stopped' })
    const t = (await store.task('WH-1'))!, plan = (await store.workflow('WH'))!
    const { taskPlan } = await import('../shared/pm/run')
    await store.saveTask({ ...t, step: onEvent(taskPlan(plan, t), t.step!, { kind: 'back', note: 'make the button blue' }, 50).state })
    await advanceTick(deps)
    expect(env.calls.filter(c => c[0] === 'terminal.run')).toHaveLength(2)
    expect((await log()).at(-1)).toMatch(/^started the worker again in its worktree: \w+ needs it$/)
  })

  it('a CI fix sent to a worker that ended starts it again with that fix', async () => {
    const { store, deps, env, log } = await setup()
    redSmoke(env)
    await store.saveRun({ ...(await store.runs())[0]!, state: 'ended', endedBy: 'exit' }) // its session ended
    await mechanicTick(deps, 0)
    expect(env.calls.filter(c => c[0] === 'terminal.run')).toHaveLength(2)
    expect(sentTexts(env)).toEqual([])
    expect(await log()).toContain('ci-to-agent: started the worker again with it')
    const t = (await store.task('WH-1'))!
    expect(t.step!.agent).toMatchObject({ kind: 'ci-to-agent', text: expect.stringContaining('CI failed on smoke') })
    expect(cardStatus({ plan: [], state: t.step })?.text).toBe('the agent is updating the PR')
  })

  it('a worker whose machine goes offline: the status says why, no wake; back online and ended, it starts again; ended again, the coordinator is woken', async () => {
    const { store, deps, env, log } = await setup()
    await store.saveCoordinator({ project: 'WH', tokenHash: '', terminal: 'm1/c', autopilot: { on: true, goal: '', events: ['stuck'], perDay: null, atOnce: null } })
    redSmoke(env)
    await mechanicTick(deps, 0)
    expect(sentTexts(env).some(x => x.includes('CI failed on smoke'))).toBe(true)
    // Its machine offline: the task says it waits for it; no wake (the incident covers it), the skip noted.
    env.online = false
    await mechanicTick(deps, 60_000)
    await mechanicTick(deps, 120_000)
    let t = (await store.task('WH-1'))!
    expect(cardStatus({ plan: [], state: t.step })).toEqual({ text: 'Waits for its machine (offline)', tone: 'bad' })
    expect(await log()).toContain('ci-to-agent: Waits for its machine (offline). No wake: the engine goes on once the machine is back.')
    expect(await store.wakes()).toEqual([])
    expect((await store.coordinator('WH'))!.skips).toEqual([{ at: 60_000, what: 'engine', why: 'WH-1 (Fix it): ci-to-agent handed to its worker, which waits for its machine (offline).' }])
    // Back online, its agent gone: started again with the fix, the status clears.
    env.online = true
    env.finished.push('m1/t1')
    await mechanicTick(deps, 180_000)
    t = (await store.task('WH-1'))!
    expect(env.calls.filter(c => c[0] === 'terminal.run')).toHaveLength(2)
    expect(t.step!.agent).toMatchObject({ kind: 'ci-to-agent', revived: 180_000 })
    expect(t.step!.agent!.waits).toBeUndefined()
    expect(cardStatus({ plan: [], state: t.step })?.text).toBe('the agent is updating the PR')
    // The resume fails (its new agent ends at once): now the coordinator is woken.
    env.finished.push('m1/t2')
    await mechanicTick(deps, 240_000)
    expect((await store.wakes()).filter(w => w.reasons.some(r => r.includes('which cannot do it')))).toHaveLength(1)
  })
  it('a CI fix waiting for room on its machine: the status says so, and the coordinator is woken once, only after 30 minutes', async () => {
    const { store, deps, env, log } = await setup()
    await store.saveCoordinator({ project: 'WH', tokenHash: '', terminal: 'm1/c', autopilot: { on: true, goal: '', events: ['stuck'], perDay: null, atOnce: null } })
    redSmoke(env)
    // Another task's worker on m1, which has 6 GB and 1 GB free: no room for this one.
    const other = await store.addTask({ project: 'WH', title: 'Other', type: 'simple' })
    await store.saveTask({ ...other, state: 'working', step: { ...initialState(), started: true, at: 1 } })
    await store.saveRun({ ...(await store.runs())[0]!, id: 'r-other', task: other.id, terminal: 'm1/other' })
    await store.saveRun({ ...(await store.runs()).find(r => r.task === 'WH-1')!, state: 'ended', endedBy: 'exit' })
    env.capacity = `MemTotal: ${6 * 1024 * 1024} kB\nMemFree: 1 kB\nMemAvailable: ${1024 * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`
    forgetMemory('m1')
    // The engine's wakes about WH-1 (not the incident wake about the other worker's fake terminal).
    const wakes = async () => (await store.wakes()).filter(w => w.kind !== 'incident' && w.reasons.some(r => r.includes('WH-1'))).length
    await mechanicTick(deps, 0)
    await mechanicTick(deps, 60_000)
    const t = (await store.task('WH-1'))!
    expect(t.step!.agent).toMatchObject({ kind: 'ci-to-agent', waits: expect.stringMatching(/^Waits for room/) })
    expect(cardStatus({ plan: [], state: t.step })?.tone).toBe('bad')
    expect(await log()).toContain(`ci-to-agent: ${t.step!.agent!.waits}. The coordinator is woken if that lasts 30 minutes.`)
    expect(await wakes()).toBe(0)
    await mechanicTick(deps, ROOM_WAKE_MS - 1)
    expect(await wakes()).toBe(0)
    await mechanicTick(deps, ROOM_WAKE_MS + 1)
    await mechanicTick(deps, ROOM_WAKE_MS + 60_000)
    expect(await wakes()).toBe(1)
    expect((await store.wakes()).find(w => w.kind !== 'incident')!.reasons.join(' ')).toContain('which has waited 30 minutes for room on its machine')
  })
  it('a CI fix for a worker that ended on a machine paused for the project: it waits for its machine, no wake', async () => {
    const { store, deps, env, log } = await setup()
    await store.saveCoordinator({ project: 'WH', tokenHash: '', terminal: 'm1/c', autopilot: { on: true, goal: '', events: ['stuck'], perDay: null, atOnce: null } })
    redSmoke(env)
    await store.updateProject('WH', { paused: ['m1'] })
    await store.saveRun({ ...(await store.runs())[0]!, state: 'ended', endedBy: 'exit' })
    await mechanicTick(deps, 0)
    await mechanicTick(deps, 60_000)
    expect(env.calls.filter(c => c[0] === 'terminal.run')).toHaveLength(1) // never started there again
    const t = (await store.task('WH-1'))!
    expect(cardStatus({ plan: [], state: t.step })).toEqual({ text: 'Waits for its machine (paused)', tone: 'bad' })
    expect(await log()).toContain('ci-to-agent: Waits for its machine (paused). No wake: the engine goes on once the machine is back.')
    expect(await store.wakes()).toEqual([])
  })
})

describe('ask the agent to fix it', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-fix-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  it('names the block its worker could fix, and takes the step out of Your turn', () => {
    const plan: PlannedStep[] = [{ id: 'work', holder: 'worker', ends: 'report', text: '', timeout: '2h' }, { id: 'merge', ends: 'action', action: { kind: 'github.merge' }, text: '' }]
    const at = (s: Partial<Task['step']>, over: Partial<Task> = {}) => task({ step: { ...task().step!, ...s }, ...over })
    const refused = at({ at: 1, yourTurn: { reason: 'action', badge: 'Merge: conflict', error: 'The PR conflicts with v3' } })
    expect(fixableBlock(refused)).toBe('The PR conflicts with v3')
    // Refused outside the code (herdr-core, the network): nothing for its agent.
    expect(fixableBlock(at({ at: 1, yourTurn: { reason: 'action', badge: 'Merge: x', error: 'merge: herdr-core rejected the request (unavailable)' } }))).toBeUndefined()
    expect(fixableBlock(at({ yourTurn: { reason: 'timeout', badge: 'Check work: over 2h' } }))).toBe('Check work: over 2h')
    expect(fixableBlock(task({ state: 'waiting', waiting: 'claude stopped' }))).toBe('claude stopped')
    // A stall (an idle worker, red CI with no new push): the board's own words.
    expect(fixableBlock(task(), { cause: 'red:abc', reason: 'CI red, no new push for 10 min', since: 1 })).toBe('Stalled: CI red, no new push for 10 min')
    expect(fixableBlock(task())).toBeUndefined()
    // Nothing for its agent: a question, a step of the user's, a stop.
    expect(fixableBlock(task({ state: 'waiting', waiting: 'A question', waitKind: 'question' }))).toBeUndefined()
    expect(fixableBlock(at({ yourTurn: { reason: 'user', badge: 'Merge' } }))).toBeUndefined()
    expect(fixableBlock({ ...refused, stopped: { by: 'the user', why: 'x', at: 1 } })).toBeUndefined()
    expect(fixAskText('The PR conflicts with v3')).toMatch(/The PR conflicts with v3[\s\S]*merge the base[\s\S]*wherdr\.report=done[\s\S]*one clear question with choices/)
    // A failed action: handed over (the agent is fixing it); over its time limit: its time again.
    expect(fixAskedStep(plan, refused.step!, 7)).toMatchObject({ yourTurn: undefined, agent: { kind: 'fix block', at: 7 } })
    expect(fixAskedStep(plan, at({ at: 0, yourTurn: { reason: 'timeout', badge: 'x' } }).step!, 7)).toMatchObject({ yourTurn: undefined, deadline: 7 + 2 * 3_600_000 })
  })

  it('starts an ended worker again with the block\'s reason, logged as the user\'s', async () => {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(wherdr)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/home/u/wh', template: 'wherdr' }, async (_m, p) => p)
    await store.addTask({ project: 'WH', title: 'Fix it', type: 'simple' })
    const calls: string[] = [], files: Record<string, string> = {}
    const call = async (method: string, p: Record<string, unknown>) => {
      calls.push(method)
      if (method === 'machine.exec') {
        const [, , script, , ...args] = p.argv as string[]
        if (script!.includes('command -v')) return { code: 0, stdout: Buffer.from('claude').toString('base64') }
        if (script!.includes('$HOME')) return { code: 0, stdout: Buffer.from('/home/u').toString('base64') }
        if (p.input) files[args[0]!] = Buffer.from(p.input as string, 'base64').toString()
        return { code: 0, stdout: '' }
      }
      if (method === 'terminal.run') return { address: `m1/t${calls.filter(c => c === 'terminal.run').length}` }
      return { state: 'running' }
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    await startTask(deps, 'WH-1')
    const plan = (await store.workflow('WH'))!.taskTypes.simple!.steps
    const at = plan.findIndex(x => typeof x !== 'string' && x.id === 'merge')
    const badge = 'Merge: The PR conflicts with its target branch'
    await store.saveTask({ ...(await store.task('WH-1'))!, step: { ...task().step!, at, yourTurn: { reason: 'action', badge, error: 'The PR conflicts with v3' } } })
    await store.saveRun({ ...(await store.runs())[0]!, state: 'ended', endedBy: 'exit' })

    const t = await askAgentFix(deps, 'WH-1')
    expect(calls.filter(c => c === 'terminal.run')).toHaveLength(2) // started again
    expect(files['/home/u/.wherdr/pm/tasks/WH-1/instructions.md']).toMatch(/What to do now:[\s\S]*The PR conflicts with v3[\s\S]*one clear question/)
    expect(t).toMatchObject({ state: 'working', step: { yourTurn: undefined, agent: { kind: 'fix block' } } })
    expect(t.log!.at(-1)).toMatchObject({ by: 'user', text: 'asked the agent to fix: The PR conflicts with v3' })
    // Its agent at work on it: nothing left to fix.
    await expect(askAgentFix(deps, 'WH-1')).rejects.toThrow('nothing its agent can fix')

    // A worker idle at its step (a stall, no Your turn of the step's): told, the stall's clock starts again.
    const work = plan.findIndex(x => (typeof x === 'string' ? x : x.id) === 'work')
    const stall = { cause: `idle:${work}:5`, reason: 'The worker stopped before saying it is done', since: 6 }
    await store.saveRun({ ...(await store.runs()).at(-1)!, state: 'running' })
    await store.saveTask({ ...(await store.task('WH-1'))!, state: 'working', idle: 1, stall, stalls: { [stall.cause]: { since: 6 } }, step: { ...task().step!, at: work, since: 5, told: 5 } })
    const before = Date.now()
    const idle = await askAgentFix(deps, 'WH-1')
    expect(calls.filter(c => c === 'terminal.send')).toHaveLength(1)
    expect(idle.stall!.since).toBeGreaterThanOrEqual(before)
    expect(idle.stalls![stall.cause]!.back).toBeGreaterThanOrEqual(before)
    expect(idle.log!.slice(-2).map(e => e.text)).toEqual(['asked the agent to fix: Stalled: The worker stopped before saying it is done', 'back to work: the user asked the agent to fix it'])
  })
})
