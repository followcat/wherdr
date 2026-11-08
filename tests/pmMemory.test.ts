import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { github } from '../shared/pm/examples'
import { DEFAULT_AUTOPILOT } from '../shared/pm/autopilot'
import { DEFAULT_MEMORY, agentCap, memoryShort, mergeMemory, parseMeminfo } from '../shared/pm/memory'

const GB = 1024
const meminfo = (totalGb: number, freeGb: number, swapGb = 0, swapFreeGb = swapGb) =>
  `MemTotal: ${totalGb * GB * 1024} kB\nMemFree: 1 kB\nMemAvailable: ${freeGb * GB * 1024} kB\nSwapTotal: ${swapGb * GB * 1024} kB\nSwapFree: ${swapFreeGb * GB * 1024} kB\n`

describe('the memory hold', () => {
  it('holds under the free memory threshold, over 90 % of swap, or at the cap', () => {
    const mem = (free: number, swapFree = 4) => parseMeminfo(meminfo(16, free, 4, swapFree))
    expect(memoryShort(mem(8), DEFAULT_MEMORY, 0)).toBeUndefined()
    expect(memoryShort(mem(1.5), DEFAULT_MEMORY, 0)).toBe('1.5 GB free, under 2.0 GB')
    expect(memoryShort(mem(8), { minFreeMb: 10 * GB }, 0)).toBe('8.0 GB free, under 10.0 GB')
    expect(memoryShort(mem(8, 0.2), DEFAULT_MEMORY, 0)).toBe('swap 95 % used')
    // Default cap: one agent per 1.5 GB of RAM (16 GB: 10).
    expect(agentCap(DEFAULT_MEMORY, mem(8))).toBe(10)
    expect(memoryShort(mem(8), DEFAULT_MEMORY, 10)).toBe('10 agents already run on it (cap 10)')
    expect(memoryShort(mem(8), { ...DEFAULT_MEMORY, maxAgents: 3 }, 2)).toBeUndefined()
    expect(memoryShort(mem(8), { ...DEFAULT_MEMORY, maxAgents: 3 }, 3)).toBe('3 agents already run on it (cap 3)')
    // No reading (not Linux): only the user's cap holds.
    expect(parseMeminfo('')).toBeNull()
    expect(memoryShort(null, DEFAULT_MEMORY, 30)).toBeUndefined()
    expect(memoryShort(null, { ...DEFAULT_MEMORY, maxAgents: 2 }, 2)).toBeDefined()
  })

  it('checks the user\'s settings', () => {
    expect(mergeMemory(DEFAULT_MEMORY, { minFreeGb: 4, maxAgents: 6 })).toEqual({ minFreeMb: 4 * GB, maxAgents: 6 })
    expect(mergeMemory({ minFreeMb: GB, maxAgents: 6 }, { minFreeGb: -1, maxAgents: null })).toEqual({ minFreeMb: GB })
    expect(mergeMemory(DEFAULT_MEMORY, { maxAgents: 0 })).toEqual(DEFAULT_MEMORY)
  })

  it('counts the agents of every project on the machine against its cap', async () => {
    const { createPmStore } = await import('../server/utils/pmStore')
    const { memoryHold } = await import('../server/utils/pmMemory')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-memory-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await store.saveTemplate(github)
      for (const key of ['AA', 'BB']) await store.addProject({ key, machine: 'm1', path: `/src/${key}`, template: 'github' }, async (_m, p) => p)
      const run = (id: string, task: string) => store.saveRun({ id, task, role: 'worker', program: 'claude', model: 'sonnet', machine: 'm1', worktree: '/w', branch: 'b', instructions: '/i', attempt: 1, state: 'running', startedAt: 1 })
      // 3 GB of RAM: a cap of two agents. One runs for each project.
      await run('r1', 'AA-1')
      await run('r2', 'BB-1')
      const call = async (method: string) => (method === 'machine.exec' ? { code: 0, stdout: Buffer.from(meminfo(3, 2.5)).toString('base64') } : {})
      const deps = { store, call, machines: () => [{ key: 'm1', local: false, label: 'box', status: 'online' }] } as unknown as Parameters<typeof memoryHold>[0]
      expect(await memoryHold(deps, 'BB')).toBe('Waits for memory on box: 2 agents already run on it (cap 2)')
      await store.saveRun({ ...(await store.runs()).find(r => r.id === 'r1')!, state: 'ended' })
      expect(await memoryHold(deps, 'BB')).toBeUndefined()

      // Memory back, a wake's held task still holds to its autopilot: over atOnce it waits, with why; off, the hold goes.
      const { startHeld } = await import('../server/utils/pmMechanic')
      const busy = await store.addTask({ project: 'BB', title: 'Busy', type: 'simple' })
      await store.saveTask({ ...busy, state: 'working' })
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
