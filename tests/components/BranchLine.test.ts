import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TaskSheet from '~/components/TaskSheet.vue'
import { initialState, planSteps } from '#shared/pm/steps'
import { wherdr } from '#shared/pm/examples'
import type { Card } from '#shared/pm/board'

// A visual task of this repository: work (1), pr to v3 (2), review (3), merge (4).
const plan = planSteps(wherdr, { type: 'visual' })
const card = (at: number, more: Partial<Card> = {}): Card => ({
  id: 'WHR-12', shown: 'WHR-12', project: 'WHR', title: 'A task', description: '', column: 'Working', phase: 'working', holder: 'none',
  tags: [], links: [], log: [], plan, state: { ...initialState(), started: true, at }, branch: 'task/WHR-12', ...more,
})
const stubs = { AppSheet: { template: '<section><slot /></section>' } }
const lineOf = async (c: Card) => {
  const w = await mountSuspended(TaskSheet, { props: { card: c, projectBase: 'v3' }, global: { stubs } })
  const l = w.find('[data-testid="branch-line"]')
  const text = l.exists() ? l.findAll('.branch-chip, .branch-word').map(x => x.text()).join(' ') : null
  w.unmount()
  return text
}

it('says which branch merges into which: its PR\'s base and commits, else where the next step sends it, none without a branch', async () => {
  expect(await lineOf(card(4, { pr: { base: 'develop', commits: 3 } }))).toBe('task/WHR-12 → develop · 3 commits')
  expect(await lineOf(card(1))).toBe('task/WHR-12 will open a PR to v3')
  expect(await lineOf(card(4))).toBe('task/WHR-12 → v3') // its PR not read yet: the PR step's base
  expect(await lineOf(card(0, { branch: undefined, state: undefined, phase: 'todo' }))).toBeNull()
})
