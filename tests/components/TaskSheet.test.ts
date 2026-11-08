import { expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import TaskSheet from '~/components/TaskSheet.vue'
import { initialState, planSteps, type StepState } from '#shared/pm/steps'
import { wherdr } from '#shared/pm/examples'
import { readBody } from 'h3'
import type { Card } from '#shared/pm/board'

const badge = 'Look at the screenshots, then merge: merge: the PR head is not the task\'s commit'
let release: () => void = () => {}
registerEndpoint('/api/pm/step-user', { method: 'POST', handler: async () => {
  await new Promise<void>((r) => { release = r })
  return { task: { id: 'WHR-1', step: { ...initialState(), started: true, at: 1, yourTurn: { reason: 'action', badge } } } }
} })

const card: Card = {
  id: 'WHR-1', project: 'WHR', title: 'A task', description: '', column: 'Merging', phase: 'working', step: 'merge', holder: 'none',
  yourTurn: 'Look at the screenshots, then merge', userLabel: 'Merge', tags: [], links: [], log: [], plan: [], state: { ...initialState(), started: true, at: 1 },
}
const stubs = { AppSheet: { template: '<section><slot /></section>' } }

it('shows the merge running, then a refusal in plain words under the button and on the badge', async () => {
  const w = await mountSuspended(TaskSheet, { props: { card }, global: { stubs } })
  await w.get('[data-testid="step-user"]').trigger('click')
  await vi.waitFor(() => expect(w.find('[data-testid="step-user-busy"]').exists()).toBe(true))
  release()
  const said = 'The PR on GitHub is not at the task\'s latest commit'
  await vi.waitFor(() => expect(w.get('[data-testid="step-user-refused"]').text()).toContain(said))
  expect(w.find('[data-testid="step-user-busy"]').exists()).toBe(false)
  expect(w.find('[data-testid="task-badge"]').exists()).toBe(false) // said once, under the button
  // The board read again: the badge carries the refusal, phrased the same; a new step clears it.
  await w.setProps({ card: { ...card, yourTurn: badge } })
  expect(w.get('[data-testid="step-user-refused"]').text()).toContain(said)
  await w.setProps({ card: { ...card, yourTurn: 'Deploy' } })
  expect(w.find('[data-testid="step-user-refused"]').exists()).toBe(false)
  expect(w.get('[data-testid="task-badge"]').text()).toBe('Deploy')
  await w.setProps({ card: { ...card, yourTurn: 'Merge: merge: 2 check(s) failed' } })
  expect(w.get('[data-testid="task-badge"]').text()).toContain('2 check(s) failed on the PR: the agent is asked to fix them')
  w.unmount()
})

// Each case of a task waiting for the user opens on To do, with what it needs.
const plan = planSteps(wherdr, { type: 'visual' })
const at = (i: number, more: Partial<StepState> = {}): StepState => ({ ...initialState(), started: true, at: i, ...more })
const waiting = (more: Partial<Card>): Card => ({ ...card, plan, userLabel: undefined, ...more })
const cases: [string, Card, string, string[]][] = [
  ['a visual merge', waiting({
    yourTurn: 'Look at the screenshots, then merge', userLabel: 'Merge', links: [{ label: 'pr', url: 'https://github.com/o/r/pull/7' }],
    state: at(4, { yourTurn: { reason: 'user', badge: 'Look at the screenshots, then merge' }, rounds: { review: 1 }, shots: { work: [{ file: 'aaaaaaaaaaaa.png', phase: 'after', at: 1 }] } }),
  }), 'merge', ['todo-shots', 'step-user', 'todo-back', 'todo-pr', 'todo-verdict']],
  ['a decision after send-backs', waiting({
    yourTurn: 'Decide: review failed 4 times',
    state: at(3, { yourTurn: { reason: 'rounds', badge: 'Decide: review failed 4 times', advice: { outcome: 'round', why: 'New finding: x', options: ['round', 'split'], findings: [] } } }),
  }), 'decide', []],
  ['a stopped task', waiting({ yourTurn: 'Stopped by the user: wrong way', stopped: { by: 'the user', why: 'wrong way', at: 1 }, state: at(1) }), 'stopped', []],
  ['a step the user ends', waiting({ yourTurn: 'Deploy it', userLabel: 'Deployed', state: at(4, { yourTurn: { reason: 'user', badge: 'Deploy it' } }) }), 'step', ['step-user']],
  ['an agent question', waiting({ yourTurn: 'Which port?', asks: { kind: 'question', text: 'Which port?' }, state: at(1) }), 'ask', []],
  ['a refused merge', waiting({ yourTurn: 'Merge: merge: 2 check(s) failed', state: at(4, { yourTurn: { reason: 'action', badge: 'Merge: merge: 2 check(s) failed' } }) }), 'refused', ['step-user']],
  ['a blocked task', waiting({ yourTurn: 'WHR-2, which this task starts after, failed', phase: 'todo', state: undefined }), 'blocked', ['task-start']],
]

it.each(cases)('%s opens on To do with what it needs', async (_, c, kind, shown) => {
  const w = await mountSuspended(TaskSheet, { props: { card: c }, global: { stubs } })
  expect(w.get('[role="tab"][aria-selected="true"]').attributes('data-tab')).toBe('todo')
  expect(w.get('[data-testid="task-todo"]').attributes('data-todo')).toBe(kind)
  for (const id of shown) expect(w.find(`[data-testid="${id}"]`).exists(), id).toBe(true)
  if (kind === 'decide') expect(w.findAll('[data-choice]').map(b => b.attributes('data-choice'))).toEqual(['round', 'split'])
  if (kind === 'stopped') expect(w.findAll('[data-resume]').map(b => b.attributes('data-resume'))).toEqual(['continue', 'as-is', 'archive'])
  if (kind === 'ask') expect(w.get('[data-testid="task-badge"]').text()).toBe('Which port?')
  w.unmount()
})

it('a task not waiting for the user opens as before, on its description', async () => {
  const w = await mountSuspended(TaskSheet, { props: { card: { ...card, description: 'Do it', yourTurn: undefined, userLabel: undefined } }, global: { stubs } })
  expect(w.get('[role="tab"][aria-selected="true"]').attributes('data-tab')).toBe('description')
  expect(w.find('[data-tab="todo"]').exists()).toBe(false)
  w.unmount()
})

let sentBack: unknown
registerEndpoint('/api/pm/step-back', { method: 'POST', handler: async (e) => { sentBack = await readBody(e); return { task: {} } } })
it('a visual merge is sent back with a note', async () => {
  const w = await mountSuspended(TaskSheet, { props: { card: cases[0]![1] }, global: { stubs } })
  await w.get('textarea[data-testid="todo-back-note"]').setValue('The button is cut on the phone')
  await w.get('[data-testid="todo-back"]').trigger('submit')
  await vi.waitFor(() => expect(sentBack).toEqual({ id: 'WHR-1', note: 'The button is cut on the phone' }))
  w.unmount()
})
