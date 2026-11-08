// WHR-398/403: the COORDINATORS section under Alfred: the project
// coordinators that run. One tap opens a conversation.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import CoordinatorsSection from '~/components/CoordinatorsSection.vue'
import { nextTick } from 'vue'
import { appConfig, coarse, curPane, desk, herdrState } from '~/composables/useHerdr'
import { alfred, coordinators, paneCoordinatorName } from '~/composables/useCoordinators'
import { menuState } from '~/composables/useUi'
import { MAIN, type CoordinatorView } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const posts: unknown[] = []
let views: CoordinatorView[] = []
registerEndpoint('/api/pm/coordinators', () => views)
registerEndpoint('/api/pm/coordinator-start', { method: 'POST', handler: async (e) => { posts.push(await readBody(e)); return { terminal: 'host/t9' } } })
registerEndpoint('/api/pm/coordinator-agent', { method: 'POST', handler: async (e) => { posts.push({ agent: await readBody(e) }); return {} } })

const pane = (id: string, coreAddress: string) => ({ id, coreAddress, status: 'idle', agent: 'claude', workspace: 'w', tab: 't' }) as Pane
const view = (project: string, more: Partial<CoordinatorView> = {}): CoordinatorView => ({ project, name: project, agent: { program: 'claude' }, ...more })
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; posts.length = 0; navigate.mockReset(); document.body.innerHTML = '' })

it('lists the running project coordinators only (Alfred, the main one, has its own row)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  views = [view(MAIN, { main: true, terminal: 'host/t1' }), view('CO', { terminal: 'host/t1' }), view('ST')]
  w = await mountSuspended(CoordinatorsSection)
  await vi.waitFor(() => expect(w!.findAll('button')).toHaveLength(1))
  const co = w.find('button')
  expect(co.text()).toContain('CO coordinator')
  // Running: one tap opens its conversation, nothing started.
  await co.trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w%3Ap1'))
  expect(posts).toEqual([])
})

it('shows the coordinator whose conversation is open as selected, one at a time, following navigation', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1'), pane('w:p2', 'host/t2'), pane('w:p3', 'host/t3')] }
  views = [view('CO', { terminal: 'host/t1' }), view('ST', { terminal: 'host/t2' })]
  curPane.value = 'w:p2'
  try {
    w = await mountSuspended(CoordinatorsSection)
    await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(2))
    const current = () => w!.findAll('[data-testid="coordinator-row"]').map(r => [r.classes().includes('sel'), r.attributes('aria-current')])
    expect(current()).toEqual([[false, undefined], [true, 'page']])
    // An agent's conversation opened: no coordinator selected.
    curPane.value = 'w:p3'
    await nextTick()
    expect(current()).toEqual([[false, undefined], [false, undefined]])
  } finally { curPane.value = null }
})

it('is hidden while project management is off', async () => {
  views = []
  w = await mountSuspended(CoordinatorsSection)
  await new Promise(r => setTimeout(r, 50))
  expect(w.find('[data-testid="coordinators"]').exists()).toBe(false)
})

it('no ••• button: right click (computer) and long press (touch) open its menu, Restart with… sets the agent and restarts it', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  appConfig.value = { ...appConfig.value, kinds: ['claude', 'codex'] }
  views = [view('CO', { terminal: 'host/t1', agent: { program: 'claude', model: 'm' } })]
  try {
    desk.value = true
    coarse.value = false
    w = await mountSuspended(CoordinatorsSection, { attachTo: document.body })
    await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
    expect(w.find('button[aria-label*="Options"]').exists()).toBe(false)
    expect(w.findComponent({ name: 'UContextMenu' }).props('items').flat().map((i: { label: string }) => i.label)).toEqual(['Restart with…'])
    w.unmount()
    desk.value = false
    coarse.value = true
    w = await mountSuspended(CoordinatorsSection, { attachTo: document.body })
    await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
    const row = w.find('[data-testid="coordinator-row"]')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await row.trigger('pointerdown', { pointerType: 'touch', button: 0, clientX: 0, clientY: 0 })
      vi.advanceTimersByTime(720)
      await row.trigger('pointerup')
      await row.trigger('click')
    } finally { vi.useRealTimers() }
    expect(navigate).not.toHaveBeenCalled()
    expect(menuState.items.map(i => i.label)).toEqual(['Restart with…'])
    menuState.items[0]!.run!()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="coordinator-sheet"]')).not.toBeNull())
    expect(document.querySelector('[data-agent="claude"]')!.getAttribute('aria-checked')).toBe('true')
    ;(document.querySelector('[data-agent="codex"]') as HTMLElement).click()
    await nextTick()
    ;(document.querySelector('[data-testid="coordinator-restart"]') as HTMLElement).click()
    await vi.waitFor(() => expect(posts).toEqual([{ agent: { project: 'CO', program: 'codex' } }, { project: 'CO', program: 'codex' }]))
  } finally { desk.value = false; coarse.value = false; menuState.open = false }
})

it("titles a coordinator's pane by its name, not its session title (WHR-15)", () => {
  coordinators.value = [view(MAIN, { main: true, terminal: 'host/t1' }), view('CO', { terminal: 'host/t2' })]
  const p = (id: string, at: string) => ({ ...pane(id, at), title: 'Template proposal' }) as Pane
  expect(paneCoordinatorName(p('w:p2', 'host/t2'))).toBe('CO coordinator')
  // The main coordinator: Alfred's current name, the default before it loads.
  alfred.value = null
  expect(paneCoordinatorName(p('w:p1', 'host/t1'))).toBe('Alfred')
  alfred.value = { name: 'Jeeves', terminal: 'host/t1' }
  expect(paneCoordinatorName(p('w:p1', 'host/t1'))).toBe('Jeeves')
  expect(paneCoordinatorName(p('w:p3', 'host/t3'))).toBe('')
})
