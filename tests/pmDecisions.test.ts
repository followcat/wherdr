import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { decisionGroups, decisionsOf, decisionsPush, type DecisionsInput } from '../shared/pm/decisions'
import { initialState, onEvent, planSteps, type StepEvent, type StepState } from '../shared/pm/steps'
import { github } from '../shared/pm/examples'
import type { Card } from '../shared/pm/board'
import type { Finding } from '../shared/pm/verdict'
import type { Wake } from '../shared/pm/wakes'
import { createPmStore } from '../server/utils/pmStore'
import { userDecide } from '../server/utils/pmBoard'
import { decisions, decisionsTick, resetDecisionsTold } from '../server/utils/pmDecisions'

const card = (id: string, state: Partial<StepState>, more: Partial<Card> = {}): Card => ({
  id, project: 'CO', title: `Task ${id}`, description: '', column: 'Review', phase: 'working', step: 'review', holder: 'none', tags: [], links: [], log: [], plan: [],
  state: { ...initialState(), started: true, at: 3, since: 10, ...state }, ...more,
})
const advice = (outcome: 'round' | 'arbitrate' | 'your-turn', options: ('round' | 'split' | 'worker' | 'reviewer')[]) => ({ reason: 'rounds' as const, badge: 'Decide: review failed 3 times', advice: { outcome, why: 'New finding: crash', options, findings: ['bug'] } })
const wake = (id: string, createdAt: number, more: Partial<Wake> = {}): Wake => ({ id, coordinator: 'CO', reasons: ['CO-1: done'], createdAt, tries: 2, ...more })

const input = (more: Partial<DecisionsInput> = {}): DecisionsInput => ({
  cards: [
    card('CO-1', { yourTurn: { reason: 'timeout', badge: 'Check deploy: over 90m' } }, { terminal: 'h/t1' }),
    card('CO-2', { yourTurn: advice('arbitrate', ['worker', 'reviewer']), since: 5 }),
    card('CO-3', { yourTurn: advice('round', ['round', 'split']), since: 20 }),
    card('CO-4', { yourTurn: { reason: 'user', badge: 'Merge the PR' } }, { userLabel: 'Merged' }),
    card('CO-5', {}, { terminal: 'h/t5' }),
    card('CO-6', { done: true, yourTurn: { reason: 'user', badge: 'old' } }),
  ],
  tasks: [{ id: 'CO-5', state: 'waiting', waitKind: 'permission' }, { id: 'CO-1', state: 'working' }],
  coordinators: [{ project: 'CO', name: 'Company', proposal: { at: 7, said: 'add a deploy step' } }],
  wakes: [wake('aaaaaaa1', 1, { ended: 'unanswered', endedAt: 30 })],
  ...more,
})

it('groups what waits for the user, the recommended answer first', () => {
  const ds = decisionsOf(input())
  expect(decisionGroups(ds).map(g => [g.group, g.items.map(d => d.task ?? d.project)])).toEqual([
    ['agent', ['CO-5']], ['arbitrate', ['CO-3', 'CO-2']], ['proposal', ['CO']], ['step', ['CO-4']], ['overdue', ['CO-1']], ['coordinator', ['CO']],
  ])
  const by = (t: string) => ds.find(d => d.task === t)!
  expect(by('CO-5')).toMatchObject({ kind: 'permission', terminal: 'h/t5', text: 'Asks for a permission' })
  // The engine's outcome is among the options: recommended and first.
  expect(by('CO-3')).toMatchObject({ recommend: 'round', options: ['round', 'split'], text: 'Decide: review failed 3 times: New finding: crash' })
  // An arbitration recommends nothing; with no option for the coordinator, every choice is the user's.
  expect(by('CO-2').recommend).toBeUndefined()
  expect(decisionsOf(input({ cards: [card('CO-7', { yourTurn: advice('your-turn', []) })] }))[0]!.options).toHaveLength(7)
  expect(by('CO-4')).toMatchObject({ label: 'Merged', text: 'Merge the PR' })
  expect(ds.find(d => d.group === 'proposal')!.text).toBe('After your message: “add a deploy step”')
})

it('shows a pass on a spec change for a day, without a push', () => {
  const specPass = { at: 1000, step: 'review', reason: 'Per the spec change of 2026-11-09.' }
  const at = (now: number) => decisionsOf(input({ cards: [card('CO-8', {})], tasks: [{ id: 'CO-8', state: 'working', specPass }], coordinators: [], wakes: [], now }))
  expect(at(2000)).toEqual([expect.objectContaining({ group: 'passed', text: 'The coordinator passed review on a spec change: Per the spec change of 2026-11-09.' })])
  expect(decisionsPush(at(2000), new Set())).toBeNull()
  expect(at(1000 + 24 * 3600_000)).toEqual([])
})

it('drops an unanswered wake once the coordinator acked a later one', () => {
  const wakes = [wake('aaaaaaa1', 1, { ended: 'unanswered' }), wake('aaaaaaa2', 2, { ackedAt: 3, ended: 'ack' })]
  expect(decisionsOf(input({ wakes })).some(d => d.group === 'coordinator')).toBe(false)
})

it('pushes once for what is new, the count of all', () => {
  const ds = decisionsOf(input())
  expect(decisionsPush(ds, new Set(ds.map(d => d.id)))).toBeNull()
  const told = new Set(ds.filter(d => d.task !== 'CO-4').map(d => d.id))
  expect(decisionsPush(ds, told)).toEqual({ title: '7 decisions wait for you', titleFr: '7 décisions t’attendent', body: 'CO-4: Merge the PR' })
  expect(decisionsPush(ds, new Set())!.body.split('\n')).toEqual(['CO-5: Asks for a permission', 'CO-3: Decide: review failed 3 times: New finding: crash', 'CO-2: Decide: review failed 3 times: New finding: crash', '+4 more'])
})

let dir = ''
afterEach(() => fs.rm(dir, { recursive: true, force: true }))
const project = { key: 'GH', name: 'GitHub', machine: '', path: '/src/gh', template: 'github', addedAt: 1 }
const bug: Finding = { id: 'bug', severity: 'major', title: 'Crashes', proof: 'npm test: 1 failed' }

it('titles a proposal decision by the coordinator name the user saved', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-decisions-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ ...project, name: 'Website', coordinatorName: 'Pilot' }] }))
  await fs.mkdir(store.files.coordinators, { recursive: true })
  await fs.writeFile(path.join(store.files.coordinators, 'GH.json'), JSON.stringify({ project: 'GH', tokenHash: '', proposal: { template: github, diff: '+ x', at: 5, base: 1 } }))
  expect((await decisions(store)).find(d => d.group === 'proposal')).toMatchObject({ project: 'GH', title: 'Pilot' })
})

it('the user settles a review in one tap, and the grouped push tells only what is new', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-decisions-'))
  const store = createPmStore(dir)
  await store.setEnabled(true)
  await store.saveTemplate(github)
  await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [project] }))
  // Three failed reviews: the after-N rule hands it to the user.
  const plan = planSteps(github, { type: 'simple' })
  let state = initialState()
  const back: StepEvent[] = [{ kind: 'report', from: 'worker' }, { kind: 'action-result', ok: true }, { kind: 'verdict', from: 'reviewer', findings: [bug] }]
  for (const ev of [{ kind: 'start' } as StepEvent, ...back, ...back, ...back]) state = onEvent(plan, state, ev, 1).state
  const task = await store.saveTask({ ...(await store.addTask({ project: 'GH', title: 'Fix it', type: 'simple' })), state: 'working', step: state })

  resetDecisionsTold()
  const notify = vi.fn(async () => {})
  expect(await decisionsTick(store, notify)).toBeNull() // the first look only notes
  await store.saveTask({ ...task, state: 'waiting', waitKind: 'question', waiting: 'Which port?' })
  expect(await decisionsTick(store, notify)).toEqual({ title: '2 decisions wait for you', titleFr: '2 décisions t’attendent', body: 'GH-1: Which port?' })
  expect(notify).toHaveBeenCalledTimes(1)
  expect(await decisionsTick(store, notify)).toBeNull()

  await expect(userDecide(store, task.id, 'nope')).rejects.toThrow(/choice: one of/)
  const after = await userDecide(store, task.id, 'pass')
  expect(after.step?.yourTurn).toBeUndefined()
  expect(after.log?.at(-1)).toMatchObject({ by: 'user', text: expect.stringMatching(/^review: user chose pass/) })
  await expect(userDecide(store, task.id, 'pass')).rejects.toThrow('Nothing to decide')
})

describe('Allow / Deny on a permission', () => {
  it('picks the prompt\'s own Yes or No; Deny falls back to Esc; no prompt, nothing', async () => {
    const { permissionKeys } = await import('../server/utils/pmPermission')
    const claude = { question: 'Do you want to proceed?', cursor: 0, options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'Yes, and don\'t ask again for npm test' }, { n: 3, label: 'No, and tell Claude what to do differently (esc)' }] }
    expect(permissionKeys(claude, true)).toEqual(['enter'])
    expect(permissionKeys(claude, false)).toEqual(['down', 'down', 'enter'])
    expect(permissionKeys({ ...claude, options: [{ n: 1, label: 'Run it' }] }, false)).toEqual(['esc'])
    expect(permissionKeys({ ...claude, options: [{ n: 1, label: 'Run it' }] }, true)).toBeNull()
    expect(permissionKeys(null, true)).toBeNull()
  })

  it('reads the agent\'s screen only (herdr-core answers no history read of a Claude terminal), then sends the keys', async () => {
    const { answerPermission } = await import('../server/utils/pmPermission')
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pm-perm-'))
    try {
      const store = createPmStore(dir)
      await store.setEnabled(true)
      await fs.writeFile(store.files.projects, JSON.stringify({ v: 1, projects: [{ key: 'CO', name: 'CO', machine: '', path: '/src', addedAt: 1 }] }))
      const t = await store.addTask({ project: 'CO', title: 'Fix', type: 'feature' })
      await store.saveRun({ id: 'r1', task: t.id, role: 'worker', program: 'claude', model: 'opus', machine: '', worktree: '/w', branch: 'b', instructions: '', terminal: 'h/t3', attempt: 1, state: 'running', startedAt: 1 })
      await store.saveTask({ ...t, state: 'waiting', waitKind: 'permission', waiting: 'approve Bash: touch a', run: 'r1' })
      const calls: [string, Record<string, unknown>][] = []
      const screen = ' Bash command\n   touch a\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again for touch commands\n   3. No, and tell Claude what to do differently (esc)\n\n Esc to cancel'
      const call = async (m: string, p: Record<string, unknown>) => { calls.push([m, p]); return m === 'terminal.read' ? { text: screen } : {} }
      const saved = await answerPermission({ store, call } as unknown as Parameters<typeof answerPermission>[0], t.id, false)
      expect(calls).toEqual([['terminal.read', { terminal: 'h/t3', lines: 0 }], ['terminal.keys', { terminal: 'h/t3', keys: ['down', 'down', 'enter'] }]])
      expect(saved).toMatchObject({ state: 'working', waitKind: undefined })
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
