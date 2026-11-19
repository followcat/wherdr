// The pace of a project whose worker is omp: no quota reading, no account, no pacing; only the task-count limits hold.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPmStore, type PmStore } from '../server/utils/pmStore'
import { projectPace } from '../server/utils/pmPace'
import { paceLine } from '../shared/pm/pace'
import { defaultWorkflow } from '../shared/pm/workflow'
import type { Quotas } from '../shared/types'

// Claude has a reading; omp has none.
const quotas = vi.hoisted(() => ({
  value: {
    claude: { at: 1_000, five: { used: 100, resetsAt: 1_000 + 3_600_000, minutes: 300 }, week: { used: 100, resetsAt: 1_000 + 86_400_000, minutes: 10080 } },
    codex: null,
    accounts: [{ key: 'claude:main', program: 'claude', machines: [''] }],
  } as unknown as Quotas,
}))
vi.mock('../server/utils/quotas', async orig => ({ ...(await orig<object>()), readQuotas: async () => quotas.value }))
vi.mock('../server/utils/pacingLog', async orig => ({ ...(await orig<object>()), accountUsedToday: async () => 12 }))
vi.mock('../server/utils/pacingPolicies', async orig => ({ ...(await orig<object>()), readPolicies: async () => ({}) }))

let dir = '', store: PmStore
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-pace-'))
  store = createPmStore(dir)
  await store.setEnabled(true)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'WEB', name: 'Web', machine: '', path: '/src/web', addedAt: 1 }] }))
})
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

describe('projectPace', () => {
  it('a worker on omp: no account, quota unknown, the task-count limits only', async () => {
    await store.saveWorkflow('WEB', { ...defaultWorkflow('WEB'), prefs: { agent: 'omp', model: 'anthropic/claude-sonnet-5-5' } })
    const pace = await projectPace(store, 'WEB', undefined, 2_000, true)
    expect(pace).toMatchObject({ program: 'omp', account: null, quota: null, today: null })
    expect(pace!.verdict.go).toBe(true)
    expect(paceLine(pace!, 2_000)).toBe('omp · no quota reading for OMP · task-count limits only')
  })
  it('a worker on Claude is still read from its account', async () => {
    await store.saveWorkflow('WEB', { ...defaultWorkflow('WEB'), prefs: { agent: 'claude', model: 'sonnet' } })
    const pace = await projectPace(store, 'WEB', undefined, 2_000)
    expect(pace).toMatchObject({ program: 'claude', account: { key: 'claude:main' }, quota: { at: 1_000 } })
  })
})
