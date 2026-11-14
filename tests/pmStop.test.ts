import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { resumeTask, stopTask } from '../server/utils/pmStop'
import { archivedStep, doneTurnRepair, handoverText, removeRefusal, resumeRefusal, stopRefusal, stoppedTask } from '../shared/pm/stop'
import { chainState, dueText } from '../shared/pm/advance'
import { decisionsOf } from '../shared/pm/decisions'
import { canStop, cardOf } from '../shared/pm/board'
import { parseCommand } from '../shared/pm/coordinator'
import { initialState, onEvent, planSteps } from '../shared/pm/steps'
import { wherdr } from '../shared/pm/examples'
import { taskEvents } from '../shared/pm/automations'
import { DEFAULT_AUTOPILOT, autopilotEvents } from '../shared/pm/autopilot'
import type { Task } from '../shared/pm/run'

const plan = planSteps(wherdr, { type: 'simple' }) // todo, work, pr, review, merge, done
const working = (over: Partial<Task> = {}): Task => ({
  id: 'WH-1', project: 'WH', title: 'Fix it', description: '', type: 'simple', state: 'working', createdAt: 0,
  step: { ...initialState(), started: true, at: 1, since: 5, told: 5 }, ...over,
})
const user = { who: 'user' } as const
const inTurn = { who: 'coordinator', wake: false } as const
const inWake = { who: 'coordinator', wake: true } as const
const stop = (t: Task, by = 'the user') => stoppedTask(t, { by, why: 'loops on the same test', at: 9 })

describe('who may stop', () => {
  it('the user and the coordinator in a user turn stop any started task; in a wake, only the autopilot\'s own', () => {
    expect(stopRefusal(working(), user)).toBeUndefined()
    expect(stopRefusal(working(), inTurn)).toBeUndefined()
    expect(stopRefusal(working(), inWake)).toMatch(/only the tasks your autopilot started/)
    expect(stopRefusal(working({ autopilot: true }), inWake)).toBeUndefined()
    // Added by an automation the user set up, not started by the coordinator in a wake: the user's.
    expect(stopRefusal(working({ auto: 'nightly' }), inWake)).toMatch(/only the tasks your autopilot started/)
    // Waiting on a question still holds an agent: it may be stopped.
    expect(stopRefusal(working({ state: 'waiting', waitKind: 'question' }), user)).toBeUndefined()
  })

  it('refuses a task not started, done or already stopped', () => {
    expect(stopRefusal(working({ state: 'todo', step: undefined }), user)).toMatch(/not started/)
    expect(stopRefusal(working({ step: { ...working().step!, done: true } }), user)).toMatch(/is done/)
    expect(stopRefusal(stop(working()), user)).toMatch(/already stopped/)
  })

  it('the coordinator only continues, and in a wake not what the user stopped', () => {
    const own = stop(working({ autopilot: true }), 'the coordinator')
    expect(resumeRefusal(own, 'continue', inWake, plan[1])).toBeUndefined()
    expect(resumeRefusal(stop(working({ autopilot: true })), 'continue', inWake, plan[1])).toMatch(/stopped by the user/)
    expect(resumeRefusal(stop(working()), 'continue', inTurn, plan[1])).toBeUndefined()
    expect(resumeRefusal(stop(working()), 'as-is', inTurn, plan[1])).toMatch(/the user's/)
    expect(resumeRefusal(working(), 'continue', user, plan[1])).toMatch(/not stopped/)
  })
})

describe('who may remove', () => {
  const todo = (over: Partial<Task> = {}) => working({ state: 'todo', step: undefined, ...over })
  it('only a task never started; in a wake only the autopilot\'s own; never one others wait for', () => {
    expect(removeRefusal(todo(), [], [], user)).toBeUndefined()
    expect(removeRefusal(todo(), [], [], inTurn)).toBeUndefined()
    expect(removeRefusal(todo(), [], [], inWake)).toMatch(/only the tasks your autopilot added/)
    expect(removeRefusal(todo({ autopilot: true }), [], [], inWake)).toBeUndefined()
    // Started, stopped, or an agent once ran on it (a worktree may exist): stop and archive instead.
    for (const t of [working(), stop(working()), todo({ run: 'r1' })]) expect(removeRefusal(t, [], [], user)).toMatch(/has started/)
    expect(removeRefusal(todo(), [{ task: 'WH-1' }], [], user)).toMatch(/has started/)
    const waiters = [todo({ id: 'WH-2', after: 'WH-1' }), todo({ id: 'WH-3', after: 'WH-9, WH-1' }), todo({ id: 'XX-1', project: 'XX', after: 'WH-1' })]
    expect(removeRefusal(todo(), [], waiters, user)).toBe('WH-2, WH-3, XX-1 wait for WH-1 (after): remove them first') // XX-1: another project of its workspace
    expect(cardOf(todo(), plan, []).removable).toBe(true)
    expect(cardOf(working(), plan, []).removable).toBeUndefined()
  })
})

describe('a stopped task', () => {
  it('waits for the user, its chained task too, with the reason; on the card and in Decisions', () => {
    const t = stop(working())
    expect(t).toMatchObject({ state: 'waiting', waitKind: undefined, waiting: 'Stopped by the user: loops on the same test' })
    const next: Task = { ...working({ id: 'WH-2', state: 'todo', step: undefined }), after: 'WH-1' }
    expect(chainState(next, [t, next])).toEqual({ wait: 'WH-1, which this task starts after, stopped: Stopped by the user: loops on the same test' })
    const card = cardOf(t, plan, [])
    expect(card).toMatchObject({ yourTurn: t.waiting, stopped: t.stopped })
    expect(canStop(card)).toBe(false)
    expect(canStop(cardOf(working(), plan, []))).toBe(true)
    const ds = decisionsOf({ cards: [card], tasks: [t], coordinators: [], wakes: [] })
    expect(ds).toEqual([expect.objectContaining({ group: 'stopped', task: 'WH-1', text: t.waiting })])
  })

  it('is no failure: no automation fires on it, the autopilot is not woken; a real failure still fires', () => {
    const first = taskEvents([working()], {})
    expect(taskEvents([stop(working())], first.seen).events).toEqual([])
    const ap = { ...DEFAULT_AUTOPILOT, events: ['stuck' as const] }
    expect(autopilotEvents(ap, [stop(working())], { 'WH-1': 'working' }).reasons).toEqual([])
    const failed = working({ state: 'waiting', waiting: 'claude stopped right after starting' })
    expect(taskEvents([failed], first.seen).events.map(e => e.event)).toEqual(['failed', 'needs-you'])
    expect(autopilotEvents(ap, [failed], { 'WH-1': 'working' }).reasons).toHaveLength(1)
  })

  it('the handover note says why, where the work is, and what the step asks now', () => {
    const back = { ...working().step!, backFrom: 'review', reviews: { review: [{ findings: [{ id: 'no-test', severity: 'major' as const, title: 'No test', proof: '0 tests' }] }] } }
    const text = handoverText(stop(working({ step: back, log: [{ at: 0, by: 'engine', text: 'work: sent to the worker' }] })), plan, 'task/WH-1')
    expect(text).toContain('stopped by the user: loops on the same test')
    expect(text).toContain('git config branch.task/WH-1.wherdrstart')
    expect(text).toContain('engine: work: sent to the worker')
    expect(text).toContain('No test')
    expect(text).not.toContain('When done:')
  })

  it('taken as it is: on to the next step, whose holder is told', () => {
    const r = onEvent(plan, { ...working().step!, backFrom: 'review' }, { kind: 'skip' }, 20)
    expect(r.state).toMatchObject({ at: 2, since: 20, acting: true, backFrom: undefined }) // the PR, run by the engine
    const atReview = onEvent(plan, { ...working().step!, at: 3, since: 5, told: 5 }, { kind: 'skip' }, 20)
    expect(plan[atReview.state.at]!.id).toBe('merge')
  })

  it('wherdr pm task stop needs a reason', () => {
    expect(parseCommand(['task', 'stop', 'WH-1', '--reason', 'it loops'])).toEqual({ name: 'task stop', task: 'WH-1', reason: 'it loops' })
    expect(parseCommand(['task', 'stop', 'WH-1'])).toMatchObject({ error: expect.stringContaining('--reason') })
  })
})

describe('an archived task', () => {
  // Its merge step refused by the guard, then the PR merged by hand and the task archived.
  const refused = working({ step: { ...initialState(), started: true, at: 4, since: 5, yourTurn: { reason: 'action', badge: 'merge: main is protected: only you may merge into it' } } })

  it('leaves Your turn', () => {
    const archived = { ...refused, step: archivedStep(refused.step!) }
    expect(archived.step).toMatchObject({ done: true, abandoned: true })
    expect(archived.step.yourTurn).toBeUndefined()
    expect(cardOf(archived, plan, []).yourTurn).toBeUndefined()
    // Archived before this fix: the card ignores the leftover badge, and the start repair clears it.
    const old = { ...refused, step: { ...refused.step!, done: true, abandoned: true } }
    expect(cardOf(old, plan, []).yourTurn).toBeUndefined()
    expect(doneTurnRepair(old)?.step?.yourTurn).toBeUndefined()
    expect(doneTurnRepair(archived)).toBeUndefined()
    expect(doneTurnRepair(refused)).toBeUndefined()
  })
})

describe('stop and resume on the server', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-stop-')) })
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
      if (method === 'terminal.get') return { state: 'running' }
      if (method === 'terminal.kill') return {}
      throw new Error(`unexpected ${method}`)
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    await startTask(deps, 'WH-1')
    return { store, deps, calls, files }
  }

  it('stop ends the agent and keeps the worktree; continue starts a new one there with the handover', async () => {
    const { store, deps, calls, files } = await setup()
    const t = await stopTask(deps, 'WH-1', user, 'it loops', 'user')
    expect(calls.filter(c => c[0] === 'terminal.kill')).toEqual([['terminal.kill', { terminal: 'm1/t1' }]])
    expect(calls.some(c => c[0] === 'machine.exec' && String((c[1].argv as string[])[2]).includes('worktree remove'))).toBe(false)
    expect(t).toMatchObject({ state: 'waiting', stopped: { by: 'the user', why: 'it loops' } })
    expect(t.log!.map(e => `${e.by}: ${e.text}`)).toEqual(['user: stopped: it loops', 'engine: ended the worker (claude claude-opus-5-5); its worktree stays'])
    expect((await store.runs())[0]).toMatchObject({ state: 'ended', endedBy: 'stopped' })
    await expect(stopTask(deps, 'WH-1', user, '', 'user')).rejects.toMatchObject({ code: 'refused' })

    const c = await resumeTask(deps, 'WH-1', 'continue', user, 'user')
    expect(c).toMatchObject({ state: 'working', step: { at: 1 } })
    expect(c.stopped).toBeUndefined()
    const runs = calls.filter(x => x[0] === 'terminal.run')
    expect(runs).toHaveLength(2)
    expect(runs[1]![1]).toMatchObject({ cwd: '/home/u/.wherdr/pm/worktrees/WH-1' })
    expect(files['/home/u/.wherdr/pm/tasks/WH-1/instructions.md']).toMatch(/## Handover[\s\S]*stopped by the user: it loops[\s\S]*## When you are done/)
    expect(c.log!.at(-1)).toMatchObject({ by: 'user', text: 'work: continued' })
  })

  it('stopped at an action step, continue runs its action again', async () => {
    const { store, deps } = await setup()
    const t = (await store.workflow('WH'))!
    const land = { id: 'land', ends: 'action', action: { kind: 'git.land', target: 'develop' } } as const
    await store.saveWorkflow('WH', { ...t, taskTypes: { ...t.taskTypes, simple: { steps: [{ id: 'todo' }, 'work', land, { id: 'done' }] } } }, { by: 'user' })
    const task = (await store.task('WH-1'))!
    await store.saveTask({ ...task, step: { ...task.step!, at: 2, tries: { land: 1 }, yourTurn: { reason: 'action', badge: 'land: failed' } } })
    await stopTask(deps, 'WH-1', user, 'stuck', 'user')
    const c = await resumeTask(deps, 'WH-1', 'continue', user, 'user')
    expect(c).toMatchObject({ state: 'working', step: { at: 2, acting: true, tries: { land: 2 } } })
    expect(c.step?.yourTurn).toBeUndefined()
    expect(c.log!.at(-1)).toMatchObject({ by: 'user', text: 'land: continued' })
  })

  it('take it as it is moves to the next step; archive ends the task and keeps its branch', async () => {
    const { deps } = await setup()
    await stopTask(deps, 'WH-1', user, '', 'user')
    const a = await resumeTask(deps, 'WH-1', 'as-is', user, 'user')
    expect(a).toMatchObject({ state: 'working', step: { at: 2, acting: true } })
    expect(a.stopped).toBeUndefined()
    expect(dueText(plan, a.step)).toBeUndefined()
    expect(a.log!.at(-1)!.text).toBe('work: taken as it is, on to pr')
    await stopTask(deps, 'WH-1', user, '', 'user')
    await expect(resumeTask(deps, 'WH-1', 'as-is', inTurn, 'coordinator WH')).rejects.toMatchObject({ code: 'refused' })
    const z = await resumeTask(deps, 'WH-1', 'archive', user, 'user')
    expect(z.step).toMatchObject({ done: true, abandoned: true })
    expect(z.log!.at(-1)!.text).toBe('archived; its worktree goes, its branch stays')
  })
})
