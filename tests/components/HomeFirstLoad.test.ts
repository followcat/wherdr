// WHR-329: the home list's first load. Skeletons until every section's first
// read is in (Alfred, coordinators, tasks to handle, task agents), then the
// whole list in one paint; a later refresh keeps the data shown. The state kept
// on this device does not open the gate; a failed read shows Try again.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import { cachedAt, eventsOpen, herdrState } from '~/composables/useHerdr'
import { coordinators, loadCoordinators } from '~/composables/useCoordinators'
import { homeFirstLoad, homeListReady } from '~/composables/useHomeLoad'
import type { Pane } from '#shared/types'

// Each read waits until the test lets it answer.
const gates: Record<string, () => void> = {}
const gated = <T>(name: string, value: T) => () => new Promise<T>((done) => { gates[name] = () => done(value) })
registerEndpoint('/api/alfred', gated('alfred', { name: 'Alfred' }))
let coordinatorsFail = false
const coordinatorsRead = gated('coordinators', [{ project: 'CO', name: 'demo app', agent: { program: 'claude' }, terminal: 'host/t1' }])
registerEndpoint('/api/pm/coordinators', () => (coordinatorsFail ? Promise.reject(new Error('boom')) : coordinatorsRead()))
registerEndpoint('/api/pm/handle', gated('handle', [{ id: 'CO-1', shown: 'CO-1', project: 'CO' }]))
registerEndpoint('/api/pm/agents', gated('agents', {}))
registerEndpoint('/api/quotas', () => ({}))
const open = async (name: string) => { await vi.waitFor(() => expect(gates[name]).toBeTypeOf('function')); gates[name]!(); delete gates[name] }

const pane = (id: string, coreAddress?: string) => ({ id, coreAddress, workspace: 'w1', tab: 'w1:t1', agent: 'claude', status: 'idle', title: `Agent ${id}`, cwd: '~/project' }) as Pane
const pass = { template: '<div><slot /></div>' }

afterEach(() => {
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  eventsOpen.value = false
  coordinators.value = []
  homeListReady.value = false
  cachedAt.value = null
  coordinatorsFail = false
  Object.assign(homeFirstLoad, { alfred: 'pending', coordinators: 'pending', handle: 'pending', agents: 'pending', quotas: 'pending' })
})
const home = () => {
  herdrState.value = { ok: true, panes: [pane('w1:p1', 'host/t1'), pane('w1:p2')], workspaces: [{ id: 'w1', number: 1, label: 's', focused: false }] } as never
  eventsOpen.value = true
  return mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
}

it('shows skeletons until every section is read, then the whole list at once, and keeps it on refresh', async () => {
  // Restored from this device's cache (no coordinators, Alfred, tasks): still waiting.
  cachedAt.value = Date.now()
  const w = await home()
  const sections = () => w.get('[data-testid="home-sections"]').element as HTMLElement
  await vi.waitFor(() => expect(w.find('[data-testid="home-skeleton"]').exists()).toBe(true))
  expect(sections().style.display).toBe('none')
  cachedAt.value = null
  await new Promise(r => setTimeout(r, 50))
  expect(sections().style.display).toBe('none')

  // Some sections in: still skeletons, nothing drawn yet.
  await open('coordinators')
  await open('alfred')
  await open('handle')
  await vi.waitFor(() => expect(homeFirstLoad.handle).toBe('ok'))
  expect(w.find('[data-testid="home-skeleton"]').exists()).toBe(true)
  expect(sections().style.display).toBe('none')

  // The last one: everything in one paint, coordinator and tasks to review included.
  await open('agents')
  await vi.waitFor(() => expect(w.find('[data-testid="home-skeleton"]').exists()).toBe(false))
  expect(sections().style.display).toBe('')
  expect(w.findAll('[data-testid="coordinator-row"]')).toHaveLength(1)
  expect(w.find('[data-testid="tasks-to-review"]').exists()).toBe(true)

  // A refresh in flight: the data stays, no skeleton.
  const refresh = loadCoordinators()
  await new Promise(r => setTimeout(r, 400))
  expect(w.find('[data-testid="home-skeleton"]').exists()).toBe(false)
  expect(w.findAll('[data-testid="coordinator-row"]')).toHaveLength(1)
  await open('coordinators')
  await refresh
  w.unmount()
})

it('a failed first read shows an error and Try again, not the list without its section', async () => {
  coordinatorsFail = true
  const w = await home()
  await open('alfred')
  await open('handle')
  await open('agents')
  await vi.waitFor(() => expect(w.find('[data-testid="load-error"]').exists()).toBe(true))
  expect((w.get('[data-testid="home-sections"]').element as HTMLElement).style.display).toBe('none')
  // Try again reads what is missing: the whole list at once.
  coordinatorsFail = false
  await w.get('[data-testid="load-retry"]').trigger('click')
  await open('coordinators')
  await vi.waitFor(() => expect(w.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
  expect(w.find('[data-testid="load-error"]').exists()).toBe(false)
  expect(w.find('[data-testid="tasks-to-review"]').exists()).toBe(true)
  w.unmount()
})
