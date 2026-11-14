// Open the agent on the task sheet and in Tasks to review (AgentButton): the
// running agent's conversation; disabled with "Agent is terminated" once it
// ended; Worker or Reviewer when both run.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import AgentButton from '~/components/AgentButton.vue'
import { herdrState } from '~/composables/useHerdr'
import type { Card } from '#shared/pm/board'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const pane = (id: string): Pane => ({ id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '~/project', agentSession: null, coreAddress: `core:${id}` })
const card = (more: Partial<Card>): Card => ({ id: 'WHR-1', shown: 'WHR-1', project: 'WHR', title: 'A task', description: '', column: 'Merging', phase: 'working', holder: 'none', tags: [], links: [], log: [], plan: [], ...more })
const stubs = {
  UDropdownMenu: { props: ['items'], template: '<div><slot /><button v-for="i in items" :key="i.label" data-testid="menu-item" @click="i.onSelect()">{{ i.label }}</button></div>' },
}
afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; navigate.mockReset() })

it('opens the running worker\'s conversation when the step has no agent (a merge)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('p1')] }
  const w = await mountSuspended(AgentButton, { props: { card: card({ agents: { worker: 'core:p1' } }) }, global: { stubs } })
  const b = w.get('[data-testid="agent-open"]')
  expect(b.attributes('disabled')).toBeUndefined()
  await b.trigger('click')
  expect(navigate).toHaveBeenCalledWith('/a/p1')
  expect(w.emitted('opened')).toHaveLength(1)
})

it('is disabled with "Agent is terminated" once its agent ended, said on a tap', async () => {
  const w = await mountSuspended(AgentButton, { props: { card: card({}) }, global: { stubs } })
  expect(w.get('[data-testid="agent-open"]').attributes('disabled')).toBeDefined()
  expect(w.get('[title="Agent is terminated"]').exists()).toBe(true)
  expect(w.find('[data-testid="agent-off-hint"]').exists()).toBe(false)
  await w.get('[data-testid="agent-off"]').trigger('click')
  expect(w.get('[data-testid="agent-off-hint"]').text()).toBe('Agent is terminated')
  expect(navigate).not.toHaveBeenCalled()
})

it('offers Worker and Reviewer when both run', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('p1'), pane('p2')] }
  const w = await mountSuspended(AgentButton, { props: { card: card({ holder: 'reviewer', agents: { worker: 'core:p1', reviewer: 'core:p2' } }) }, global: { stubs } })
  expect(w.find('[data-testid="agent-open-menu"]').exists()).toBe(true)
  const items = w.findAll('[data-testid="menu-item"]')
  expect(items.map(i => i.text())).toEqual(['Worker', 'Reviewer'])
  await items[1]!.trigger('click')
  expect(navigate).toHaveBeenCalledWith('/a/p2')
})
