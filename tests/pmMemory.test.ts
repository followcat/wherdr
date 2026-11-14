import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { github } from '../shared/pm/examples'
import { DEFAULT_AUTOPILOT } from '../shared/pm/autopilot'
import { createPmStore } from '../server/utils/pmStore'
import { placeFor } from '../server/utils/pmPlace'
import { startHeld } from '../server/utils/pmMechanic'
import { DEFAULT_MEMORY, agentCap, autoReserve, memoryShort, mergeMemory, reserveOf } from '../shared/pm/memory'
import { parseLinux } from '../shared/pm/capacity'

const GB = 1024
const meminfo = (totalGb: number, freeGb: number, swapGb = 0, swapFreeGb = swapGb) =>
  `MemTotal: ${totalGb * GB * 1024} kB\nMemFree: 1 kB\nMemAvailable: ${freeGb * GB * 1024} kB\nSwapTotal: ${swapGb * GB * 1024} kB\nSwapFree: ${swapFreeGb * GB * 1024} kB\n`

describe('the memory hold', () => {
  it('holds under the free memory threshold, over 90 % of swap, or at the cap', () => {
    const mem = (free: number, swapFree = 4) => parseLinux(meminfo(16, free, 4, swapFree))
    expect(memoryShort(mem(8), DEFAULT_MEMORY, 0)).toBeUndefined()
    expect(memoryShort(mem(1.5), DEFAULT_MEMORY, 1)).toBe('1.5 GB free, under 2.4 GB')
    expect(memoryShort(mem(8), { minFreeMb: 10 * GB }, 1)).toBe('8.0 GB free, under 10.0 GB')
    // Idle: the reserve holds only its second task.
    expect(memoryShort(mem(1.5), DEFAULT_MEMORY, 0)).toBeUndefined()
    expect(memoryShort(mem(8, 0.2), DEFAULT_MEMORY, 0)).toBe('swap 95 % used')
    // Default cap: one agent per 1.5 GB of RAM (16 GB: 10).
    expect(agentCap(DEFAULT_MEMORY, mem(8))).toBe(10)
    expect(memoryShort(mem(8), DEFAULT_MEMORY, 10)).toBe('10 agents already run on it (cap 10)')
    expect(memoryShort(mem(8), { ...DEFAULT_MEMORY, maxAgents: 3 }, 2)).toBeUndefined()
    expect(memoryShort(mem(8), { ...DEFAULT_MEMORY, maxAgents: 3 }, 3)).toBe('3 agents already run on it (cap 3)')
    // No reading: only the user's cap holds.
    expect(memoryShort(null, DEFAULT_MEMORY, 30)).toBeUndefined()
    expect(memoryShort(null, { ...DEFAULT_MEMORY, maxAgents: 2 }, 2)).toBeDefined()
  })

  it('picks the Auto reserve from the RAM: 15 %, 1 to 4 GB; a saved one, 0 included, wins', () => {
    expect([4, 8, 18, 64].map(g => autoReserve(g * GB))).toEqual([1024, 1229, 2765, 4096])
    expect(reserveOf(DEFAULT_MEMORY, { total: 8 * GB })).toBe(1229)
    expect(reserveOf({ minFreeMb: 0 }, { total: 8 * GB })).toBe(0)
    expect(reserveOf(DEFAULT_MEMORY, null)).toBe(0)
    // macOS (pressure read): 10 % of the RAM, macOS's available figure already holds its own margin.
    expect(reserveOf(DEFAULT_MEMORY, { total: 18 * GB, pressure: 'normal' })).toBe(1843)
  })

  it('checks the user\'s settings', () => {
    expect(mergeMemory(DEFAULT_MEMORY, { minFreeGb: 4, maxAgents: 6 })).toEqual({ minFreeMb: 4 * GB, maxAgents: 6 })
    expect(mergeMemory({ minFreeMb: GB, maxAgents: 6 }, { minFreeGb: -1, maxAgents: null })).toEqual({ minFreeMb: GB })
    expect(mergeMemory(DEFAULT_MEMORY, { maxAgents: 0 })).toEqual(DEFAULT_MEMORY)
    // An emptied field (null) goes back to Auto; an absent one keeps its value.
    expect(mergeMemory({ minFreeMb: 0, maxAgents: 6 }, { minFreeGb: null })).toEqual({ maxAgents: 6 })
    const hours = { days: 'weekdays', from: '09:00', to: '19:00' } as const
    expect(mergeMemory(DEFAULT_MEMORY, { hours })).toEqual({ ...DEFAULT_MEMORY, hours })
    expect(mergeMemory({ ...DEFAULT_MEMORY, hours }, { hours: { ...hours, to: '25:00' } }).hours).toEqual(hours)
    expect(mergeMemory({ ...DEFAULT_MEMORY, hours }, { hours: null })).toEqual(DEFAULT_MEMORY)
  })

  it('counts the agents of every project on the machine against its cap', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-memory-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      for (const key of ['AA', 'BB']) await store.addProject({ key, machine: 'm1', path: `/src/${key}`, template: 'github' }, async (_m, p) => p)
      const run = (id: string, task: string) => store.saveRun({ id, task, role: 'worker', program: 'claude', model: 'sonnet', machine: 'm1', worktree: '/w', branch: 'b', instructions: '/i', attempt: 1, state: 'running', startedAt: 1 })
      // At their worker's step (work).
      const work = async (key: string) => store.saveTask({ ...(await store.addTask({ project: key, title: 'Work', type: 'simple' })), state: 'working', step: { at: 1, started: true, proofs: {}, rounds: {} } })
      // 6 GB of RAM, 5 free: room for one more standard agent (≈1.8 GB) above 2 GB free, not two. One runs for each project.
      for (const key of ['AA', 'BB']) await work(key)
      await run('r1', 'AA-1')
      await run('r2', 'BB-1')
      const call = async (method: string) => (method === 'machine.exec' ? { code: 0, stdout: Buffer.from(meminfo(6, 5)).toString('base64') } : {})
      const deps = { store, call, machines: () => [{ key: 'm1', local: false, label: 'box', status: 'online' }] } as unknown as Parameters<typeof placeFor>[0]
      const next = await store.addTask({ project: 'BB', title: 'Next', type: 'simple' })
      const memoryHold = async () => { const r = await placeFor(deps, next); return 'hold' in r ? r.hold : undefined }
      expect(await memoryHold()).toBe('Waits for room (Heavy to the strongest): standard (≈1.8 GB) fits nowhere — box: 2 agents take ≈3.5 GB of 6.0 GB')
      // A task waiting for the user (Your turn) does not count its agent.
      const aa = (await store.task('AA-1'))!
      await store.saveTask({ ...aa, step: { ...aa.step!, yourTurn: { reason: 'user', badge: 'Check it' } } })
      expect(await memoryHold()).toBeUndefined()
      await store.saveTask(aa)
      expect(await memoryHold()).toBeDefined()
      await store.saveRun({ ...(await store.runs()).find(r => r.id === 'r1')!, state: 'ended' })
      expect(await memoryHold()).toBeUndefined()
      // herdr-core says it went offline since the last reading: nothing starts there.
      const gone = { ...deps, call: async (m: string) => (m === 'machine.list' ? { machines: [{ name: 'box', state: 'disconnected' }] } : call(m)) }
      expect(await placeFor(gone as never, next)).toMatchObject({ hold: expect.stringContaining('box: offline') })

      // Memory back, a wake's held task still holds to its autopilot: over atOnce it waits, with why; off, the hold goes.
      const held = await store.saveTask({ ...(await store.addTask({ project: 'BB', title: 'Held', type: 'simple' })), autopilot: true, held: 'Waits for memory on box' })
      await store.saveCoordinator({ project: 'BB', tokenHash: '', autopilot: { ...DEFAULT_AUTOPILOT, on: true, atOnce: 1 } })
      expect(await startHeld(deps as never)).toEqual([])
      expect((await store.task(held.id))!.held).toBe(`Waits: 1 tasks already work at once (limit 1)`)
      await store.saveCoordinator({ project: 'BB', tokenHash: '', autopilot: { ...DEFAULT_AUTOPILOT, on: false } })
      expect(await startHeld(deps as never)).toEqual([])
      expect((await store.task(held.id))!.held).toBeUndefined()
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
