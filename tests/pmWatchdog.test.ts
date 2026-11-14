import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { releaseIdle } from '../server/utils/pmRelease'
import { advanceTick } from '../server/utils/pmAdvance'
import { userDecide } from '../server/utils/pmBoard'
import { MACHINE_OFFLINE, MACHINE_PAUSED, RELEASE_IDLE_MS } from '../shared/pm/release'
import { restartReview, watchAgents } from '../server/utils/pmWatchdog'
import { AGENTLESS_MS, reviewRestarted } from '../shared/pm/watchdog'
import type { Task } from '../shared/pm/run'
import type { Template } from '../shared/pm/workflow'

// Work, a review the user decides on past its round, then more work by the worker.
const flow: Template = {
  id: 'flow', prefs: { agent: 'claude', model: 'sonnet', reviewModel: 'opus' },
  taskTypes: { simple: { steps: [{ id: 'todo', column: 'To do' },
    { id: 'work', column: 'Working', holder: 'worker', ends: 'report' },
    { id: 'review', column: 'Review', holder: 'reviewer', ends: 'verdict', sendBack: 'work', rounds: 1 },
    { id: 'docs', column: 'Working', holder: 'worker', ends: 'report' },
    { id: 'done', column: 'Done' }] } },
}

describe('released agents start again', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-watchdog-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  async function setup() {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(flow)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/home/u/wh', template: 'flow' }, async (_m, p) => p)
    await store.addTask({ project: 'WH', title: 'Fix it', type: 'simple' })
    const env = { calls: [] as [string, Record<string, unknown>][], live: new Set<string>(), online: true }
    const out = (code: number, text: string) => ({ code, stdout: Buffer.from(text).toString('base64') })
    const call = async (method: string, p: Record<string, unknown>) => {
      env.calls.push([method, p])
      if (method === 'machine.exec') {
        const script = (p.argv as string[])[2]!
        if (script.includes('command -v')) return out(0, 'claude')
        if (script.includes('$HOME')) return out(0, '/home/u')
        return out(0, '')
      }
      if (method === 'terminal.run') {
        const address = `m1/t${env.calls.filter(c => c[0] === 'terminal.run').length}`
        env.live.add(address)
        return { address }
      }
      if (method === 'terminal.kill') env.live.delete(String(p.terminal))
      if (method === 'terminal.list') return { terminals: [...env.live].map(address => ({ address, labels: {}, state: 'running', status: { state: 'idle' } })) }
      return { state: env.live.has(String(p.terminal)) ? 'running' : 'finished' }
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: env.online ? 'online' : 'offline' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    await startTask(deps, 'WH-1')
    return { store, deps, env, starts: () => env.calls.filter(c => c[0] === 'terminal.run').length, log: async () => (await store.task('WH-1'))!.log!.map(e => e.text) }
  }

  it('a decision `pass` on a task whose agents were released starts the next step\'s worker', async () => {
    const { store, deps, starts, log } = await setup()
    const t = (await store.task('WH-1'))!
    const finding = { id: 'f1', severity: 'major' as const, title: 'No test', proof: '0 tests' }
    const advice = { outcome: 'decide' as never, why: 'two rounds', options: [], findings: [] }
    await store.saveTask({ ...t, step: { ...t.step!, at: 2, since: 5, told: 5, rounds: { review: 2 }, reviews: { review: [{ findings: [finding] }] }, yourTurn: { reason: 'rounds', badge: 'Decide: review failed 2 times', advice } } })
    expect(await releaseIdle(deps, 0)).toEqual([])
    expect(await releaseIdle(deps, RELEASE_IDLE_MS)).toEqual(['WH-1'])
    await userDecide(store, 'WH-1', 'pass')
    await advanceTick(deps)
    expect(starts()).toBe(2)
    expect(await log()).toContain('started the worker again in its worktree: docs needs it')
    expect((await store.task('WH-1'))!.state).toBe('working')
  })

  it('the watchdog starts again the worker of a working task whose agent is gone', async () => {
    const { store, deps, env, starts, log } = await setup()
    env.live.clear() // ended on its own, nothing recorded
    const wake = async () => ['x']
    await advanceTick(deps)
    expect((await store.task('WH-1'))!.state).toBe('working') // no longer parked until a manual start
    expect(await watchAgents(deps, wake, 0)).toEqual([])
    expect(await watchAgents(deps, wake, AGENTLESS_MS - 1)).toEqual([])
    expect(await watchAgents(deps, wake, AGENTLESS_MS)).toEqual(['WH-1'])
    expect(starts()).toBe(2)
    expect(await log()).toContain('started the worker again in its worktree: its agent was not running')
    expect(await watchAgents(deps, wake, 3 * AGENTLESS_MS)).toEqual([]) // it runs
  })

  it('Restart the review: the reviewer past its time ends, a new one starts on the next pass; refused off the review step', async () => {
    const { store, deps, env, starts, log } = await setup()
    await expect(restartReview(deps, 'WH-1', 'user', 'restarted the review')).rejects.toThrow('The task is not at its review step')
    const task = (await store.task('WH-1'))!, now = Date.now()
    await store.saveTask({ ...task, step: { ...task.step!, at: 2, since: now, told: now, yourTurn: { reason: 'timeout', badge: 'Check review: over 45m' } } })
    await store.saveRun({ id: 'rv', task: 'WH-1', role: 'reviewer', program: 'claude', model: 'opus', machine: 'm1', worktree: '/w', branch: 'task/WH-1', instructions: '/i', attempt: 1, state: 'running', startedAt: 1, terminal: 'm1/rv' })
    env.live.add('m1/rv')
    const after = await restartReview(deps, 'WH-1', 'user', 'restarted the review')
    expect(after.step).toMatchObject({ at: 2 })
    expect(after.step!.told ?? after.step!.yourTurn).toBeUndefined()
    expect(env.live.has('m1/rv')).toBe(false)
    expect((await store.runs()).find(r => r.id === 'rv')).toMatchObject({ state: 'ended', endedBy: 'stopped' })
    await advanceTick(deps)
    expect(starts()).toBe(2)
    expect((await store.runs()).filter(r => r.role === 'reviewer' && r.state !== 'ended')).toHaveLength(1)
    expect(await log()).toContain('restarted the review')
  })

  it('a restart gives the review a fresh time limit, and recovers a reviewer that exited right after starting', () => {
    const plan = [{ id: 'review', holder: 'reviewer', ends: 'verdict', timeout: '45m' }] as never
    const min = 60_000, step = { at: 0, started: true, since: min, told: min, deadline: 46 * min, proofs: {}, rounds: {} }
    // Restarted at minute 41, before its timeout: 45 minutes from then, not 5.
    expect(reviewRestarted({ state: 'working', step } as Task, plan, 41 * min).step!.deadline).toBe(86 * min)
    const failed = reviewRestarted({ state: 'waiting', waiting: 'The reviewer (claude) stopped right after starting', step } as Task, plan, 41 * min)
    expect(failed).toMatchObject({ state: 'working', waiting: undefined })
    expect(failed.step!.told).toBeUndefined()
  })

  it('a machine offline or paused: the status says why, its coordinator is woken once, never in a loop', async () => {
    const { store, deps, env, starts, log } = await setup()
    const woken: string[] = []
    const wake = async (_t: Task, why: string) => { woken.push(why); return ['its coordinator'] }
    env.live.clear()
    env.online = false
    for (let i = 0; i <= 5; i++) await watchAgents(deps, wake, i * AGENTLESS_MS)
    expect(starts()).toBe(1)
    expect((await store.task('WH-1'))!.held).toBe(MACHINE_OFFLINE)
    expect(woken).toHaveLength(1)
    expect(woken[0]).toMatch(/its worker is not running and could not be started again twice: Waits for its machine \(offline\)/)
    expect((await log()).filter(x => x.startsWith('its worker is not running'))).toEqual([
      `its worker is not running: ${MACHINE_OFFLINE}.`, `its worker is not running: ${MACHINE_OFFLINE}. Woke its coordinator.`])
    // Back online but paused for the project: the status says so; no new wake.
    env.online = true
    await store.updateProject('WH', { paused: ['m1'] })
    await watchAgents(deps, wake, 6 * AGENTLESS_MS)
    expect((await store.task('WH-1'))!.held).toBe(MACHINE_PAUSED)
    expect(woken).toHaveLength(1)
    // Switched on again: started, the status goes.
    await store.updateProject('WH', { paused: [] })
    await watchAgents(deps, wake, 7 * AGENTLESS_MS)
    expect(starts()).toBe(2)
    await watchAgents(deps, wake, 7 * AGENTLESS_MS + 1)
    expect((await store.task('WH-1'))!.held).toBeUndefined()
  })
})
