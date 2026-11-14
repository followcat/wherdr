import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createPmStore } from '../server/utils/pmStore'
import { board, stepAction, userStep } from '../server/utils/pmBoard'
import { SCRIPT } from '../shared/pm/actions'
import { company, wherdr } from '../shared/pm/examples'
import type { Template } from '../shared/pm/workflow'
import { cardOf, cardStatus, linkLabel, mergeGoesNow, prNow, requiredChecks, shownTexts, statusText } from '../shared/pm/board'
import { planSteps } from '../shared/pm/steps'
import type { CoreAdminDeps } from '../server/utils/coreCreate'

let dir = ''
afterEach(() => fs.rm(dir, { recursive: true, force: true }))

// "I merged it" runs the step's git.verify-merged at once; with no worktree to check,
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
  expect(after.step).toMatchObject({ at: 4, yourTurn: { reason: 'action', badge: 'Merge the PR on your Git host: No worktree: the task never started' } })
  expect(after.step?.acting).toBeUndefined()
  // The user's own words (step done --user-said) end the step anyway; the check's answer is logged as a warning.
  const said = await userStep(deps, task.id, true)
  expect(said.step).toMatchObject({ at: 5 })
  expect(said.log?.at(-1)?.text).toBe('merge: verify-merged disagreed: No worktree: the task never started')
  await store.saveTask({ ...said, step: after.step })
  const { cards, projects } = await board(store)
  expect(projects[0]!.columns).toEqual(['To do', 'Working', 'Review', 'Deploy', 'Done'])
  expect(projects[0]!.types.find(x => x.id === 'feature')?.plan).toMatch(/ → review → /)
  expect(cards[0]).toMatchObject({ column: 'Review', step: 'merge', holder: 'none', userLabel: 'I merged it', yourTurn: 'Merge the PR on your Git host: No worktree: the task never started' })
  expect(cards[0]!.machine).toBeUndefined() // one machine: no need to name it

  // A project that allows several machines: the card names the one its task went to.
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'Company', machine: '', path: '/src/co', template: 'company', addedAt: 1, machines: ['', 'b'], clones: { b: '~/project' } }] }))
  await store.saveTask({ ...(await store.task(task.id))!, machine: 'b' })
  const known = [{ key: 'b', label: 'machine-b', local: false, status: 'online', error: null }] as unknown as Parameters<typeof board>[1]
  expect((await board(store, known)).cards[0]!.machine).toBe('machine-b')
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
  // Mergeable on GitHub, the review not approved yet: never 'ready to merge'.
  expect(cardStatus({ ...at(2), prNow: 'ready to merge' })).toEqual({ text: 'PR open · review pending', tone: 'wait' })
  expect(cardStatus({ ...at(3), prNow: 'ready to merge' })).toEqual({ text: 'PR open · ready to merge', tone: 'wait' })
  const failed = (error: string) => at(3, { yourTurn: { reason: 'action', badge: `merge: ${error}`, error } })
  expect(cardStatus(failed('merge: 1 check(s) failed'))).toEqual({ text: 'checks failed', tone: 'bad' })
  expect(cardStatus(failed('merge: the PR head is not the task\'s commit'))).toEqual({ text: 'The PR is not at the task\'s latest commit', tone: 'bad' })
  expect(cardStatus({ ...at(3), stopped: { by: 'user', why: '', at: 1 } })).toBeUndefined()
  const done = { plan, state: { at: plan.length - 1, started: true, done: true, since: 5, proofs: { merge: { link: pr.url, commit: 'abc' } }, rounds: {} } }
  expect(cardStatus(done)).toEqual({ text: 'merged', tone: 'ok', at: 5 })
  expect(cardStatus({ ...done, state: { ...done.state, proofs: {} } })).toBeUndefined() // done without a merge
  expect(linkLabel({ label: 'pr', url: pr.url })).toBe('PR #7')
})

it('an approved merge with red checks says what the fix waits for, never that it merges by itself', () => {
  // A merge the user approves (it waits for them).
  const plan = planSteps(wherdr, { type: 'simple' }, 'v3').map(p => (p.id === 'merge' ? { ...p, ends: 'user' as const } : p))
  const merge = (more: object, card: object = {}) => ({ plan, prNow: 'checks failed (smoke)', queue: 1, queueOut: 'checks failed', yourTurn: undefined, state: { at: plan.findIndex(p => p.id === 'merge'), started: true, proofs: {}, rounds: {}, approved: { by: 'user' as const, at: 1 }, ...more }, ...card })
  const say = (c: ReturnType<typeof merge>) => { const s = cardStatus(c)!; return { text: statusText(s, String), tone: s.tone, spins: mergeGoesNow(c) } }
  const agent = { kind: 'ci-to-agent', head: 'abc', at: 1 }
  const room = 'Waits for room (Heavy to the strongest): heavy (≈3.4 GB) fits nowhere — machine-a: 3.1 GB free, needs 3.9 GB with its reserve'
  expect(say(merge({ agent: { ...agent, waits: room } }))).toEqual({ text: 'Checks failed (smoke): waits for its worker, no room on machine-a (needs ≈3.4 GB: 3.1 GB free, needs 3.9 GB with its reserve)', tone: 'bad', spins: false })
  expect(say(merge({ agent: { ...agent, waits: 'Waits for its machine (offline)' } })).text).toBe('Checks failed (smoke): waits for its worker, its machine is offline')
  expect(say(merge({ agent }))).toEqual({ text: 'Checks failed (smoke): fixing: the worker is on it', tone: 'wait', spins: false })
  // Green: as before, in line and merging by itself.
  expect(say(merge({}, { prNow: 'ready to merge', queueOut: undefined }))).toEqual({ text: 'Approved, merges by itself · 1st in merge queue', tone: 'wait', spins: true })
  // Green after a rerun while the fix is still handed out: not red any more, Merge goes on.
  const rerun = merge({ agent }, { prNow: 'ready to merge', queueOut: undefined })
  expect([cardStatus(rerun)!.text.startsWith('Checks failed'), mergeGoesNow(rerun)]).toEqual([false, true])
})

it('a card\'s texts read each task id with its project\'s shown key, stored before the key changed too; its ids stay stored', () => {
  const plan = planSteps(company, { type: 'feature' })
  const t = { id: 'CP-17', project: 'CP', title: 'Add login', description: 'After CP-16', type: 'feature', state: 'waiting', waiting: 'CP-16, which this task starts after, stopped', createdAt: 1, after: 'CP-16', log: [{ at: 1, by: 'engine', text: 'waits for CP-16 on branch task/CP-16' }] } as const
  const c = shownTexts([{ key: 'CP', label: 'CMP' }], cardOf(t as never, plan, []))
  expect(c.yourTurn).toMatch(/^CMP-16, which this task starts after, stopped/)
  expect(c.description).toBe('After CMP-16')
  expect(c.log[0]!.text).toBe('waits for CMP-16 on branch task/CP-16')
  expect([c.id, c.after]).toEqual(['CP-17', ['CP-16']])
})

// The wherdr project's simple task (todo, work, pr, review, merge, done) at pr,
// its worker's worktree on this machine; git answers through `git`.
async function atPr(git: (script: string, args: string[]) => { code: number, out: string }) {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-board-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(wherdr)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'WH', name: 'wherdr', machine: '', path: '/src/wh', template: 'wherdr', addedAt: 1 }] }))
  const task = await store.addTask({ project: 'WH', title: 'Fix it', type: 'simple' })
  await store.saveTask({ ...task, state: 'working', step: { at: 2, started: true, proofs: {}, rounds: {}, yourTurn: { reason: 'action', badge: 'pr: failed', error: 'failed' } } })
  await store.saveRun({ id: 'r1', task: task.id, role: 'worker', program: 'claude', model: 'm', machine: '', worktree: '/w', branch: 'task/WH-1', instructions: '/i', attempt: 1, state: 'running', startedAt: 1 })
  const scripts: string[][] = []
  const call = async (method: string, p: { argv: string[] }) => {
    if (method !== 'machine.exec') throw new Error(`unexpected ${method}`)
    const [, , script, , ...args] = p.argv
    scripts.push(args)
    const r = git(script!, args)
    return { code: r.code, stdout: Buffer.from(r.out).toString('base64') }
  }
  const deps = { store, call, machines: () => [{ key: '', label: 'here', local: true }] } as unknown as CoreAdminDeps & { store: typeof store }
  // The new workflow: pr and merge replaced by a landing on develop, now open to the engine.
  const t = (await store.workflow('WH'))!
  const land = { id: 'land', column: 'Merging', ends: 'action', action: { kind: 'git.land', target: 'develop' } } as const
  const next: Template = { ...t, guards: { protected: ['main'], merge: { protected: 'user', others: 'engine' } },
    taskTypes: { ...t.taskTypes, simple: { steps: [{ id: 'todo' }, 'work', land, { id: 'done' }] } } }
  await store.saveWorkflow('WH', next, { by: 'user' })
  return { store, deps, scripts, id: task.id }
}

it('a workflow change that replaces pr and merge with a landing moves the task onto it, and the engine lands', async () => {
  const { store, deps, scripts, id } = await atPr(script => (script.includes(SCRIPT.land) ? { code: 0, out: 'abc123' } : { code: 1, out: '' }))
  const moved = (await store.task(id))!
  expect(moved.step).toMatchObject({ at: 2, acting: true, tries: { land: 1 } })
  expect(moved.step?.yourTurn).toBeUndefined()
  expect(moved.log!.at(-1)).toMatchObject({ by: 'engine', text: 'workflow changed: pr is gone, on to land' })
  const after = await stepAction(deps, id, 'engine')
  expect(scripts[0]).toEqual(['/w', 'develop'])
  expect(after.step).toMatchObject({ done: true, proofs: { land: { commit: 'abc123' } } })
})

it('a refused push leaves why in the task\'s log', async () => {
  const refused = ' ! [remote rejected] HEAD -> develop (protected branch hook declined)\nerror: failed to push some refs\nhint: see the docs'
  const { deps, id } = await atPr(() => ({ code: 1, out: refused }))
  const after = await stepAction(deps, id, 'engine')
  expect(after.step).toMatchObject({ at: 2, yourTurn: { reason: 'action' } })
  expect(after.log!.at(-1)).toMatchObject({ by: 'engine', text: 'land: push to develop refused: protected branch hook declined' })
})

it('the first accepted workflow moves tasks that followed the default one', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-board-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'NP', name: 'new', machine: '', path: '/src/np', addedAt: 1 }] }))
  expect((await store.workflow('NP'))?.version).toBe(0) // the default: todo, work, done
  const task = await store.addTask({ project: 'NP', title: 'Fix it', type: 'task' })
  await store.saveTask({ ...task, state: 'working', step: { at: 1, started: true, proofs: {}, rounds: {} } })
  const land = { id: 'land', ends: 'action', action: { kind: 'git.land', target: 'develop' } } as const
  await store.saveWorkflow('NP', { id: 'np', prefs: { agent: 'claude', model: 'sonnet' }, taskTypes: { task: { steps: [{ id: 'todo' }, land, { id: 'done' }] } } }, { by: 'user' })
  const moved = (await store.task(task.id))!
  expect(moved.step).toMatchObject({ at: 1, acting: true, tries: { land: 1 } })
  expect(moved.log!.at(-1)).toMatchObject({ by: 'engine', text: 'workflow changed: work is gone, on to land' })
})
