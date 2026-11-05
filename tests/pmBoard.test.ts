import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { board, userStep } from '../server/utils/pmBoard'
import { company } from '../shared/pm/examples'
import { cardOf } from '../shared/pm/board'
import { planSteps } from '../shared/pm/steps'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

let dir = ''
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

// "Merged" runs the step's git.verify-merged at once; with no worktree to check,
// the step stays open and the card stays in Your turn, saying why.
it('the Merged button runs the step\'s check, and a failed check stays in Your turn', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-board-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(company)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'company', addedAt: 1 }] }))
  const task = await store.addTask({ project: 'CO', title: 'Fix it', type: 'feature' })
  await store.saveTask({ ...task, state: 'working', step: { at: 4, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'user', badge: 'Merge the PR' } } })

  const deps = { store } as unknown as CoreAdminDeps & { store: typeof store }
  const after = await userStep(deps, task.id)
  expect(after.step).toMatchObject({ at: 4, yourTurn: { reason: 'action', badge: 'Merge the PR: No worktree: the task never started' } })
  expect(after.step?.acting).toBeUndefined()
  const { cards, projects } = await board(store)
  expect(projects[0]!.columns).toEqual(['To do', 'Working', 'Review', 'Deploy', 'Done'])
  expect(cards[0]).toMatchObject({ column: 'Review', step: 'merge', holder: 'none', userLabel: 'Merged', yourTurn: 'Merge the PR: No worktree: the task never started' })
})

it('a working task with no recorded step shows in its worker\'s step with its agent, and a proof link is the card\'s link', () => {
  const plan = planSteps(company, { type: 'feature' })
  const run = { id: 'r', task: 'CO-1', role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'b', instructions: '/i', terminal: 'host-a/t1', attempt: 1, state: 'running', startedAt: 1 } as const
  const task = { id: 'CO-1', project: 'CO', title: 'T', description: '', type: 'feature', state: 'working', createdAt: 1 } as const
  expect(cardOf(task, plan, [run])).toMatchObject({ phase: 'working', column: 'Working', step: 'work', holder: 'worker', terminal: 'host-a/t1' })
  const at4 = { ...task, step: { at: 4, started: true, rounds: {}, proofs: { pr: { link: 'https://example.com/pr/12' } } } }
  expect(cardOf(at4, plan, [run]).links).toEqual([{ label: 'pr', url: 'https://example.com/pr/12' }])
})
