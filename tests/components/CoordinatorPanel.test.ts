import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { useRouter } from '#app'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import CoordinatorPanel from '~/components/CoordinatorPanel.vue'
import CoordinatorButton from '~/components/CoordinatorButton.vue'
import { agentOrder, herdrState, hiddenAgents } from '~/composables/useHerdr'
import { coordinators, resumedCoordinators } from '~/composables/useCoordinators'
import type { CoordinatorView } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'
import { answerConfirm, confirmState } from '~/composables/useUi'
import { pick } from '../helpers/select'

const posts: { url: string, body: Record<string, unknown> }[] = []
let views: CoordinatorView[] = []
const post = (url: string, reply: () => unknown) => registerEndpoint(url, { method: 'POST', handler: async (e) => { posts.push({ url, body: await readBody(e) }); return reply() } })
registerEndpoint('/api/pm/coordinators', () => views)
post('/api/pm/coordinator-agent', () => ({}))
post('/api/pm/coordinator-start', () => ({ terminal: 'host/t2' }))
// As the server: the saved autopilot back (the same endpoint as CoordinatorAutopilot.test.ts).
beforeAll(() => registerEndpoint('/api/pm/autopilot', { method: 'POST', handler: async (e) => { const body = await readBody(e); posts.push({ url: '/api/pm/autopilot', body }); return body.autopilot ? { autopilot: body.autopilot } : {} } }))
herdrState.value = { ok: true, workspaces: [], panes: [{ id: 'w1:p1', coreAddress: 'host/t1', status: 'idle', agent: 'codex', workspace: 'w', tab: 't' } as Pane] }

const view = (more: Partial<CoordinatorView> = {}): CoordinatorView => ({ project: 'CO', name: 'Company', agent: { program: 'claude' }, ...more })
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
const mount = async (c: CoordinatorView, open = false) => (w = await mountSuspended(CoordinatorPanel, { props: { c, open } }))
afterEach(() => { w?.unmount(); w = null; posts.length = 0; coordinators.value = []; hiddenAgents.value = []; agentOrder.value = [] })

it('says which agent answers; a new one is sent by Save, and Cancel takes it back', async () => {
  const b = await mount(view(), true)
  // No conversation yet: the button says which agent will answer.
  expect(b.find('[data-testid="coordinator-open"]').text()).toBe('Start with Claude')
  const save = () => b.find('[data-testid="autopilot-save"]')
  await pick(b, 'coordinator-agent', 'codex')
  expect(save().attributes('disabled')).toBeUndefined()
  await b.find('[data-testid="autopilot-cancel"]').trigger('click')
  expect(save().attributes('disabled')).toBeDefined()
  await pick(b, 'coordinator-agent', 'codex')
  expect(posts).toEqual([])
  await save().trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/coordinator-agent', body: { project: 'CO', program: 'codex' } }]))
})

const alfred = (more: Partial<CoordinatorView> = {}) => view({ project: '_main', name: 'Alfred', main: true, ...more })

it('Alfred: its agent picked in its window, and kept when no longer offered (said, never replaced)', async () => {
  const b = await mount(alfred())
  expect(b.text()).toContain('Alfred’s agent')
  expect(b.find('[data-testid="coordinator-autopilot"]').exists()).toBe(false) // Alfred has no autopilot
  expect(await (b.vm as unknown as { leave: () => Promise<boolean> }).leave()).toBe(true) // its window closes
  await pick(b, 'coordinator-agent', 'codex')
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/coordinator-agent', body: { project: '_main', program: 'codex' } }]))
  hiddenAgents.value = ['claude']
  await b.setProps({ c: alfred() })
  expect(b.find('[data-testid="coordinator-unoffered"]').text()).toContain('Claude is no longer offered on this machine')
})

it('Alfred: "Resume with" makes the resumed agent its default, so the warning does not come back', async () => {
  const b = await mount(alfred({ agent: { program: 'codex' }, ran: { program: 'claude' }, terminal: 'host/t1' }))
  expect(b.find('[data-testid="coordinator-other-agent"]').text()).toContain('The previous conversation used Claude. The default is Codex.')
  await b.find('[data-testid="coordinator-resume"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ url: '/api/pm/coordinator-agent', body: { project: '_main', program: 'claude' } }]))
  resumedCoordinators.value = []
  globalThis.localStorage?.removeItem('wherdr.coordinatorsResumed')
})

it('header button: a clock, the autopilot\'s state, and a tap opens the autopilot only (no workflow proposal)', async () => {
  w = await mountSuspended(CoordinatorButton, { attachTo: document.body, props: { c: view({ autopilot: { on: true, goal: '', events: [], perDay: 1, atOnce: 1 }, asleep: 'idle', nextWake: new Date().setHours(23, 30, 0, 0), proposal: { diff: '+ x', at: 1 } }) } })
  const btn = w.get('[data-testid="coordinator-button"]')
  expect(btn.attributes('data-state')).toBe('idle')
  expect(btn.attributes('aria-label')).toBe('Autopilot: Asleep')
  expect(btn.find('.coord-btn-icon').classes()).toContain('i-lucide-clock')
  await btn.trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="coordinator-autopilot"]')).not.toBeNull())
  expect(document.querySelector('[data-testid="autopilot-next-wake"]')?.textContent).toMatch(/^Next wake (23:30|11:30)/i)
  expect(document.querySelector('[data-testid="workflow-change"]')).toBeNull()
})

it('window: Settings and Activity tabs, a pinned Save enabled by a change, and closing with unsaved changes asks', async () => {
  localStorage.removeItem('wherdr.autopilotTab')
  w = await mountSuspended(CoordinatorButton, { attachTo: document.body, props: { c: view({ autopilot: { on: true, goal: 'Ship', events: [], perDay: null, atOnce: null } }) } })
  await w.get('[data-testid="coordinator-button"]').trigger('click')
  const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`[data-testid="${id}"]`)!
  await vi.waitFor(() => expect($('coordinator-autopilot')).not.toBeNull())
  const shown = (id: string) => $(id).style.display !== 'none'
  // Settings first: the agent and the goal; the switch and the timeline are in Activity.
  expect([...document.querySelectorAll('[role="tab"]')].map(b => b.textContent!.trim())).toEqual(['Settings', 'Activity'])
  expect([shown('autopilot-settings'), shown('autopilot-activity')]).toEqual([true, false])
  expect($('autopilot-activity').contains($('autopilot-run-now'))).toBe(true)
  expect($('autopilot-settings').contains($('coordinator-agent'))).toBe(true)
  $('autopilot-tab-activity').click()
  await vi.waitFor(() => expect(shown('autopilot-activity')).toBe(true))
  expect(localStorage.getItem('wherdr.autopilotTab')).toBe('activity')
  $('autopilot-tab-settings').click()
  await vi.waitFor(() => expect(shown('autopilot-settings')).toBe(true))
  expect($('autopilot-settings').querySelector('form')!.lastElementChild).toBe($('autopilot-bar')) // pinned: the scroll's last element
  const save = $<HTMLButtonElement>('autopilot-save')
  expect(save.disabled).toBe(true)
  const goal = document.querySelector<HTMLTextAreaElement>('textarea#ap-goal-CO')!
  goal.value = 'Ship 3'
  goal.dispatchEvent(new Event('input'))
  await vi.waitFor(() => expect(save.disabled).toBe(false))
  // Closing asks; no keeps the window and the change.
  document.querySelector<HTMLButtonElement>('.hw-sheet-close')!.click()
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  expect(confirmState.message).toBe('Discard the unsaved autopilot changes?')
  answerConfirm(false)
  await nextTick()
  expect($('coordinator-autopilot')).not.toBeNull()
  save.click()
  await vi.waitFor(() => expect(posts.at(-1)).toEqual({ url: '/api/pm/autopilot', body: { project: 'CO', autopilot: { on: true, goal: 'Ship 3', every: '', at: '', events: [], perDay: null, atOnce: null } } }))
  localStorage.removeItem('wherdr.autopilotTab')
})

it('with no default set, or its default unchecked in Settings › Agents, offers the user\'s first agent', async () => {
  agentOrder.value = ['codex']
  const b = await mount(view({ agent: undefined }), true)
  expect(b.find('[data-testid="coordinator-open"]').text()).toBe('Start with Codex')
  hiddenAgents.value = ['codex']
  await b.setProps({ c: view() })
  expect(b.find('[data-testid="coordinator-open"]').text()).toBe('Start with Claude')
  hiddenAgents.value = ['claude']
  await nextTick()
  expect(b.find('[data-testid="coordinator-open"]').text()).toBe('Start with Codex')
})

it('warns when the kept conversation ran with another agent, and offers a new one first', async () => {
  const b = await mount(view({ ran: { program: 'codex' }, terminal: 'host/t1' }), true)
  const banner = b.find('[data-testid="coordinator-other-agent"]')
  expect(banner.text()).toContain('The previous conversation used Codex. The default is Claude.')
  expect(banner.findAll('button').map(x => x.text())).toEqual(['New conversation with Claude', 'Resume with Codex'])
  expect(b.find('[data-testid="coordinator-open"]').exists()).toBe(false)
  await b.find('[data-testid="coordinator-new"]').trigger('click')
  await vi.waitFor(() => expect(posts[0]).toEqual({ url: '/api/pm/coordinator-start', body: { project: 'CO', program: 'claude' } }))
})

it('remembers "Resume with" after a reload', async () => {
  const b = await mount(view({ ran: { program: 'codex' }, terminal: 'host/t1' }), true)
  await b.find('[data-testid="coordinator-resume"]').trigger('click')
  // It opens the conversation: wait until the agent page (and its lazy imports) is there,
  // else they load after the test environment is torn down.
  const router = useRouter()
  await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/a/w1:p1'), { timeout: 15000 })
  expect(b.find('[data-testid="coordinator-other-agent"]').exists()).toBe(false)
  expect(JSON.parse(localStorage.getItem('wherdr.coordinatorsResumed')!)).toEqual(['host/t1'])
  resumedCoordinators.value = []
  localStorage.removeItem('wherdr.coordinatorsResumed')
  await router.replace('/')
})

it('shows no warning when the kept conversation is the default agent\'s', async () => {
  const b = await mount(view({ ran: { program: 'claude' }, terminal: 'host/t1' }), true)
  expect(b.find('[data-testid="coordinator-other-agent"]').exists()).toBe(false)
  expect(b.find('[data-testid="coordinator-open"]').text()).toBe('Open')
})

it('names the autopilot with its subtitle and links a project\'s to its Workflow tab', async () => {
  const b = await mount(view({ proposal: { diff: '+ x', at: 1 } }))
  expect(b.find('[data-testid="part-subtitle"]').text()).toBe('When the project works without you')
  const link = b.find('[data-testid="part-link"]')
  expect(link.text()).toBe('Tasks it starts follow the Workflow tab')
  expect(link.attributes('href')).toBe('#/settings?section=projects&project=CO&tab=workflow')
  expect(b.find('[data-testid="workflow-change"]').exists()).toBe(false)
})
