import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { github } from '../shared/pm/examples'
import { DEFAULT_AUTOPILOT, busyNext, cleanAutopilot } from '../shared/pm/autopilot'
import type { Task } from '../shared/pm/run'
import { createPmStore } from '../server/utils/pmStore'
import { HerdrError } from '../server/utils/herdr'
import { startTask } from '../server/utils/pmLaunch'
import { startNext } from '../server/utils/pmMechanic'
import { machinesNow } from '../server/utils/pmPlace'

vi.mock('../server/utils/pmLaunch', async orig => ({ ...(await orig<typeof import('../server/utils/pmLaunch')>()), startTask: vi.fn() }))

const task = (n: number, more: Partial<Task> = {}): Task => ({ id: `CO-${n}`, project: 'CO', title: `T${n}`, description: '', type: 'feature', state: 'todo', createdAt: n, ...more })
const at = (h: number) => new Date(2026, 10, 5, h, 30).getTime()
const ap = { ...DEFAULT_AUTOPILOT, on: true, perDay: 5, atOnce: 2 }

describe('keep the board busy', () => {
  it('is on by default with the autopilot, and saved only when turned off', () => {
    expect(cleanAutopilot({ ...ap })).not.toHaveProperty('autopilot.keepBusy')
    expect(cleanAutopilot({ ...ap, keepBusy: false })).toMatchObject({ autopilot: { keepBusy: false } })
    expect(busyNext({ ...ap, keepBusy: false }, [task(1)], [], at(12))).toEqual({ why: 'Keep the board busy is off' })
    expect(busyNext({ ...ap, on: false }, [task(1)], [], at(12))).toEqual({ why: 'The autopilot is off' })
  })

  it('picks the oldest to-do task, never one chained, held or under way', () => {
    const tasks = [task(5), task(2, { after: 'CO-9' }), task(3, { held: 'Waits for room' }), task(1, { state: 'working' }), task(4)]
    expect(busyNext(ap, tasks, [], at(12))).toMatchObject({ task: { id: 'CO-4' } })
    expect(busyNext(ap, [task(2, { after: 'CO-9' }), task(9)], [], at(12))).toMatchObject({ task: { id: 'CO-9' } })
    expect(busyNext(ap, [task(1, { state: 'working' })], [], at(12))).toEqual({ why: 'No task to do' })
  })

  it('stops at the limits and outside the hours', () => {
    expect(busyNext(ap, [task(1, { state: 'working' }), task(2, { state: 'working' }), task(3)], [], at(12))).toEqual({ why: expect.stringMatching(/already work at once/) })
    expect(busyNext({ ...ap, perDay: 0 }, [task(1)], [], at(12))).toEqual({ why: expect.stringMatching(/Today's limit/) })
    expect(busyNext({ ...ap, hours: { from: 9, to: 18 } }, [task(1)], [], at(20))).toEqual({ why: 'Outside the autopilot\'s hours' })
  })

  it('starts the next task on a machine with room, once, and logs it', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-busy-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      await store.addProject({ key: 'AA', machine: 'm1', path: '/src/AA', template: 'github' }, async (_m, p) => p)
      await store.saveCoordinator({ project: 'AA', tokenHash: '', autopilot: { ...ap, atOnce: 1 } })
      const first = await store.addTask({ project: 'AA', title: 'First', type: 'simple' })
      const second = await store.addTask({ project: 'AA', title: 'Second', type: 'simple' })
      const meminfo = `MemTotal: ${64 * 1024 * 1024} kB\nMemAvailable: ${60 * 1024 * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`
      const call = async (method: string) => (method === 'machine.exec' ? { code: 0, stdout: Buffer.from(meminfo).toString('base64') } : {})
      const deps = { store, call, machines: () => [{ key: 'm1', local: false, label: 'box', status: 'online' }] } as never
      // A start that went: its worker run has a terminal.
      vi.mocked(startTask).mockImplementation(async (_d, id) => {
        await store.saveRun({ id: `r-${id}`, task: id, role: 'worker', program: 'claude', model: '', machine: 'm1', worktree: '', branch: '', instructions: '', attempt: 1, state: 'running', terminal: 'm1/t1', startedAt: 1 })
        return store.saveTask({ ...(await store.task(id))!, state: 'working', run: `r-${id}`, step: { at: 1, started: true, proofs: {}, rounds: {} } })
      })

      expect(await startNext(deps)).toEqual([first.id])
      expect((await store.task(first.id))!.log?.at(-1)).toMatchObject({ by: 'engine', text: 'started by the autopilot: room on box' })
      // At its limit of one at once: nothing more, and the first is never started twice.
      expect(await startNext(deps)).toEqual([])
      expect(startTask).toHaveBeenCalledTimes(1)
      // Started another way meanwhile (the lock refuses a second start): dropped, not logged.
      await store.saveCoordinator({ project: 'AA', tokenHash: '', autopilot: ap })
      vi.mocked(startTask).mockRejectedValueOnce(new HerdrError('busy', 'already starting'))
      expect(await startNext(deps)).toEqual([])
      expect(startTask).toHaveBeenCalledTimes(2)
      expect((await store.task(second.id))!.log ?? []).toEqual([])
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })

  it('shows the next task in the Machines view, or why it waits when only a chained one is left', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-busy-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      const p = await store.addProject({ key: 'AA', machine: 'm1', path: '/src/AA', template: 'github' }, async (_m, x) => x)
      await store.saveCoordinator({ project: 'AA', tokenHash: '', autopilot: ap })
      const first = await store.addTask({ project: 'AA', title: 'First', type: 'simple' })
      const meminfo = `MemTotal: ${64 * 1024 * 1024} kB\nMemAvailable: ${60 * 1024 * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`
      const call = async (method: string) => (method === 'machine.exec' ? { code: 0, stdout: Buffer.from(meminfo).toString('base64') } : {})
      const deps = { store, call, machines: () => [{ key: 'm1', local: false, label: 'box', status: 'online' }] } as never
      expect((await machinesNow(deps, p)).next).toEqual({ task: first.id, title: 'First', weight: expect.any(String), on: 'box' })
      // Under way, with a to-do task chained after it: Next names that one and its wait, not "no task".
      await store.saveTask({ ...first, state: 'working', step: { at: 1, started: true, proofs: {}, rounds: {} } })
      const second = await store.addTask({ project: 'AA', title: 'Second', type: 'simple', after: first.id })
      expect((await machinesNow(deps, p)).next).toMatchObject({ task: second.id, why: expect.stringContaining(first.id) })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
