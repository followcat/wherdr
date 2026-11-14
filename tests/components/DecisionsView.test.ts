import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { useRouter } from '#app'
import { readBody } from 'h3'
import DecisionsView from '~/components/DecisionsView.vue'
import { herdrState } from '~/composables/useHerdr'
import type { Decision } from '#shared/pm/decisions'
import type { Pane } from '#shared/types'

const posts: { url: string, body: Record<string, unknown> }[] = []
let list: Decision[] = []
registerEndpoint('/api/pm/decisions', () => list)
for (const url of ['/api/pm/task-resume', '/api/pm/decide', '/api/pm/step-user', '/api/pm/template-proposal', '/api/pm/autopilot', '/api/pm/permission'])
  registerEndpoint(url, { method: 'POST', handler: async (e) => { posts.push({ url, body: await readBody(e) }); return {} } })

const d = (id: string, group: Decision['group'], more: Partial<Decision> = {}): Decision => ({ id, group, project: 'CO', task: id, title: `Task ${id}`, text: `About ${id}`, at: 1, ...more })
const all = (): Decision[] => [
  d('CO-1', 'agent', { kind: 'permission', terminal: 'host/t1' }),
  d('CO-2', 'agent', { kind: 'question', terminal: 'host/t2' }),
  d('CO-3', 'arbitrate', { options: ['round', 'split'], recommend: 'round' }),
  d('CO-4', 'step', { label: 'Merged' }),
  d('CO-5', 'overdue'),
  { id: 'p', group: 'proposal', project: 'CO', title: 'Company', text: 'Template change proposed', at: 1 },
  { id: 'w', group: 'coordinator', project: 'CO', title: 'Company', text: 'The coordinator did not answer', at: 1 },
]
const prompt = { question: 'Allow Bash(npm test)?', options: [{ label: 'Yes' }, { label: 'No' }], identity: 'x' }
herdrState.value = { ok: true, workspaces: [], panes: [
  { id: 'w1:p1', coreAddress: 'host/t1', status: 'blocked', prompt, agent: 'claude', workspace: 'w', tab: 't' } as unknown as Pane,
  // A question is the agent's label: its pane is idle, not blocked.
  { id: 'w1:p2', coreAddress: 'host/t2', status: 'idle', agent: 'claude', workspace: 'w', tab: 't' } as Pane,
] }

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
const mount = async () => {
  w = await mountSuspended(DecisionsView)
  await vi.waitFor(() => expect(w!.findAll('[data-testid="decision"]').length).toBe(list.length))
  return w
}
afterEach(() => { w?.unmount(); w = null; posts.length = 0 })
const item = (b: NonNullable<typeof w>, id: string) => b.find(`[data-decision="${id}"]`)

it('groups the decisions in their order, with their count', async () => {
  list = all()
  const b = await mount()
  expect(b.findAll('[data-testid="decisions-group"]').map(g => g.find('h2').text())).toEqual([
    'Agents waiting 2', 'Reviews to settle 1', 'Coordinator proposals 1', 'Your steps 1', 'Overdue steps 1', 'Coordinator not answering 1',
  ])
})

it('answers a permission with the agent\'s own buttons, and opens an agent with a question', async () => {
  list = all()
  const b = await mount()
  expect(item(b, 'CO-1').text()).toContain('Allow Bash(npm test)?')
  expect(item(b, 'CO-1').findAll('.choices-list button').map(x => x.text())).toEqual(['1Yes', '2No'])
  expect(item(b, 'CO-2').find('.choices').exists()).toBe(false)
  expect(item(b, 'CO-2').find('[data-testid="decision-open"]').attributes('href')).toBe('#/a/w1%3Ap2')
  // Answered (the prompt is gone): it leaves at once.
  const panes = herdrState.value!.panes
  herdrState.value = { ...herdrState.value!, panes: [{ ...panes[0]!, status: 'working', prompt: null } as Pane, panes[1]!] }
  await vi.waitFor(() => expect(item(b, 'CO-1').exists()).toBe(false))
  expect(item(b, 'CO-2').exists()).toBe(true)
  expect(b.find('[data-testid="decisions-count"]').text()).toBe('6')
  herdrState.value = { ...herdrState.value!, panes }
  // An overdue step without a button of its own: its task's sheet, over Decisions.
  await useRouter().push('/decisions')
  await item(b, 'CO-5').find('[data-testid="decision-task"]').trigger('click')
  await expect.poll(() => useRouter().currentRoute.value.fullPath).toBe('/decisions?task=CO-5')
  await useRouter().replace('/')
})

it('answers a permission whose prompt is not shown with Allow or Deny, and an overdue step with its own button', async () => {
  list = [d('CO-6', 'agent', { kind: 'permission', text: 'approve Bash: npm test' }), d('CO-7', 'agent', { kind: 'permission' }), d('CO-8', 'overdue', { label: 'Deployed' })]
  const b = await mount()
  expect(item(b, 'CO-6').find('.choices').exists()).toBe(false)
  for (const [id, tid] of [['CO-6', 'decision-allow'], ['CO-7', 'decision-deny'], ['CO-8', 'decision-step']] as const) {
    const tap = item(b, id).find(`[data-testid="${tid}"]`)
    await vi.waitFor(() => expect(tap.attributes('disabled')).toBeUndefined())
    await tap.trigger('click')
  }
  await vi.waitFor(() => expect(posts).toHaveLength(3))
  expect(posts).toEqual([
    { url: '/api/pm/permission', body: { id: 'CO-6', allow: true } },
    { url: '/api/pm/permission', body: { id: 'CO-7', allow: false } },
    { url: '/api/pm/step-user', body: { id: 'CO-8' } },
  ])
  expect(item(b, 'CO-8').text()).toContain('Deployed')
  expect(item(b, 'CO-8').find('[data-testid="decision-task"]').exists()).toBe(false)
})

it('puts the recommendation first and answers each in one tap', async () => {
  list = all()
  const b = await mount()
  const choices = item(b, 'CO-3').findAll('[data-choice]')
  expect(choices.map(x => x.text())).toEqual(['One more round · recommended', 'Split the rest'])
  const taps = [choices[0]!, item(b, 'CO-4').find('[data-testid="decision-step"]'), item(b, 'p').find('[data-testid="decision-accept"]'), item(b, 'w').find('[data-testid="decision-run-now"]')]
  for (const [i, tap] of taps.entries()) {
    await vi.waitFor(() => expect(tap.attributes('disabled')).toBeUndefined())
    await tap.trigger('click')
    await vi.waitFor(() => expect(posts).toHaveLength(i + 1))
  }
  expect(posts).toEqual([
    { url: '/api/pm/decide', body: { id: 'CO-3', choice: 'round' } },
    { url: '/api/pm/step-user', body: { id: 'CO-4' } },
    { url: '/api/pm/template-proposal', body: { project: 'CO', accept: true } },
    { url: '/api/pm/autopilot', body: { project: 'CO', runNow: true } },
  ])
})

it('says when nothing waits', async () => {
  list = []
  const b = await mountSuspended(DecisionsView)
  w = b
  await vi.waitFor(() => expect(b.find('[data-testid="decisions-empty"]').text()).toBe('Nothing waits for you.'))
})

it('a stopped task goes on from here; an agent waiting can be stopped', async () => {
  list = [d('CO-8', 'stopped', { text: 'Stopped by the coordinator: it loops' }), d('CO-2', 'agent', { kind: 'question', terminal: 'host/t2' })]
  const b = await mount()
  expect(item(b, 'CO-8').findAll('[data-resume]').map(x => x.text())).toEqual(['Continue', 'Take it as it is', 'Archive'])
  expect(item(b, 'CO-2').find('[data-testid="decision-stop"]').exists()).toBe(true)
  expect(item(b, 'CO-8').find('[data-testid="decision-stop"]').exists()).toBe(false)
  await item(b, 'CO-8').find('[data-resume="as-is"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/task-resume', body: { id: 'CO-8', how: 'as-is' } }]))
})
