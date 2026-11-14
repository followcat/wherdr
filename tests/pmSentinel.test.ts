import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { startTask, type PmLaunchDeps } from '../server/utils/pmLaunch'
import { mechanicTick } from '../server/utils/pmMechanic'
import { sentinelTick } from '../server/utils/pmSentinel'
import { READ_HOLD, SENTINEL_MS } from '../shared/pm/sentinel'
import type { Task } from '../shared/pm/run'
import type { Template } from '../shared/pm/workflow'

const flow: Template = {
  id: 'flow', prefs: { agent: 'claude', model: 'sonnet' },
  taskTypes: { simple: { steps: [{ id: 'todo', column: 'To do' },
    { id: 'work', column: 'Working', holder: 'worker', ends: 'report' },
    { id: 'pr', column: 'Working', holder: 'none', ends: 'action', action: { kind: 'github.pr', base: 'v3' } },
    { id: 'merge', column: 'Working', holder: 'none', ends: 'action', action: { kind: 'github.merge' } },
    { id: 'done', column: 'Done' }] } },
}

describe('engine liveness', () => {
  let dir = ''
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-sentinel-')) })
  afterEach(() => fs.rm(dir, { recursive: true, force: true }))

  // Two tasks at their merge step; prInfo(branch) answers each task's PR read.
  async function setup(prInfo: (branch: string) => { code: number, text: string } = () => ({ code: 1, text: '' })) {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(flow)
    await store.addProject({ key: 'WH', machine: 'm1', path: '/home/u/wh', template: 'flow' }, async (_m, p) => p)
    const out = (code: number, text: string) => ({ code, stdout: Buffer.from(text).toString('base64') })
    let n = 0
    const call = async (method: string, p: Record<string, unknown>) => {
      if (method === 'machine.exec') {
        const [, , script, , , branch] = p.argv as string[]
        if (script!.includes('gh pr list')) { const r = prInfo(String(branch)); return out(r.code, r.text) }
        if (script!.includes('command -v')) return out(0, 'claude')
        if (script!.includes('$HOME')) return out(0, '/home/u')
        return out(0, '')
      }
      if (method === 'terminal.run') return { address: `m1/t${++n}` }
      if (method === 'terminal.list') return { terminals: [] }
      return { state: 'running' }
    }
    const deps = { call, store, machines: () => [{ key: 'm1', label: 'm1', local: false, status: 'online' }], launchWatchMs: 0 } as unknown as PmLaunchDeps
    for (const id of ['WH-1', 'WH-2']) {
      await store.addTask({ project: 'WH', title: `Fix ${id}`, type: 'simple' })
      await startTask(deps, id)
      const t = (await store.task(id))!
      await store.saveTask({ ...t, step: { ...t.step!, at: 3, since: 1 } })
    }
    const at = async (id: string, more: Partial<Task>) => store.saveTask({ ...(await store.task(id))!, ...more })
    const log = async (id: string) => (await store.task(id))!.log!.map(e => e.text)
    return { store, deps, at, log }
  }

  it('logs a task whose tick throws, and still reads the next one, whose unreadable PR is said once', async () => {
    const { store, deps, log } = await setup((branch) => {
      if (branch.endsWith('WH-1')) throw new Error('herdr-core went away')
      return { code: 1, text: 'gh: HTTP 502' }
    })
    await mechanicTick(deps)
    await mechanicTick(deps)
    expect((await log('WH-1')).filter(l => l.includes('the engine hit an error on this task: herdr-core went away'))).toHaveLength(1)
    expect((await store.task('WH-2'))!.held).toBe(`${READ_HOLD}could not read the PR: gh: HTTP 502`)
    expect((await log('WH-2')).filter(l => l.startsWith(READ_HOLD))).toHaveLength(1)
  })

  it('gives back a spent merge move once, backs off, and wakes the coordinator once', async () => {
    const { store, deps, at } = await setup()
    await at('WH-2', { state: 'waiting', waiting: 'asked' })
    const quiet = Date.now() + SENTINEL_MS + 60_000
    await at('WH-1', { mech: { 'merge:abc1234': 1 } })
    const woken: string[] = []
    const opts = { wake: async (_t: Task, why: string) => { woken.push(why); return ['the project\'s coordinator'] } }
    expect(await sentinelTick(deps, quiet, opts)).toEqual(['WH-1'])
    const t = (await store.task('WH-1'))!
    expect(t.mech?.['merge:abc1234']).toBeUndefined()
    expect(t.log!.at(-1)!.text).toMatch(/^no progress for 20 min: at step merge .*gave back its spent move merge:abc1234.*looks again in 40 min\. Woke the project's coordinator\.$/)
    // Before its backoff: left alone; after it, looked at again without giving the move back twice nor waking again.
    expect(await sentinelTick(deps, quiet + 60_000, opts)).toEqual([])
    await at('WH-1', { mech: { 'merge:abc1234': 1 } })
    expect(await sentinelTick(deps, quiet + 2 * SENTINEL_MS, opts)).toEqual(['WH-1'])
    expect((await store.task('WH-1'))!.mech?.['merge:abc1234']).toBe(1)
    expect(woken).toHaveLength(1)
    expect(woken[0]).toContain('WH-1')
  })

  it('runs a stuck or stranded action again, and clears its running mark when that fails', async () => {
    const { store, deps, at } = await setup()
    const t = (await store.task('WH-1'))!
    await at('WH-1', { step: { ...t.step!, acting: true } })
    const acted: [string, boolean | undefined][] = []
    const act = async (id: string) => { acted.push([id, (await store.task(id))!.step!.acting]); throw new Error('refused') }
    await sentinelTick(deps, Date.now() + SENTINEL_MS + 60_000, { act, wake: async () => [] })
    // WH-1 marked running with none running; WH-2 at its action step with no mark and no move spent: both run again.
    expect(acted).toEqual([['WH-1', true], ['WH-2', true]])
    for (const id of ['WH-1', 'WH-2']) {
      const after = (await store.task(id))!
      expect(after.step!.acting).toBeUndefined()
      expect(after.log!.at(-1)!.text).toContain('cleared its running mark (running its action again failed: refused)')
    }
    expect((await store.task('WH-2'))!.step!.tries?.merge).toBe(1)
  })
})
