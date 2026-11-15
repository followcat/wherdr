// WHR-398/403: the COORDINATORS section under Alfred: the project
// coordinators that run, or whose conversation stopped (WHR-136). One tap
// opens a conversation, or offers to resume the stopped one.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import CoordinatorsSection from '~/components/CoordinatorsSection.vue'
import { nextTick } from 'vue'
import { appConfig, coarse, curPane, desk, herdrState } from '~/composables/useHerdr'
import { alfred, coordinatorOrder, coordinators, coordinatorsHidden, loadCoordinators, paneCoordinatorName } from '~/composables/useCoordinators'
import { answerConfirm, confirmState, menuState } from '~/composables/useUi'
import { paneNotificationsMuted } from '~/composables/useNotificationRules'
import { machineBarSaved, machineGroups } from '~/composables/useMachineBar'
import { MAIN, type CoordinatorView } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const posts: unknown[] = []
let views: CoordinatorView[] = []
registerEndpoint('/api/pm/coordinators', () => views)
registerEndpoint('/api/pm/coordinator-start', { method: 'POST', handler: async (e) => { posts.push(await readBody(e)); return { terminal: 'host/t9' } } })
registerEndpoint('/api/pm/project-update', { method: 'POST', handler: async (e) => { posts.push({ update: await readBody(e) }); return {} } })
registerEndpoint('/api/close', { method: 'POST', handler: async (e) => { posts.push({ close: await readBody(e) }); return {} } })
registerEndpoint('/api/pm/coordinator-agent', { method: 'POST', handler: async (e) => { posts.push({ agent: await readBody(e) }); return {} } })

const pane = (id: string, coreAddress: string) => ({ id, coreAddress, status: 'idle', agent: 'claude', workspace: 'w', tab: 't' }) as Pane
const view = (project: string, more: Partial<CoordinatorView> = {}): CoordinatorView => ({ project, name: `${project.toLowerCase()} app`, agent: { program: 'claude' }, ...more })
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
// A coordinators read still in flight would answer the next test's first one
// with this test's views (loadCoordinators shares it): let it end first.
afterEach(async () => { w?.unmount(); w = null; coordinatorOrder.value = []; coordinatorsHidden.value = []; posts.length = 0; navigate.mockReset(); document.body.innerHTML = ''; await loadCoordinators() })

it('lists the running project coordinators only (Alfred, the main one, has its own row)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  views = [view(MAIN, { main: true, terminal: 'host/t1' }), view('CO', { terminal: 'host/t1' }), view('ST')]
  w = await mountSuspended(CoordinatorsSection)
  await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
  const co = w.find('[data-testid="coordinator-row"]')
  // Its key badge, then its project's name.
  expect(co.find('[data-testid="project-badge"]').text()).toBe('CO')
  expect(co.find('[data-testid="coordinator-name"]').text()).toBe('co app')
  // Running: one tap opens its conversation, nothing started.
  await co.trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w%3Ap1'))
  expect(posts).toEqual([])
})

it('shows a coordinator whose terminal ended as stopped, and resumes its conversation on demand (WHR-136)', async () => {
  // Panes not read yet: not stopped, no row.
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  views = [view('CO', { terminal: 'host/t1', ran: { program: 'codex' } })]
  w = await mountSuspended(CoordinatorsSection, { attachTo: document.body })
  await vi.waitFor(() => expect(coordinators.value).toHaveLength(1))
  expect(w.findAll('[data-testid="coordinator-row"]')).toHaveLength(0)
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
  const row = w.find('[data-testid="coordinator-row"]')
  expect(row.text()).toContain('Codex · Stopped')
  await row.trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="coordinator-stopped-new"]')).not.toBeNull())
  ;(document.querySelector('[data-testid="coordinator-stopped-resume"]') as HTMLElement).click()
  await vi.waitFor(() => expect(posts).toEqual([{ project: 'CO', resume: true }]))
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

it('follows the home tab: a personal tab hides a work project, All shows all (WHR-152)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1'), pane('w:p2', 'host/t2')] }
  views = [view('HOME', { terminal: 'host/t1', machines: ['laptop'] }), view('WORK', { terminal: 'host/t2', machines: ['office'] })]
  machineGroups.value = [{ id: '*group:personal', name: 'Personal', machines: ['laptop'] }, { id: '*group:work', name: 'Work', machines: ['office'] }]
  try {
    machineBarSaved.value = '*group:personal'
    w = await mountSuspended(CoordinatorsSection)
    const shown = () => w!.findAll('[data-testid="coordinator-row"]').map(r => r.text())
    await vi.waitFor(() => expect(shown()).toHaveLength(1))
    expect(shown()[0]).toContain('home app')
    machineBarSaved.value = '*'
    await vi.waitFor(() => expect(shown()).toHaveLength(2))
  } finally { machineGroups.value = []; machineBarSaved.value = null }
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
    expect(w.findComponent({ name: 'UContextMenu' }).props('items').flat().map((i: { label: string }) => i.label)).toContain('Restart with…')
    w.unmount()
    desk.value = false
    coarse.value = true
    w = await mountSuspended(CoordinatorsSection, { attachTo: document.body })
    await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
    const row = w.find('[data-testid="coordinator-row"]')
    // No iOS text selection or callout on the long press (WHR-354): the shared no-select class.
    expect(row.element.closest('.press-row')).not.toBeNull()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await row.trigger('pointerdown', { pointerType: 'touch', button: 0, clientX: 0, clientY: 0 })
      vi.advanceTimersByTime(720)
      await row.trigger('pointerup')
      await row.trigger('click')
    } finally { vi.useRealTimers() }
    expect(navigate).not.toHaveBeenCalled()
    menuState.items.find(i => i.label === 'Restart with…')!.run!()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="coordinator-sheet"]')).not.toBeNull())
    expect(document.querySelector('[data-agent="claude"]')!.getAttribute('aria-checked')).toBe('true')
    ;(document.querySelector('[data-agent="codex"]') as HTMLElement).click()
    await nextTick()
    ;(document.querySelector('[data-testid="coordinator-restart"]') as HTMLElement).click()
    await vi.waitFor(() => expect(posts).toEqual([{ agent: { project: 'CO', program: 'codex' } }, { project: 'CO', program: 'codex' }]))
  } finally { desk.value = false; coarse.value = false; menuState.open = false }
})

it('its menu opens the board, settings and autopilot, renames it inline, mutes it and stops it after a confirm (WHR-325)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  views = [view('CO', { terminal: 'host/t1', autopilot: { on: true, goal: '', events: [], perDay: 10, atOnce: 2 } })]
  desk.value = true
  coarse.value = false
  w = await mountSuspended(CoordinatorsSection, { attachTo: document.body })
  await vi.waitFor(() => expect(w!.findAll('[data-testid="coordinator-row"]')).toHaveLength(1))
  const items = () => w!.findComponent({ name: 'UContextMenu' }).props('items').flat() as { label: string, icon: string, description?: string, onSelect: () => void }[]
  const pick = (label: string) => items().find(i => i.label === label)!.onSelect()
  expect(items().map(i => i.label)).toEqual(['Open the board', 'Project settings', 'Autopilot', 'Rename…', 'Mute notifications', 'Move to hidden', 'Restart with…', 'Stop the coordinator'])
  await vi.waitFor(() => expect(items()[2]).toMatchObject({ icon: 'i-lucide-check', description: 'On' }))
  pick('Open the board')
  pick('Project settings')
  pick('Autopilot')
  expect(navigate.mock.calls.map(c => c[0])).toEqual(['/board?project=CO', '/settings?section=projects&project=CO&tab=general', '/settings?section=projects&project=CO&tab=autopilot'])
  // Rename…: an inline field, saved on Enter; its project's name means none.
  pick('Rename…')
  await vi.waitFor(() => expect(w!.find('[data-testid="coordinator-rename"]').exists()).toBe(true))
  await w.find('[data-testid="coordinator-rename"] input').setValue('Pilot')
  await w.find('[data-testid="coordinator-rename"]').trigger('submit')
  await vi.waitFor(() => expect(posts).toEqual([{ update: { key: 'CO', coordinatorName: 'Pilot' } }]))
  expect(w.find('[data-testid="coordinator-rename"]').exists()).toBe(false)
  // Mute: the conversation header's levels, on its coordinator.
  pick('Mute notifications')
  menuState.items.find(i => i.label === 'Muted')!.run!()
  expect(paneNotificationsMuted(pane('w:p1', 'host/t1'))).toBe(true)
  await vi.waitFor(() => expect(items().map(i => i.label)).toContain('Unmute notifications'))
  menuState.items.find(i => i.label?.startsWith('Follow the default'))!.run!()
  // Stop: closes its pane once confirmed.
  posts.length = 0
  pick('Stop the coordinator')
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  answerConfirm(false)
  pick('Stop the coordinator')
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  answerConfirm(true)
  await vi.waitFor(() => expect(posts).toEqual([{ close: { pane_id: 'w:p1' } }]))
  desk.value = false
  menuState.open = false
})

it("titles a coordinator's pane by its name, not its session title (WHR-15)", () => {
  coordinators.value = [view(MAIN, { main: true, terminal: 'host/t1' }), view('CO', { terminal: 'host/t2' })]
  const p = (id: string, at: string) => ({ ...pane(id, at), title: 'Template proposal' }) as Pane
  expect(paneCoordinatorName(p('w:p2', 'host/t2'))).toBe('co app')
  coordinators.value[1]!.coordinatorName = 'Pilot'
  expect(paneCoordinatorName(p('w:p2', 'host/t2'))).toBe('Pilot')
  // The main coordinator: Alfred's current name, the default before it loads.
  alfred.value = null
  expect(paneCoordinatorName(p('w:p1', 'host/t1'))).toBe('Alfred')
  alfred.value = { name: 'Jeeves', terminal: 'host/t1' }
  expect(paneCoordinatorName(p('w:p1', 'host/t1'))).toBe('Jeeves')
  expect(paneCoordinatorName(p('w:p3', 'host/t3'))).toBe('')
})

// WHR-331: the user's order (drag, arrow keys) and the Hidden group.
const names = () => w!.findAll('[data-testid="coordinator-name"]').map(n => n.text())
const toggle = () => w!.find('[data-testid="coordinators-hidden-toggle"]')
async function mountThree(panes = [pane('w:p1', 'host/t1'), pane('w:p2', 'host/t2'), pane('w:p3', 'host/t3')]) {
  herdrState.value = { ok: true, workspaces: [], panes }
  views = [view('AA', { terminal: 'host/t1' }), view('BB', { terminal: 'host/t2' }), view('CC', { terminal: 'host/t3' })]
  w = await mountSuspended(CoordinatorsSection, { attachTo: document.body })
  await vi.waitFor(() => expect(names()).toHaveLength(3))
}

it('a drag by the handle saves the new order, a drop on the Hidden group hides it (WHR-331)', async () => {
  await mountThree()
  // Each item 48px tall, one under the other (the Hidden mark last).
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const i = [...document.querySelectorAll('[data-order-id]')].indexOf(this.closest('[data-order-id]')!)
    return { top: i * 48, height: 48, bottom: i * 48 + 48, left: 0, right: 300, width: 300, x: 0, y: i * 48, toJSON: () => ({}) } as DOMRect
  })
  try {
    const drag = (from: number, dy: number) => {
      const grip = w!.findAll('[data-grip]')[from]!.element
      grip.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerId: 1, pointerType: 'mouse', button: 0, clientY: from * 48 + 24 }))
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientY: from * 48 + 24 + dy }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1 }))
    }
    drag(0, 60)
    await vi.waitFor(() => expect(names()).toEqual(['bb app', 'aa app', 'cc app']))
    expect(coordinatorOrder.value).toEqual(['BB', 'AA', 'CC'])
    // Below the Hidden mark: hidden, the link counts it.
    drag(2, 60)
    await vi.waitFor(() => expect(names()).toEqual(['bb app', 'aa app']))
    expect(coordinatorsHidden.value).toEqual(['CC'])
    expect(toggle().text()).toBe('Show hidden (1)')
  } finally { rect.mockRestore() }
})

it('Move to hidden / Move back, the group collapsed until its link opens it (WHR-331)', async () => {
  desk.value = true
  try {
    await mountThree()
    const pick = (row: number, label: string) => (w!.findAllComponents({ name: 'UContextMenu' })[row]!.props('items').flat() as { label: string, onSelect: () => void }[]).find(i => i.label === label)!.onSelect()
    pick(0, 'Move to hidden')
    await vi.waitFor(() => expect(names()).toEqual(['bb app', 'cc app']))
    expect(toggle().text()).toBe('Show hidden (1)')
    await toggle().trigger('click')
    await vi.waitFor(() => expect(names()).toEqual(['bb app', 'cc app', 'aa app']))
    expect(toggle().text()).toBe('Hide')
    expect(w.findAll('[data-testid="coordinator-row"]')[2]!.classes()).toContain('aside')
    pick(2, 'Move back')
    await vi.waitFor(() => expect(names()).toEqual(['aa app', 'bb app', 'cc app']))
    expect(coordinatorsHidden.value).toEqual([])
  } finally { desk.value = false }
})

it('a hidden coordinator that needs the user shows in the main list (WHR-331)', async () => {
  coordinatorsHidden.value = ['BB']
  await mountThree([pane('w:p1', 'host/t1'), { ...pane('w:p2', 'host/t2'), status: 'blocked' }, pane('w:p3', 'host/t3')])
  expect(names()).toEqual(['aa app', 'bb app', 'cc app'])
  expect(toggle().classes()).toContain('empty')
  herdrState.value = { ...herdrState.value, panes: [pane('w:p1', 'host/t1'), pane('w:p2', 'host/t2'), pane('w:p3', 'host/t3')] }
  await vi.waitFor(() => expect(names()).toEqual(['aa app', 'cc app']))
  expect(toggle().text()).toBe('Show hidden (1)')
})
