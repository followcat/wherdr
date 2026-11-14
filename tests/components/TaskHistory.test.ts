import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TaskHistory from '~/components/TaskHistory.vue'
import { initialState, planSteps } from '#shared/pm/steps'
import { wherdr } from '#shared/pm/examples'
import type { Card } from '#shared/pm/board'

const finding = (id: string, severity: 'minor' | 'major' | 'critical', title: string) => ({ id, severity, title, proof: 'seen' })
const worker = 'worker claude opus', reviewer = 'reviewer codex gpt'
const log = [
  { by: 'engine', text: 'work: sent to the worker' },
  { by: worker, text: 'work: done' },
  { by: reviewer, text: 'review: verdict, 2 finding(s)' },
  { by: worker, text: 'work: done' },
  { by: reviewer, text: 'review: verdict, 1 finding(s)' },
  { by: worker, text: 'work: done' },
  { by: 'engine', text: 'catch-up: updated the PR with main' },
  { by: reviewer, text: 'review: verdict, 1 finding(s)' },
  { by: 'user', text: 'allowed the agent\'s permission request' },
].map((e, i) => ({ ...e, at: Date.UTC(2026, 0, 1, 10, i) }))

const card: Card = {
  id: 'WHR-1', project: 'WHR', title: 'A task', description: '', column: 'Merging', phase: 'working', step: 'merge', holder: 'none',
  tags: [], links: [], log, plan: planSteps(wherdr, { type: 'visual' }),
  state: {
    ...initialState(), started: true, at: 4, rounds: { review: 2 },
    proofs: { work: { report: 'Final report: **all fixed**.' } },
    reviews: { review: [
      { findings: [finding('a', 'major', 'Button overlaps the title'), finding('b', 'critical', 'Crash on empty list')] },
      { findings: [finding('c', 'major', 'Missing test')], disputed: ['c'] },
    ] },
    minor: { review: [finding('d', 'minor', 'Typo in a comment')] },
  },
}

it('shows the hand-offs of two review rounds in order, with who and what', async () => {
  const w = await mountSuspended(TaskHistory, { props: { card } })
  const items = w.findAll('[data-testid="task-history"] > li')
  const heads = items.map(li => li.get('.mono-label b').text() + (li.get('.mono-label').text().match(/· (Done|Fixed|Sent back|Passed)/)?.[1] ?? ''))
  // The whole log: the engine's bookkeeping as a light routine line, its catch-up a hand-off.
  expect(heads).toEqual(['wherdr', 'WorkerDone', 'ReviewerSent back', 'WorkerFixed', 'ReviewerSent back', 'WorkerFixed', 'wherdr', 'ReviewerPassed', 'You'])
  expect(items[0]!.classes()).toContain('routine')
  expect(items[0]!.text()).toContain('work: sent to the worker')
  const text = items.slice(1).map(li => li.get('.md-body').text())
  expect(text[0]).toBe('Reported done.') // only the last report is kept
  expect(text[1]).toContain('[critical] Crash on empty list')
  expect(text[3]).toContain('Missing test')
  expect(text[4]).toContain('Final report: all fixed.')
  expect(text[4]).toContain('Contested: c')
  expect(text[6]).toContain('Typo in a comment')
  expect(items[2]!.get('.mono-label').text()).toContain('codex gpt')
  w.unmount()
})
