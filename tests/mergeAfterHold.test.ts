import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { stepAction, userStep } from '../server/utils/pmBoard'
import { SCRIPT } from '../shared/pm/actions'
import { cardOf } from '../shared/pm/board'
import { runsNow } from '../shared/pm/advance'
import { planSteps, type Step } from '../shared/pm/steps'
import type { Template } from '../shared/pm/workflow'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

let dir = ''
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

// A project whose task type is todo, one merge step, done; WS-2 merges after WS-1.
// by: who the guards give merges to.
// With no worktree, an action that runs fails with "No worktree": that is how a test sees it ran.
async function setup(merge: Step, by: 'engine' | 'user' = 'engine') {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-merge-after-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'WS', name: 'ws', machine: '', path: '/src/ws', addedAt: 1 }] }))
  const t: Template = { id: 'ws', prefs: { agent: 'claude', model: 'sonnet' }, guards: { merge: { protected: by, others: by } }, taskTypes: { task: { steps: [{ id: 'todo' }, merge, { id: 'done' }] } } }
  await store.saveWorkflow('WS', t, { by: 'user' })
  const up = await store.addTask({ project: 'WS', title: 'API', type: 'task' })
  await store.saveTask({ ...up, state: 'working', step: { at: 1, started: true, proofs: {}, rounds: {} } })
  const task = await store.addTask({ project: 'WS', title: 'Web app', type: 'task' })
  const acting = merge.ends === 'action' ? { acting: true, tries: { [merge.id]: 1 } } : {}
  await store.saveTask({ ...task, mergeAfter: up.id, state: 'working', step: { at: 1, started: true, proofs: {}, rounds: {}, ...acting } })
  const deps = { store } as unknown as CoreAdminDeps & { store: typeof store }
  const upDone = async () => store.saveTask({ ...(await store.task(up.id))!, step: { at: 2, started: true, done: true, proofs: {}, rounds: {} } })
  return { store, deps, up: up.id, id: task.id, upDone, plan: planSteps(t, { type: 'task' }) }
}

it.each([
  ['git.land', { id: 'land', ends: 'action', action: { kind: 'git.land', target: 'develop' } }],
  ['bitbucket.merge', { id: 'merge', ends: 'user', action: { kind: 'bitbucket.merge' } }],
  // Kept for the user by the guards: outside the queue, the engine's run goes to the user's Try again.
  ['github.merge outside the queue', { id: 'merge', ends: 'action', action: { kind: 'github.merge' } }, 'user'],
] as const)('%s waits for the tasks it merges after, then runs by itself', async (_, merge, by?: 'user') => {
  const { store, deps, up, id, upDone, plan } = await setup(merge as Step, by)
  // The engine's run (git.land) or the user's click: held, not run, the card says why.
  const held = merge.ends === 'action' ? await stepAction(deps, id, 'engine') : await userStep(deps, id)
  expect(held.step).toMatchObject({ at: 1, acting: true, mergeWait: `Merges once ${up} is done` })
  expect(held.step?.yourTurn).toBeUndefined()
  expect(held.log?.at(-1)?.text).toBe(`${merge.id}: held: Merges once ${up} is done`)
  expect(cardOf(held, plan, []).held).toBe(`Merges once ${up} is done`)
  // The engine's pass runs it again after the queue's wait (pmAdvance.ts), not before.
  expect(runsNow(plan[1], held.step, Date.now())).toBe(false)
  expect(runsNow(plan[1], held.step, Date.now() + 31_000)).toBe(true)
  // Checked again while it still waits: held, said once.
  expect((await stepAction(deps, id, 'engine')).log).toHaveLength(held.log!.length)
  // Done: the engine's next pass runs the merge (here it fails on the missing worktree).
  await upDone()
  const ran = await stepAction(deps, id, 'engine')
  expect(ran.step).toMatchObject({ at: 1, yourTurn: { reason: 'action' } })
  expect(ran.step?.mergeWait).toBeUndefined()
  expect(ran.step?.watch).toBeUndefined()
  expect((await store.task(id))!.log?.at(-1)?.text).toMatch(/No worktree/)
})

it('a stopped task it merges after keeps it waiting and wakes its coordinator once', async () => {
  const { store, deps, up, id } = await setup({ id: 'land', ends: 'action', action: { kind: 'git.land', target: 'develop' } })
  await store.saveTask({ ...(await store.task(up))!, stopped: { at: 5, by: 'user', why: 'paused' } })
  const held = await stepAction(deps, id, 'engine')
  expect(held.step?.mergeWait).toBe(`Merges once ${up} is done`)
  expect(held.mech?.[`merge-after:${up}:5`]).toBeTypeOf('number')
  expect(held.log?.some(e => e.text.includes(`merges after ${up}, which was stopped`))).toBe(true)
  const again = await stepAction(deps, id, 'engine')
  expect(again.log?.filter(e => e.text.includes('which was stopped'))).toHaveLength(1)
})

it('"I merged it" before a task it merges after is done is accepted, with a warning in the log', async () => {
  const { deps, up, id } = await setup({ id: 'merge', ends: 'user', action: { kind: 'git.verify-merged', target: 'develop' } })
  // The user's own words end the step (no worktree to check here); the early merge is logged.
  const after = await userStep(deps, id, true)
  expect(after.step).toMatchObject({ at: 2 })
  expect(after.log?.at(-1)?.text).toMatch(new RegExp(`merged before ${up} was done: the merge order \\(merge after\\) was not kept`))
})

// The user's click on a merge the guards keep for them: held, then run by the engine as theirs.
it('a held click on a merge kept for the user lands once the upstream is done, under the user\'s guard', async () => {
  const { store, id, upDone } = await setup({ id: 'land', ends: 'user', action: { kind: 'git.land', target: 'develop' } }, 'user')
  await store.saveRun({ id: 'r1', task: id, role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'task/WS-2', instructions: '/i', attempt: 1, state: 'running', startedAt: 1 })
  const landed: string[][] = []
  const call = async (_: string, p: { argv: string[] }) => {
    const [, , script, , ...args] = p.argv
    if (script!.includes(SCRIPT.land)) landed.push(args)
    return { code: script!.includes(SCRIPT.land) ? 0 : 1, stdout: Buffer.from(script!.includes(SCRIPT.land) ? 'abc123' : '').toString('base64') }
  }
  const deps = { store, call, machines: () => [{ key: '', label: 'here', local: true }] } as unknown as CoreAdminDeps & { store: typeof store }
  expect((await userStep(deps, id)).step).toMatchObject({ mergeWait: 'Merges once WS-1 is done', mergeBy: 'user' })
  expect(landed).toHaveLength(0)
  await upDone()
  const after = await stepAction(deps, id, 'engine')
  expect(landed).toHaveLength(1)
  expect(after.step).toMatchObject({ done: true, proofs: { land: { commit: 'abc123' } } })
})
