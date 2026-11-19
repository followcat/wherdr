import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { advanceTick } from '../server/utils/pmAdvance'
import { resumeParked } from '../server/utils/pmPark'
import { pauseForRoom } from '../server/utils/pmStop'
import { placeFor } from '../server/utils/pmPlace'
import { parkOf, parseBlockedOn, resumeText, roomPauseRefusal } from '../shared/pm/park'
import { cardOf, toHandle } from '../shared/pm/board'
import { decisionsOf } from '../shared/pm/decisions'
import { parseCommand } from '../shared/pm/coordinator'
import { stallOf } from '../shared/pm/blocked'
import { agentNeeded } from '../shared/pm/watchdog'
import { initialState } from '../shared/pm/steps'
import { wherdr } from '../shared/pm/examples'
import { taskPlan, type Task } from '../shared/pm/run'

const woken = vi.hoisted(() => [] as string[])
const cap = vi.hoisted(() => ({ n: 9 }))
vi.mock('../server/utils/pmMemory', async orig => ({ ...(await orig<object>()), machineCapacity: async () => null, readMemorySettings: async () => ({ m1: { maxAgents: cap.n } }) }))
vi.mock('../server/utils/pmWakes', async orig => ({ ...(await orig<object>()), wakeCoordinators: async (_d: unknown, _t: unknown, why: string) => { woken.push(why); return ['the project\'s coordinator'] } }))

const projects = [{ key: 'WH', machine: 'm1', path: '/p', template: 'wherdr' }] as never
const task = (over: Partial<Task> = {}): Task => ({ id: 'WH-1', project: 'WH', title: 'Client', description: '', type: 'simple', state: 'working', createdAt: 0, ...over })

describe('a blocked report', () => {
  it('names a task: an after link and parked; a repository: parked for a new task; a cycle: refused, a decision', () => {
    expect(parseBlockedOn('blocked:on WH-2: the /api/items endpoint')).toEqual({ on: 'WH-2', need: 'the /api/items endpoint' })
    expect(parseBlockedOn('blocked:on WH-2')).toBeUndefined()
    const other = task({ id: 'WH-2', title: 'API', state: 'todo' })
    const r = parkOf(task({ after: 'WH-0' }), 'wh-2', 'the endpoint', [task(), other, task({ id: 'WH-0' })], projects, 9)
    expect(r).toMatchObject({ park: { after: 'WH-0,WH-2', parked: { on: 'WH-2', need: 'the endpoint', at: 9, before: ['WH-0'] } } })
    expect('wake' in r && r.wake).toContain('goes on in the same conversation once WH-2 is done')
    // Already an after link: still what it waits for, so it resumes once that one is done.
    const again = parkOf(task({ after: 'WH-2' }), 'WH-2', 'the endpoint', [task(), other], projects, 9)
    expect(again).toMatchObject({ park: { after: 'WH-2', parked: { before: [] } } })
    const parked = 'park' in again ? again.park : task()
    expect(resumeText(parked, [parked, { ...other, step: { ...initialState(), done: true } }], projects)).toContain('WH-2 (API) is done')
    const repo = parkOf(task(), 'billing-api', 'a refund call', [task()], projects, 9)
    expect(repo).toMatchObject({ park: { parked: { on: 'billing-api', before: [] } } })
    expect('park' in repo && repo.wake).toContain('Add a task there')
    const cycle = parkOf(task(), 'WH-2', 'the schema', [task(), { ...other, after: 'WH-1' }], projects, 9)
    expect(cycle).toMatchObject({ refused: expect.stringContaining('already waits for this task'), key: 'cycle:WH-2' })
    expect('refused' in cycle && cycle.wake).toMatch(/Decision: .*pull the shared contract .* or merge the two tasks into one\..*tell the user both options/)
  })

  it('a parked task never stalls nor needs an agent, and resumes once what it waits for is done', () => {
    const plan = taskPlan(wherdr, task())
    const t = task({ idle: 0, after: 'WH-2', parked: { on: 'WH-2', need: 'the endpoint', at: 0, before: [] }, step: { ...initialState(), started: true, at: 1, since: 0, told: 0 } })
    expect(stallOf({ ...t, parked: undefined }, plan, 3_600_000)).toBeDefined()
    expect(stallOf(t, plan, 3_600_000)).toBeUndefined()
    expect(agentNeeded(t, plan)).toBeUndefined()
    const other = task({ id: 'WH-2', title: 'API', step: { ...initialState(), started: true, at: 1 } })
    expect(resumeText(t, [t, other], projects)).toBeUndefined()
    const done = { ...other, links: [{ label: 'PR', url: 'https://github.com/o/r/pull/7' }], workReports: [{ step: 'work', text: 'Added GET /api/items.' }], step: { ...other.step!, done: true } }
    expect(resumeText(t, [t, done], projects)).toBe('You were waiting for WH-2: the endpoint\n- WH-2 (API) is done, PR https://github.com/o/r/pull/7. Its report: Added GET /api/items.\nUpdate your branch with what you need, then go on with your task.')
  })
})

describe('parking on the server', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-park-')); woken.length = 0; cap.n = 9 })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  async function setup(second: Partial<Task> = {}) {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(wherdr)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/home/u/wh', template: 'wherdr' }, async (_m, p) => p)
    await store.addTask({ project: 'WH', title: 'Client', type: 'simple' })
    await store.saveTask({ ...(await store.addTask({ project: 'WH', title: 'API', type: 'simple' })), ...second })
    const calls: [string, Record<string, unknown>][] = []
    const env = { label: '', fail: false }
    const call = async (method: string, p: Record<string, unknown>) => {
      calls.push([method, p])
      if (method === 'machine.exec') {
        const [, , script] = p.argv as string[]
        if (script!.includes('command -v')) return { code: 0, stdout: Buffer.from('claude').toString('base64') }
        if (script!.includes('$HOME')) return { code: 0, stdout: Buffer.from('/home/u').toString('base64') }
        return { code: env.fail ? 1 : 0, stdout: '' }
      }
      if (method === 'terminal.run') return { address: `m1/t${calls.filter(c => c[0] === 'terminal.run').length}` }
      if (method === 'terminal.list') return { terminals: [{ address: 'm1/t1', labels: { 'wherdr.report': env.label }, state: 'running', status: { state: 'idle' } }] }
      if (['terminal.get', 'terminal.kill', 'terminal.label', 'terminal.send'].includes(method)) return { state: 'running' }
      throw new Error(`unexpected ${method}`)
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    await startTask(deps, 'WH-1')
    return { store, calls, env, deps }
  }

  it('parks on a task with one wake, frees its agent, then resumes the same conversation once that task is done', async () => {
    const { store, calls, env, deps } = await setup()
    env.label = 'blocked:on WH-2: the /api/items endpoint'
    await advanceTick(deps, 1000)
    await advanceTick(deps, 2000) // the label seen again: nothing more
    const t = (await store.task('WH-1'))!
    expect(t).toMatchObject({ state: 'working', after: 'WH-2', parked: { on: 'WH-2', need: 'the /api/items endpoint' } })
    expect(woken).toHaveLength(1)
    const run = (await store.runs())[0]!
    expect(run).toMatchObject({ state: 'ended', endedBy: 'released' })
    expect(calls.filter(c => c[0] === 'terminal.kill')).toHaveLength(1)

    await resumeParked(deps) // WH-2 not done yet
    expect(calls.filter(c => c[0] === 'terminal.run')).toHaveLength(1)
    const api = (await store.task('WH-2'))!
    await store.saveTask({ ...api, links: [{ label: 'PR', url: 'https://github.com/o/r/pull/7' }], step: { ...initialState(), started: true, done: true } })
    await resumeParked(deps)
    const line = String(calls.filter(c => c[0] === 'terminal.run')[1]![1].line)
    expect(line).toContain(`'--resume' '${run.session}'`)
    expect(line).toContain('WH-2 (API) is done, PR https://github.com/o/r/pull/7.')
    expect((await store.task('WH-1'))!.parked).toBeUndefined()
  })

  it('a Codex worker stays (its conversation cannot be resumed), and a parked task the user stopped is never started again', async () => {
    const { store, calls, env, deps } = await setup()
    const run = (await store.runs())[0]!
    await store.saveRun({ ...run, program: 'codex', session: undefined })
    env.label = 'blocked:on WH-2: the endpoint'
    await advanceTick(deps, 1000)
    expect((await store.task('WH-1'))!.parked).toBeDefined()
    expect(calls.some(c => c[0] === 'terminal.kill')).toBe(false)
    expect((await store.runs())[0]!.state).not.toBe('ended')
    const t = (await store.task('WH-1'))!
    await store.saveTask({ ...t, state: 'waiting', stopped: { by: 'the user', why: 'later', at: 2 } })
    await store.saveTask({ ...(await store.task('WH-2'))!, step: { ...initialState(), started: true, done: true } })
    const before = calls.length
    await resumeParked(deps)
    expect(calls.slice(before).filter(c => c[0] === 'terminal.run' || c[0] === 'terminal.send')).toHaveLength(0)
    expect((await store.task('WH-1'))!.parked).toBeDefined()
  })

  it('a wait that would close a cycle is refused: not parked, the worker told, one decision wake', async () => {
    const { store, calls, env, deps } = await setup({ after: 'WH-1' })
    env.label = 'blocked:on WH-2: the shared schema'
    await advanceTick(deps, 1000)
    env.label = 'blocked:on WH-2: the shared schema'
    await advanceTick(deps, 2000)
    const t = (await store.task('WH-1'))!
    expect(t.parked).toBeUndefined()
    expect(t.after).toBeUndefined()
    expect(woken).toHaveLength(1)
    expect(woken[0]).toMatch(/^Decision: /)
    expect(calls.filter(c => c[0] === 'terminal.send').map(c => c[1].text)).toEqual(Array(2).fill(expect.stringContaining('already waits for this task')))
    expect(calls.some(c => c[0] === 'terminal.kill')).toBe(false)
  })
  it('paused for room: out of the user\'s lists, kept to its machine\'s cap, resumed in its conversation before a new task starts there', async () => {
    expect(parseCommand(['task', 'stop', 'WH-1', '--for-room', '--reason', 'machine over its cap'])).toMatchObject({ name: 'task stop', forRoom: true })
    const { store, calls, env, deps } = await setup()
    const first = (await store.runs())[0]!
    await store.saveRun({ ...first, program: 'codex' })
    await expect(pauseForRoom(deps, 'WH-1', 'full', 'coordinator WH')).rejects.toThrow('cannot be taken up again')
    await store.saveRun(first)
    cap.n = 1
    await pauseForRoom(deps, 'WH-1', 'machine over its cap', 'coordinator WH')
    const run = (await store.runs())[0]!
    expect(run).toMatchObject({ state: 'ended', endedBy: 'released' })
    const t = (await store.task('WH-1'))!
    expect(t).toMatchObject({ state: 'working', parked: { on: 'm1', room: 'm1', need: 'machine over its cap' } })
    const card = cardOf(t, taskPlan(wherdr, t), await store.runs())
    expect(card.parked).toMatchObject({ room: 'm1' })
    expect(toHandle([card])).toEqual([])
    expect(decisionsOf({ cards: [card], tasks: [t], coordinators: [], wakes: [] } as never)).toEqual([])
    await expect(pauseForRoom(deps, 'WH-1', 'again', 'coordinator WH')).rejects.toThrow('already paused for room')

    // Another task took the room: WH-1 waits, and a new task does not start there before it.
    await startTask(deps, 'WH-2')
    await resumeParked(deps)
    expect(calls.filter(c => c[0] === 'terminal.run')).toHaveLength(2)
    expect((await store.task('WH-1'))!.parked).toBeDefined()
    const fresh = await store.addTask({ project: 'WH', title: 'Next', type: 'simple' })
    expect(await placeFor(deps, fresh)).toMatchObject({ hold: expect.stringContaining('WH-1, paused for room there, starts first') })

    // The room is back but its start fails: still paused (never the user's turn), tried again 10 min later.
    const other = (await store.runs()).find(r => r.task === 'WH-2')!
    await store.saveRun({ ...other, state: 'ended', endedBy: 'released' })
    env.fail = true
    await resumeParked(deps, 1000)
    const failed = (await store.task('WH-1'))!
    expect(failed).toMatchObject({ state: 'working', parked: { room: 'm1' } })
    expect(cardOf(failed, taskPlan(wherdr, failed), await store.runs()).yourTurn).toBeUndefined()
    env.fail = false
    const runsBefore = calls.filter(c => c[0] === 'terminal.run').length
    await resumeParked(deps, 2000)
    expect(calls.filter(c => c[0] === 'terminal.run')).toHaveLength(runsBefore)
    // The room is back: WH-1 goes on in the same conversation, told why it paused.
    await resumeParked(deps, 1000 + 10 * 60_000)
    const line = String(calls.filter(c => c[0] === 'terminal.run').at(-1)![1].line)
    expect(line).toContain(`'--resume' '${run.session}'`)
    expect(line).toContain('There is room again')
    expect((await store.task('WH-1'))!.parked).toBeUndefined()
    expect(await placeFor(deps, fresh)).toMatchObject({ hold: expect.not.stringContaining('paused for room') })
  })

  it('paused for room, its start failing for another reason: the pause ends at the third try, the real reason shown, its coordinator woken', async () => {
    const { store, env, deps } = await setup()
    await pauseForRoom(deps, 'WH-1', 'machine over its cap', 'coordinator WH')
    env.fail = true // the room is there, but the worker cannot start (its files cannot be written)
    const fresh = await store.addTask({ project: 'WH', title: 'Next', type: 'simple' })
    for (const at of [0, 10 * 60_000]) {
      await resumeParked(deps, at)
      expect((await store.task('WH-1'))!).toMatchObject({ state: 'working', parked: { room: 'm1' } })
    }
    await resumeParked(deps, 20 * 60_000)
    const t = (await store.task('WH-1'))!
    expect(t.parked).toBeUndefined()
    expect(t).toMatchObject({ state: 'waiting', waiting: expect.not.stringContaining('room') })
    expect(woken).toEqual([expect.stringContaining('its worker could not start again')])
    // The machine no longer waits for it.
    env.fail = false
    expect(await placeFor(deps, fresh)).not.toHaveProperty('hold')
  })
})

describe('pausing a task for room', () => {
  const started = { id: 'WEB-1', project: 'WEB', title: 't', description: '', type: 'feature', state: 'working', createdAt: 0, step: { at: 1, started: true, proofs: {}, rounds: {} } } as unknown as Task
  it('only a Claude worker with its session is taken up again later: an omp worker is refused with that text, never a crash', () => {
    expect(roomPauseRefusal(started, 'worker', [{ role: 'worker', program: 'claude', session: 's1' }])).toBeUndefined()
    const text = "WEB-1's worker conversation cannot be taken up again later (only a Claude worker's can): stop it instead, or let it finish"
    expect(roomPauseRefusal(started, 'worker', [{ role: 'worker', program: 'omp', session: 's1' }])).toBe(text)
    expect(roomPauseRefusal(started, 'worker', [{ role: 'worker', program: 'omp' }])).toBe(text)
    expect(roomPauseRefusal(started, 'worker', [{ role: 'worker', program: 'codex' }])).toBe(text)
  })
})
