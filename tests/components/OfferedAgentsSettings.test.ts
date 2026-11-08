// Settings › Agents › Offered agents: the order (up/down buttons, arrow keys
// on the handle) and the checkboxes, both synced settings; the first checked
// one is the default.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import OfferedAgentsSettings from '~/components/OfferedAgentsSettings.vue'
import { agentOrder, appConfig, hiddenAgents } from '~/composables/useHerdr'

afterEach(() => { hiddenAgents.value = []; agentOrder.value = [] })
const names = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.findAll('[data-row] b').map(b => b.text())
const defaultOf = (w: Awaited<ReturnType<typeof mountSuspended>>) => w.find('[data-row]:has(.agent-pref-default)').attributes('data-row')

it('reorders with the buttons and the arrow keys, and the first checked one is the default', async () => {
  appConfig.value = { ...appConfig.value, machines: undefined, kinds: ['claude', 'codex', 'omp', 'shell'] }
  agentOrder.value = ['omp']
  const w = await mountSuspended(OfferedAgentsSettings)
  expect(names(w)).toEqual(['OMP', 'Claude', 'Codex'])
  expect(defaultOf(w)).toBe('omp')
  expect(w.find('[data-row="omp"] .key-order-up').attributes('disabled')).toBeDefined()

  await w.find('[data-row="omp"] .key-order-down').trigger('click')
  expect(agentOrder.value).toEqual(['claude', 'omp', 'codex'])
  expect(names(w)).toEqual(['Claude', 'OMP', 'Codex'])
  await w.find('[data-row="codex"] .bar-pref-grip').trigger('keydown', { key: 'ArrowUp' })
  expect(agentOrder.value).toEqual(['claude', 'codex', 'omp'])
  expect(w.find('[aria-live]').text()).toBe('Codex: position 2 of 3')

  // Unchecked: still listed (to check it again), no longer the default.
  await w.find('[data-row="claude"] input').setValue(false)
  expect(hiddenAgents.value).toEqual(['claude'])
  expect(defaultOf(w)).toBe('codex')
  w.unmount()
})
