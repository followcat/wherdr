import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { board, userStep } from '../server/utils/pmBoard'
import { company, wherdr } from '../shared/pm/examples'
import { cardOf, cardStatus, linkLabel, prNow, requiredChecks } from '../shared/pm/board'
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
  expect(projects[0]!.types.find(x => x.id === 'feature')?.plan).toMatch(/ → review → /)
  expect(cards[0]).toMatchObject({ column: 'Review', step: 'merge', holder: 'none', userLabel: 'Merged', yourTurn: 'Merge the PR: No worktree: the task never started' })
})

it('a working task with no recorded step shows in its worker\'s step with its agent, and a proof link is the card\'s link', () => {
  const plan = planSteps(company, { type: 'feature' })
  const run = { id: 'r', task: 'CO-1', role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'b', instructions: '/i', terminal: 'host-a/t1', attempt: 1, state: 'running', startedAt: 1 } as const
  const task = { id: 'CO-1', project: 'CO', title: 'T', description: '', type: 'feature', state: 'working', createdAt: 1 } as const
  expect(cardOf(task, plan, [run])).toMatchObject({ phase: 'working', column: 'Working', step: 'work', holder: 'worker', terminal: 'host-a/t1' })
  const at4 = { ...task, step: { at: 4, started: true, rounds: {}, proofs: { pr: { link: 'https://example.com/pr/12' } } } }
  expect(cardOf(at4, plan, [run]).links).toEqual([{ label: 'pr', url: 'https://example.com/pr/12' }])
  // The PR given again by the merge step and linked by the coordinator: shown once.
  const merged = { ...at4, links: [{ label: 'PR #12', url: 'https://example.com/pr/12' }], step: { ...at4.step, proofs: { ...at4.step.proofs, merge: { link: 'https://example.com/pr/12' } } } }
  expect(cardOf(merged, plan, [run]).links).toEqual([{ label: 'PR #12', url: 'https://example.com/pr/12' }])
})

// The status line of the wherdr template's simple task: work, pr, review, merge (squash, smoke).
it('the card says where its PR and merge stand: waiting for checks, merging, failed, merged', () => {
  const plan = planSteps(wherdr, { type: 'simple' }, 'v3')
  const at = (i: number, more: object = {}) => ({ plan, state: { at: plan.findIndex(p => p.id === ['work', 'pr', 'review', 'merge'][i]), started: true, proofs: {}, rounds: {}, ...more } })
  const pr = { url: 'https://github.com/o/r/pull/7', baseRefName: 'v3', headRefOid: 'abc', mergeStateStatus: 'BLOCKED' }
  const required = requiredChecks(plan)
  expect(required).toEqual(['smoke'])
  const waiting = prNow({ ...pr, statusCheckRollup: [{ name: 'unit', conclusion: 'SUCCESS' }] }, required)
  expect(waiting).toBe('waiting for checks (smoke)')
  expect(prNow({ ...pr, statusCheckRollup: [{ name: 'smoke', status: 'IN_PROGRESS' }] }, required)).toBe('waiting for checks (smoke)')
  expect(prNow({ ...pr, statusCheckRollup: [{ name: 'smoke', conclusion: 'FAILURE' }] }, required)).toBe('checks failed (smoke)')
  expect(prNow({ ...pr, statusCheckRollup: [{ name: 'smoke', conclusion: 'SUCCESS' }] }, required)).toBe('blocked by the branch rules')

  expect(cardStatus(at(0))).toBeUndefined() // no PR yet
  expect(cardStatus(at(1, { acting: true }))).toEqual({ text: 'opening the PR', tone: 'wait' })
  expect(cardStatus({ ...at(2), prNow: waiting })).toEqual({ text: 'PR open · waiting for checks (smoke)', tone: 'wait' })
  expect(cardStatus({ ...at(3, { acting: true }), prNow: waiting })).toEqual({ text: 'PR open · waiting for checks (smoke)', tone: 'wait' })
  expect(cardStatus({ ...at(3, { acting: true }), prNow: 'ready to merge' })).toEqual({ text: 'merging', tone: 'wait' })
  const failed = (error: string) => at(3, { yourTurn: { reason: 'action', badge: `merge: ${error}`, error } })
  expect(cardStatus(failed('merge: 1 check(s) failed'))).toEqual({ text: 'checks failed', tone: 'bad' })
  expect(cardStatus(failed('merge: the PR head is not the task\'s commit'))).toEqual({ text: 'blocked: the PR head is not the task\'s commit', tone: 'bad' })
  expect(cardStatus({ ...at(3), stopped: { by: 'user', why: '', at: 1 } })).toBeUndefined()
  const done = { plan, state: { at: plan.length - 1, started: true, done: true, since: 5, proofs: { merge: { link: pr.url, commit: 'abc' } }, rounds: {} } }
  expect(cardStatus(done)).toEqual({ text: 'merged', tone: 'ok', at: 5 })
  expect(cardStatus({ ...done, state: { ...done.state, proofs: {} } })).toBeUndefined() // done without a merge
  expect(linkLabel({ label: 'pr', url: pr.url })).toBe('PR #7')
})
