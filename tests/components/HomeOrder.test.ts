// WHR-330: Home's list puts Tasks to review right under Alfred, above the
// Coordinators section, so reviews stay in sight with many projects.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import { herdrState } from '~/composables/useHerdr'

registerEndpoint('/api/pm/overview', () => ({ enabled: true, projects: [], templates: [], tasks: [] }))
registerEndpoint('/api/pm/coordinators', () => [])

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; herdrState.value = { ok: false, workspaces: [], panes: [] } })

it('renders the Tasks to review card between Alfred and the Coordinators', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  const pass = { template: '<div><slot /></div>' }
  w = await mountSuspended(HomeView, { global: { stubs: {
    UContextMenu: pass, UTooltip: pass,
    AlfredRow: { template: '<div data-testid="alfred" />' },
    ReviewCard: { template: '<section data-testid="tasks-to-review" />' },
    CoordinatorsSection: { template: '<section data-testid="coordinators" />' },
  } } })
  await vi.waitFor(() => expect(w!.find('[data-testid="coordinators"]').exists()).toBe(true))
  const order = [...w.element.querySelectorAll('[data-testid="alfred"], [data-testid="tasks-to-review"], [data-testid="coordinators"]')]
    .map(e => e.getAttribute('data-testid'))
  expect(order).toEqual(['alfred', 'tasks-to-review', 'coordinators'])
})
