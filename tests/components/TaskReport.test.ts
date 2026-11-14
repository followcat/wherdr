import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TaskReport from '~/components/TaskReport.vue'
import { initialState } from '#shared/pm/steps'
import type { Card } from '#shared/pm/board'

const card: Card = {
  id: 'WHR-1', project: 'WHR', title: 'A task', description: '', column: 'Merging', phase: 'working', step: 'merge', holder: 'none',
  yourTurn: 'Look at the screenshots, then merge', userLabel: 'Merge', tags: [], links: [], log: [],
  plan: [{ id: 'work', holder: 'worker', ends: 'report', text: '' }, { id: 'merge', holder: 'none', ends: 'user', text: '' }] as Card['plan'],
  state: { ...initialState(), started: true, at: 1, shots: { work: [{ file: 'aaaaaaaaaaaa.png', phase: 'after', at: 1 }, { file: 'bbbbbbbbbbbb.png', phase: 'after', at: 2 }] } },
}

it('sends the text, the screenshots picked and the merge block (on by default)', async () => {
  const w = await mountSuspended(TaskReport, { props: { card, busy: false } })
  expect(w.get('[data-testid="task-report-send"]').attributes('disabled')).toBeDefined()
  await w.get('textarea[data-testid="task-report-text"]').setValue('  The menu is not on the screens  ')
  const shots = w.findAll('[data-testid="task-report-shot"]')
  expect(shots).toHaveLength(2)
  await shots[1]!.trigger('click')
  expect(shots[1]!.attributes('aria-pressed')).toBe('true')
  await w.get('form').trigger('submit')
  expect(w.emitted('send')![0]).toEqual([{ text: 'The menu is not on the screens', shots: ['bbbbbbbbbbbb.png'], block: true }])
  // Unpicked again, and the merge left free.
  await shots[1]!.trigger('click')
  await w.get('[data-testid="task-report-block"]').trigger('click')
  await w.get('form').trigger('submit')
  expect(w.emitted('send')![1]).toEqual([{ text: 'The menu is not on the screens', shots: [], block: false }])
  w.unmount()
})
