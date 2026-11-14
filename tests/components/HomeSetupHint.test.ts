// WHR-243: Home's empty state, while there is no project: a line, Alfred to set
// the first one up (its conversation, the setup asked of it), and the setup window.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody, type H3Event } from 'h3'
import HomeSetupHint from '~/components/HomeSetupHint.vue'
import HomeView from '~/components/HomeView.vue'
import { herdrState } from '~/composables/useHerdr'
import { ALFRED_SETUP_PROMPT } from '~/composables/useCoordinators'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

let projects: unknown[] = []
const sent: unknown[] = []
registerEndpoint('/api/pm/overview', () => ({ enabled: false, projects, templates: [], tasks: [] }))
registerEndpoint('/api/pm/coordinators', () => [])
registerEndpoint('/api/alfred', () => ({ name: 'Alfred', program: 'claude', terminal: 'host/t9' }))
const record = async (e: H3Event) => { sent.push(await readBody(e)); return {} }
registerEndpoint('/api/prompt', { method: 'POST', handler: record })
registerEndpoint('/api/input', { method: 'POST', handler: record })

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; sent.length = 0; navigate.mockReset(); document.body.innerHTML = '' })
const flush = () => new Promise(r => setTimeout(r, 20))

it('no project: points to Alfred, whose button sends it the setup and opens its conversation', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [{ id: 'p9', coreAddress: 'host/t9', status: 'idle', agent: 'claude', workspace: 'w', tab: 't' } as Pane] }
  projects = []
  w = await mountSuspended(HomeSetupHint, { attachTo: document.body })
  await vi.waitFor(() => expect(w!.find('[data-testid="home-setup"]').exists()).toBe(true))
  expect(w.text()).toContain('No project yet')
  expect(w.find('[data-testid="home-setup-alfred"]').text()).toBe('Set up a project with Alfred')
  expect(w.find('[data-testid="home-setup-window"]').exists()).toBe(true)
  await w.find('[data-testid="home-setup-alfred"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalled())
  expect(sent).toHaveLength(1)
  expect((sent[0] as { text: string }).text).toBe(ALFRED_SETUP_PROMPT)
})

it('with a project: nothing', async () => {
  projects = [{ key: 'WEB', name: 'Web', machine: '', path: '~/web', addedAt: 1 }]
  w = await mountSuspended(HomeSetupHint)
  await flush()
  expect(w.find('[data-testid="home-setup"]').exists()).toBe(false)
})

// On Home: Alfred's pane alone (it has its own row, no agent row) still shows the hint.
it('on Home, with only Alfred running: the hint shows', async () => {
  herdrState.value = { ok: true, workspaces: [{ id: 'w', number: 1, label: 's', focused: false, machine: '' }], machines: [{ key: '', label: 'Local', local: true, status: 'online', error: null, session: 'default' }],
    panes: [{ id: 'p9', coreAddress: 'host/t9', status: 'idle', agent: 'claude', workspace: 'w', tab: 't', machine: '' } as Pane] } as never
  projects = []
  const pass = { template: '<div><slot /></div>' }
  w = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
  await vi.waitFor(() => expect(w!.find('[data-testid="home-setup-alfred"]').exists()).toBe(true))
  expect(w.findAll('[data-testid="home-setup"]')).toHaveLength(1)
  herdrState.value = { ok: false, workspaces: [], panes: [] }
})
