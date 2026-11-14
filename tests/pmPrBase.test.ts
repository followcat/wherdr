// The branch line's PR base: kept on the task, read for a PR its worker opened, kept once done.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { userStep } from '../server/utils/pmBoard'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

// The merge action's GitHub call: the PR, retargeted to develop, merged there.
vi.mock('../server/utils/pmActions', async orig => ({ ...await orig<typeof import('../server/utils/pmActions')>(),
  actionShell: () => async () => ({ code: 0, out: '' }),
  runAction: async () => ({ ok: true, link: 'https://github.com/o/r/pull/7', commit: 'abc', base: 'develop' }),
}))
vi.mock('../server/utils/pmLaunch', async orig => ({ ...await orig<typeof import('../server/utils/pmLaunch')>(), runOn: () => undefined }))
import { keepPrBase } from '../server/utils/pmMechanic'
import { branchLine, cardOf } from '../shared/pm/board'
import { linkedPr, prLink, type Run, type Task } from '../shared/pm/run'
import { initialState, planSteps } from '../shared/pm/steps'
import { company, wherdr } from '../shared/pm/examples'
import type { PrInfo } from '../shared/pm/actions'
import type { PmStore } from '../server/utils/pmStore'

const task: Task = { id: 'CO-1', project: 'CO', title: 'A task', description: '', type: 'feature', state: 'working', createdAt: 1, step: { ...initialState(), started: true, at: 1 } }
const pr = (base: string): PrInfo => ({ url: 'https://github.com/o/r/pull/3', baseRefName: base, headRefOid: 'h', commits: [{}, {}] })

it('a PR its worker linked in a report is read too, by its address, not only one a PR step opened', () => {
  expect(prLink(task)).toBeUndefined()
  expect(prLink({ ...task, step: { ...task.step!, proofs: { work: { link: 'https://github.com/o/r/pull/7/files' } } } })).toBe('https://github.com/o/r/pull/7')
  expect(prLink({ ...task, links: [{ label: 'Ticket', url: 'https://example.com/t/1' }] })).toBeUndefined()
  // A newer PR of the same branch, listed first, is not the one the worker reported.
  const prs = [{ ...pr('develop'), url: 'https://github.com/o/r/pull/8' }, { ...pr('v3'), url: 'https://github.com/o/r/pull/7' }]
  expect(linkedPr(prs, 'https://github.com/o/r/pull/7')?.baseRefName).toBe('v3')
  expect(linkedPr(prs, 'https://github.com/o/r/pull/9')).toBeUndefined()
})

it('keeps the PR\'s base on the task, saved only when it changes', async () => {
  let disk = task
  const updateTask = vi.fn(async (_id: string, change: (t: Task) => Task) => (disk = change(disk)))
  const store = { updateTask } as unknown as PmStore
  const kept = await keepPrBase(store, task, pr('v3'))
  expect(kept.prBase).toEqual({ base: 'v3', commits: 2 })
  await keepPrBase(store, kept, pr('v3'))
  expect(updateTask).toHaveBeenCalledTimes(1)
  expect((await keepPrBase(store, kept, undefined)).prBase).toBeUndefined()
})

it('a done task still says where its PR went, not where the workflow would send it', () => {
  // The worker's PR to v3 on a workflow that checks develop; a merged PR to develop on one that opens it to v3.
  const run: Run = { id: 'r', task: 'CO-1', role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'task/CO-1', instructions: '/i', attempt: 1, state: 'ended', startedAt: 1 }
  const co = cardOf({ ...task, prBase: { base: 'v3' } }, planSteps(company, { type: 'feature' }, 'develop'), [run])
  expect(branchLine(co, 'develop')?.base).toBe('v3')
  const plan = planSteps(wherdr, { type: 'simple' }, 'v3')
  const done = cardOf({ ...task, type: 'simple', prBase: { base: 'develop' }, step: { ...initialState(), started: true, at: plan.length - 1, done: true } }, plan, [run])
  expect(branchLine(done, 'v3')?.base).toBe('develop')
})

it('a merge keeps the base it went to on the task, which the mechanic no longer reads once done', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-prbase-'))
  try {
    const store = createPmStore(dir)
    await store.setEnabled(true)
    await store.saveTemplate(wherdr)
    await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'WHR', name: 'wherdr', machine: '', path: '/src/w', template: 'wherdr', base: 'v3', addedAt: 1 }] }))
    const t = await store.addTask({ project: 'WHR', title: 'Visual fix', type: 'visual' })
    await store.saveTask({ ...t, state: 'working', step: { ...initialState(), started: true, at: 4, approved: { by: 'user', at: 1 }, yourTurn: { reason: 'user', badge: 'Merge' } } })
    await store.saveRun({ id: 'r1', task: t.id, role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '/w', branch: `task/${t.id}`, instructions: '/i', attempt: 1, state: 'running', startedAt: 1 })
    const after = await userStep({ store } as unknown as CoreAdminDeps & { store: typeof store }, t.id)
    expect(after.step?.done).toBe(true)
    expect(after.prBase).toEqual({ base: 'develop' })
    const card = cardOf(after, planSteps(wherdr, { type: 'visual' }, 'v3'), await store.runs())
    expect(branchLine(card, 'v3')?.base).toBe('develop')
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
