import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { mechanicTick } from '../server/utils/pmMechanic'
import { ACTION_LIMIT_MS, actionRunning, actionsSettled, startAction } from '../server/utils/pmBoard'
import type { Template } from '../shared/pm/workflow'

const flow: Template = {
  id: 'flow', prefs: { agent: 'claude', model: 'sonnet' },
  taskTypes: { simple: { steps: [{ id: 'todo', column: 'To do' },
    { id: 'work', column: 'Working', holder: 'worker', ends: 'report' },
    { id: 'pr', column: 'Working', holder: 'none', ends: 'action', action: { kind: 'github.pr', base: 'v3' } },
    { id: 'merge', column: 'Working', holder: 'none', ends: 'action', action: { kind: 'github.merge' } },
    { id: 'done', column: 'Done' }] } },
}

// Step actions run outside the engine's ticks (pmBoard.ts startAction). The
// timers are fake (they move with real time): a minute's sleep in a tick would hang it.
describe('step actions outside the ticks', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-async-'))
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })
  afterEach(async () => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    await fs.rm(dir, { recursive: true, force: true })
  })

  // WH-1 at its merge, acting; checks: its PR's checks. merge: the merge command's answer.
  async function setup(checks: { name: string, status: string, conclusion?: string }[], merge: () => Promise<unknown>, onPrInfo?: () => Promise<void>) {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(flow)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/src/wh', template: 'flow' }, async (_m, p) => p)
    await store.addProject({ key: 'OT', machine: 'm2', path: '/src/ot', template: 'flow' }, async (_m, p) => p)
    const out = (code: number, text: string) => ({ code, stdout: Buffer.from(text).toString('base64') })
    const pr = { url: 'https://github.com/o/r/pull/1', baseRefName: 'v3', headRefOid: 'abc', mergeStateStatus: 'CLEAN', statusCheckRollup: checks }
    let n = 0
    const call = async (method: string, p: Record<string, unknown>) => {
      if (method === 'machine.exec') {
        const script = (p.argv as string[])[2]!
        if (script.includes('gh pr list')) { await onPrInfo?.(); return out(0, `abc\n${JSON.stringify([pr])}`) }
        if (script.includes('cat-file -e')) return out(0, 'same')
        if (script.includes('gh pr merge')) return merge()
        if (script.includes('command -v')) return out(0, 'claude')
        if (script.includes('$HOME')) return out(0, '/home/u')
        return out(0, '')
      }
      if (method === 'terminal.run') return { address: `m/t${++n}` }
      if (method === 'terminal.list') return { terminals: [] }
      return { state: 'running' }
    }
    const machines = ['m1', 'm2'].map(key => ({ key, label: key, local: false, status: 'online' }))
    const deps = { call, store, machines: () => machines, launchWatchMs: 0 } as unknown as PmLaunchDeps
    await store.addTask({ project: 'WH', title: 'Merging', type: 'simple' })
    await startTask(deps, 'WH-1')
    const t = (await store.task('WH-1'))!
    await store.saveTask({ ...t, step: { ...t.step!, at: 3, since: Date.now(), acting: true, watch: { from: Date.now(), next: 0 } } })
    // Each project: a done task, and one chained after it that the tick starts.
    for (const key of ['WH', 'OT']) {
      const done = await store.addTask({ project: key, title: 'Done', type: 'simple' })
      await store.saveTask({ ...done, state: 'done', step: { at: 4, started: true, done: true, since: 1, proofs: {}, rounds: {} } })
      await store.addTask({ project: key, title: 'Next', type: 'simple', after: done.id })
    }
    return { store, deps }
  }

  it('a merge that waits for CI holds neither another task\'s start in its project nor in another project', async () => {
    const merge = vi.fn(async () => ({ code: 0, stdout: '' }))
    const { store, deps } = await setup([{ name: 'ci', status: 'IN_PROGRESS' }], merge)
    await mechanicTick(deps)
    // The chained tasks of both projects started in the same tick.
    expect((await store.task('WH-3'))!.state).toBe('working')
    expect((await store.task('OT-2'))!.state).toBe('working')
    await actionsSettled()
    // The merge read its PR, saw CI running, and waits as a state a later tick checks again.
    const s = (await store.task('WH-1'))!.step!
    expect(s).toMatchObject({ at: 3, acting: true })
    expect(s.watch!.next).toBeGreaterThan(Date.now())
    expect(merge).not.toHaveBeenCalled()
    expect(actionRunning('WH-1')).toBe(false)
  })

  it('an action that ends while the mechanic reads the PR is never undone by the mechanic\'s older copy', async () => {
    let ended: (() => Promise<void>) | undefined
    const { store, deps } = await setup([{ name: 'ci', status: 'IN_PROGRESS' }], async () => ({ code: 0, stdout: '' }), async () => { const e = ended; ended = undefined; await e?.() })
    const t = (await store.task('WH-1'))!
    await store.saveTask({ ...t, step: { ...t.step!, acting: undefined, watch: undefined } })
    // As a merge the user started would: done, with its log line, while the PR is being read.
    ended = async () => { const x = (await store.task('WH-1'))!; await store.logTask({ ...x, step: { ...x.step!, at: 4, done: true } }, 'engine', 'merge: merged') }
    await mechanicTick(deps)
    const after = (await store.task('WH-1'))!
    expect(after.step).toMatchObject({ at: 4, done: true })
    expect(after.log!.map(l => l.text)).toContain('merge: merged')
  })

  it('a hung action frees its task after the limit, with a log line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let reached = false
    const { deps } = await setup([{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }], () => { reached = true; return new Promise(() => {}) })
    expect(startAction(deps, 'WH-1')).toBe(true)
    await vi.waitFor(() => expect(reached).toBe(true))
    expect(actionRunning('WH-1')).toBe(true)
    expect(startAction(deps, 'WH-1')).toBe(false)
    vi.advanceTimersByTime(ACTION_LIMIT_MS + 1000)
    expect(actionRunning('WH-1')).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/step action of WH-1: held \d+ s by the engine's step action, past its 1800 s limit: released/))
  })
})
