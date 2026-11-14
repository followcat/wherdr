import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { DEFAULT_AUTOPILOT } from '../shared/pm/autopilot'
import type { PmLaunchDeps } from '../server/utils/pmLaunch'

// Each start saves a worker run, as a real one does; each member has room on its own machine.
const env = vi.hoisted(() => ({ store: null as null | ReturnType<typeof import('../server/utils/pmStore').createPmStore> }))
vi.mock('../server/utils/pmLaunch', async orig => ({
  ...(await orig<object>()),
  startTask: async (_d: unknown, id: string, { on }: { on: string }) => {
    const s = env.store!, t = (await s.task(id))!
    await s.saveRun({ id: `r-${id}`, task: id, role: 'worker', program: 'claude', model: 'sonnet', machine: on, worktree: '/w', branch: `task/${id}`, instructions: '/i', terminal: `h/${id}`, attempt: 1, state: 'running', startedAt: Date.now() })
    return s.saveTask({ ...t, state: 'working', run: `r-${id}` })
  },
  launched: async () => true,
}))
vi.mock('../server/utils/pmPlace', async orig => ({
  ...(await orig<object>()),
  placeFor: async (_d: unknown, t: { project: string }) => ({ machine: t.project === 'PA' ? 'm1' : 'm2' }),
  paceOf: async () => ({ verdict: undefined, waits: undefined }),
}))

let dir = ''
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-ws-starts-'))
  env.store = createPmStore(dir)
  await env.store.setEnabled(true)
  await fs.writeFile(env.store.files.projects, JSON.stringify({ v: 1, projects: [
    { key: 'WS', name: 'Work', machine: '', path: '/src/work', kind: 'workspace', git: false, addedAt: 1 },
    { key: 'PA', name: 'Payroll', machine: '', path: '/src/work/payroll-api', workspace: 'WS', addedAt: 1 },
    { key: 'QA', name: 'Quotes', machine: '', path: '/src/work/quotes-app', workspace: 'WS', addedAt: 1 },
  ] }))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

it('chained starts of two members count in the workspace\'s Tasks / day as they go (WHR-314)', async () => {
  const { startChained } = await import('../server/utils/pmMechanic')
  const s = env.store!
  await s.saveCoordinator({ project: 'WS', autopilot: { ...DEFAULT_AUTOPILOT, on: true, perDay: 1, atOnce: 2 } })
  for (const k of ['PA', 'QA']) {
    const before = await s.addTask({ project: k, title: 'First', type: 'feature' })
    await s.saveTask({ ...before, state: 'working', step: { at: 0, started: true, done: true, proofs: {}, rounds: {} } })
    await s.addTask({ project: k, title: 'Then', type: 'feature', after: before.id })
  }
  const deps = { store: s, machines: () => [], call: async () => ({}) } as unknown as PmLaunchDeps
  expect(await startChained(deps)).toHaveLength(1)
  expect((await s.runs()).filter(r => r.role === 'worker')).toHaveLength(1)
})
