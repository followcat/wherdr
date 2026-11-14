import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import ProposalCard from '~/components/ProposalCard.vue'
import PartHead from '~/components/PartHead.vue'
import type { CoordinatorView } from '#shared/pm/coordinator'
import { company } from '#shared/pm/examples'
import { workflowChanges } from '#shared/pm/workflowChanges'
import type { Step, Template } from '#shared/pm/workflow'

const posts: unknown[] = []
registerEndpoint('/api/pm/coordinators', () => [])
registerEndpoint('/api/pm/template-proposal', { method: 'POST', handler: async (e) => { posts.push(await readBody(e)); return { accepted: true } } })

const changes = { all: [], types: [{ type: 'task', kind: 'changed' as const, fields: [{ field: 'merge', before: 'you', after: 'automatic' }], steps: [] }] }
const pending: CoordinatorView = { project: 'CO', name: 'Company', proposal: { diff: '+ x', at: 1, changes } }
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; posts.length = 0 })

it('pending: the change in a line, Accept answers it, See all changes opens the review', async () => {
  w = await mountSuspended(ProposalCard, { props: { c: pending } })
  expect(w.text()).toContain('task: merge: you → automatic')
  await w.find('[data-testid="proposal-card-accept"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', accept: true }]))
  await w.find('[data-testid="proposal-see"]').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="proposal-changes"]')?.textContent).toContain('automatic'))
})

it('answered: its own change, the outcome, by whom and when, and no buttons, even while another waits', async () => {
  w = await mountSuspended(ProposalCard, { props: { c: pending, answer: { outcome: 'refused', at: 2, by: 'user', proposedAt: 1, summary: ['task: + land'] } } })
  expect(w.text()).toContain('task: + land')
  expect(w.text()).not.toContain('automatic')
  expect(w.find('[data-testid="proposal-outcome"]').text()).toMatch(/^Refused by you · /)
  expect(w.find('button').exists()).toBe(false)
  await w.setProps({ answer: { outcome: 'replaced', at: 3, by: 'coordinator CO', proposedAt: 1 } })
  expect(w.find('[data-testid="proposal-outcome"]').text()).toMatch(/^Replaced by coordinator CO · /)
})

it('says who proposed it and the request behind it: in full when unfolded, with a link back to it', async () => {
  const said = `Never run the full suite locally. ${'Only the tests of what changed. '.repeat(12)}`
  const c: CoordinatorView = { ...pending, label: 'WD', color: 'teal', proposal: { ...pending.proposal!, by: 'CO', said, saidAt: Date.UTC(2026, 0, 2, 9, 30) } }
  w = await mountSuspended(ProposalCard, { props: { c, canGoto: true } })
  expect(w.find('[data-testid="proposal-headline"]').text()).toBe('task: merge: you → automatic')
  expect(w.find('[data-testid="proposal-by"]').text()).toBe('Proposed by WDCompany')
  expect(w.find('[data-testid="proposal-key"]').attributes('style')).toContain('--project-teal')
  const text = w.find('[data-testid="proposal-said"]')
  expect(text.text()).toBe(said.trim())
  expect(text.classes()).toContain('folded')
  await w.find('[data-testid="proposal-said-more"]').trigger('click')
  expect(text.classes()).not.toContain('folded')
  await w.find('[data-testid="proposal-goto"]').trigger('click')
  expect(w.emitted('goto')).toHaveLength(1)
})

it('proposed by Alfred: his name, no key badge; a short request is not folded', async () => {
  const c: CoordinatorView = { ...pending, color: 'teal', proposal: { ...pending.proposal!, by: 'main', said: 'Add a deploy step' } }
  w = await mountSuspended(ProposalCard, { props: { c } })
  expect(w.find('[data-testid="proposal-by"]').text()).toBe('Proposed by Alfred')
  expect(w.find('[data-testid="proposal-key"]').exists()).toBe(false)
  expect(w.find('[data-testid="proposal-said-more"]').exists()).toBe(false)
  expect(w.find('[data-testid="proposal-goto"]').exists()).toBe(false)
})

// A proposal on the company example: a screenshots step added after the review,
// the deploy watch removed, the reviewer's model and rounds changed.
const steps = company.taskTypes.feature!.steps as Step[]
const next: Template = { ...company, prefs: { ...company.prefs, reviewModel: 'haiku' }, taskTypes: { feature: { steps: [
  ...steps.slice(0, 2), { ...steps[2]!, rounds: 3 }, { id: 'shots', column: 'Review', holder: 'worker', ends: 'report', evidence: ['screenshots'] }, ...steps.slice(3, 5), steps[6]!,
] } } }
const drawn: CoordinatorView = { project: 'CO', name: 'Company', proposal: { diff: '+ shots', at: 1, changes: workflowChanges(company, next), template: next } }
const marked = (root: { querySelectorAll: (s: string) => NodeListOf<Element> }) =>
  Object.fromEntries([...root.querySelectorAll('[data-testid="wf-node"][data-diff]')].map(n => [n.getAttribute('data-step'), n.getAttribute('data-diff')]))

it('draws the proposed workflow small, its added, removed and changed steps marked; a tap opens it in full, the JSON one tap away; Refuse answers', async () => {
  w = await mountSuspended(ProposalCard, { props: { c: drawn } })
  const card = w.find('[data-testid="proposal-chart"]')
  expect(card.find('.wf-board').classes()).toContain('compact')
  expect(card.find('[data-testid="wf-route"]').exists()).toBe(false)
  expect(marked(card.element)).toEqual({ review: 'changed', shots: 'added', deploy: 'removed' })
  expect(card.find('[data-step="review"] [data-testid="wf-delta"]').text()).toContain('Model: opus → haiku')
  expect(card.find('[data-step="review"] [data-testid="wf-delta"]').text()).toContain('Rounds: 2 → 3')
  expect(card.find('[data-testid="wf-impact"]').text()).toBe('For feature tasks: review changes its rounds, model; a new step shots; no more step deploy')
  // The removed deploy still says what it did: the engine watching the pipeline.
  expect(card.find('[data-step="deploy"] [data-testid="wf-who"]').text()).toBe('The engine')
  expect(card.find('[data-step="deploy"] [data-testid="wf-ends"]').text()).toContain('Watch the pipeline')
  await card.trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="proposal-review"] [data-testid="wf-diagram"]')).not.toBeNull())
  const sheet = document.querySelector('[data-testid="proposal-review"]')!
  expect(marked(sheet)).toEqual({ review: 'changed', shots: 'added', deploy: 'removed' })
  expect(sheet.querySelector('[data-testid="wf-route"]')).not.toBeNull()
  ;(sheet.querySelector('[data-testid="proposal-view-json"]') as HTMLElement).click()
  await vi.waitFor(() => expect(document.querySelector('[data-testid="proposal-diff"]')?.textContent).toContain('+ shots'))
  ;(sheet.querySelector('[data-testid="proposal-refuse"]') as HTMLElement).click()
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', accept: false }]))
})

it('a change of the reviewer\'s model for the whole workflow marks the reviewer\'s step', async () => {
  const only: Template = { ...company, prefs: { ...company.prefs, reviewModel: 'haiku' } }
  const changes = workflowChanges(company, only)
  expect(changes.types).toEqual([])
  w = await mountSuspended(ProposalCard, { props: { c: { project: 'CO', name: 'Company', proposal: { diff: '~ reviewModel', at: 1, changes, template: only } } } })
  expect(marked(w.element)).toEqual({ review: 'changed' })
  expect(w.find('[data-step="review"] [data-testid="wf-delta"]').text()).toBe('Model: opus → haiku')
  expect(w.find('[data-testid="wf-impact"]').text()).toBe('For feature tasks: review changes its model')
})

it('the Workflow tab\'s head links to the Autopilot tab', async () => {
  w = await mountSuspended(PartHead, { props: { part: 'workflow', project: 'CO' } })
  expect(w.find('[data-testid="part-link"]').text()).toBe('Who starts tasks and when: Autopilot tab')
  expect(w.find('[data-testid="part-link"]').attributes('href')).toBe('#/settings?section=projects&project=CO&tab=autopilot')
})
