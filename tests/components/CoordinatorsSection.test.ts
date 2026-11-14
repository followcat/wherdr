// WHR-398/403: the COORDINATORS section under Alfred: the project
// coordinators that run, or whose conversation stopped (WHR-136). One tap
// opens a conversation, or offers to resume the stopped one.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import CoordinatorsSection from '~/components/CoordinatorsSection.vue'
import { nextTick } from 'vue'
import { appConfig, coarse, curPane, desk, herdrState } from '~/composables/useHerdr'
import { alfred, coordinators, loadCoordinators, paneCoordinatorName } from '~/composables/useCoordinators'
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
afterEach(async () => { w?.unmount(); w = null; posts.length = 0; navigate.mockReset(); document.body.innerHTML = ''; await loadCoordinators() })

it('lists the running project coordinators only (Alfred, the main one, has its own row)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  views = [view(MAIN, { main: true, terminal: 'host/t1' }), view('CO', { terminal: 'host/t1' }), view('ST')]
  w = await mountSuspended(CoordinatorsSection)
  await vi.waitFor(() => expect(w!.findAll('button')).toHaveLength(1))
  const co = w.find('button')
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
  expect(items().map(i => i.label)).toEqual(['Open the board', 'Project settings', 'Autopilot', 'Rename…', 'Mute notifications', 'Restart with…', 'Stop the coordinator'])
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
