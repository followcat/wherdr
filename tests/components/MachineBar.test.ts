import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import MachineBarSettings from '~/components/MachineBarSettings.vue'
import { desk, eventsOpen, herdrState, hostLabel } from '~/composables/useHerdr'
import { machineBarHidden, machineBarOn, machineBarOrder, machineBarSaved, machineGroups } from '~/composables/useMachineBar'
import { BAR_ALL } from '~/utils/machineBar'
import type { MachineInfo, Pane } from '#shared/types'
import type { TaskAgent } from '#shared/pm/taskAgents'
import { taskAgents } from '~/composables/useTaskAgents'
import { homeListReady } from '~/composables/useHomeLoad'

import { menuState } from '~/composables/useUi'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)
// The list reads its task agents: none, unless a test sets some.
let taskAnswer: Record<string, TaskAgent> = {}
registerEndpoint('/api/pm/agents', () => taskAnswer)


const machine = (key: string, label: string, status: MachineInfo['status'] = 'online'): MachineInfo =>
  ({ key, label, local: key === '', status, error: null, session: 'default' })
const pane = (id: string, machineKey: string, status: Pane['status'] = 'idle'): Pane => ({
  id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name: null, label: null,
  status, title: `Agent ${id}`, cwd: '/tmp/demo', agentSession: null, machine: machineKey,
})
const machines = [machine('', 'Server'), machine('laptop', 'Laptop'), machine('devbox', 'Devbox', 'offline')]
const panes = [
  pane('w1:p1', '', 'working'), pane('w2:p1', '', 'blocked'),
  pane('laptop/w1:p1', 'laptop', 'working'),
  pane('devbox/w1:p1', 'devbox'),
]
const workspaces = panes.map((p, i) => ({ id: p.workspace, number: i + 1, label: `space ${i + 1}`, focused: false, machine: p.machine }))

function setState() {
  herdrState.value = { ok: true, workspaces, panes, machines } as never
  eventsOpen.value = true
}
function reset() {
  homeListReady.value = true // the first load: HomeFirstLoad.test.ts
  for (const w of mounted) w.unmount()
  mounted = []
  machineGroups.value = []
  machineBarOn.value = true
  machineBarOrder.value = []
  machineBarHidden.value = []
  machineBarSaved.value = null
  localStorage.removeItem('machineConversations')
  navigate.mockClear()
  desk.value = false
  taskAnswer = {}
  taskAgents.value = {}
}
const pass = { template: '<div><slot /></div>' }
let mounted: { unmount: () => void }[] = []
const track = <T extends { unmount: () => void }>(w: T) => { mounted.push(w); return w }
const mountHome = async () => track(await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } }))

describe('the machine bar on the home list', () => {
  beforeEach(() => { reset(); setState() })
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; eventsOpen.value = false; reset() })

  it('restores a device-local conversation when a desktop tab excludes the current one', async () => {
    desk.value = true
    localStorage.setItem('machineConversations', JSON.stringify({ laptop: { pane: panes[2]!.id } }))
    const w = track(await mountSuspended(HomeView, { route: `/a/${encodeURIComponent(panes[0]!.id)}`, global: { stubs: { UContextMenu: pass, UTooltip: pass } } }))
    await w.find('[data-bar-id="laptop"]').trigger('click')
    expect(navigate).toHaveBeenCalledWith(`/a/${encodeURIComponent(panes[2]!.id)}`, { replace: true })
    expect(JSON.parse(localStorage.getItem('machineConversations')!)['*']).toEqual({ pane: panes[0]!.id })
  })

  it('keeps a matching conversation and All, then clears an incompatible view with no fallback', async () => {
    desk.value = true
    const w = track(await mountSuspended(HomeView, { route: `/a/${encodeURIComponent(panes[2]!.id)}`, global: { stubs: { UContextMenu: pass, UTooltip: pass } } }))
    await w.find('[data-bar-id="laptop"]').trigger('click')
    expect(navigate).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('machineConversations')!).laptop).toEqual({ pane: panes[2]!.id })
    await w.find('[data-bar-id="*"]').trigger('click')
    expect(navigate).not.toHaveBeenCalled()
    await w.find('[data-bar-id=""]').trigger('click')
    expect(navigate).toHaveBeenCalledWith('/', { replace: true })
  })

  it('stays on the board when a desktop tab changes (the board follows the tab itself)', async () => {
    desk.value = true
    localStorage.setItem('machineConversations', JSON.stringify({ laptop: { pane: panes[2]!.id } }))
    const w = track(await mountSuspended(HomeView, { route: '/board', global: { stubs: { UContextMenu: pass, UTooltip: pass } } }))
    await w.find('[data-bar-id="laptop"]').trigger('click')
    await w.find('[data-bar-id=""]').trigger('click')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('keeps the phone list first while retaining the per-tab history', async () => {
    localStorage.setItem('machineConversations', JSON.stringify({ laptop: { pane: panes[2]!.id } }))
    const w = await mountHome()
    await w.find('[data-bar-id="laptop"]').trigger('click')
    expect(navigate).not.toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('machineConversations')!).laptop).toEqual({ pane: panes[2]!.id })
  })

  it('merges online machines into state groups and badges every flat card', async () => {
    const w = await mountHome()
    expect(w.findAll('.machine-row, .project')).toHaveLength(0)
    expect(w.findAll('.state-group.working .card')).toHaveLength(2)
    expect(w.findAll('.state-group.blocked .card')).toHaveLength(1)
    expect(w.findAll('.state-group .card-origin').map(b => b.text())).toEqual(['Server', 'Server', 'Laptop'])
    expect(w.find('[data-pane="devbox/w1:p1"]').exists()).toBe(false)
    await w.findAll('.machine-bar-item')[2]!.trigger('click')
    // A single machine shown: its cards need no machine label.
    expect(w.find('.state-group .card').attributes('data-pane')).toBe('laptop/w1:p1')
    expect(w.find('.state-group .card-origin').exists()).toBe(false)
  })

  it('agents of one task share a row, in the most urgent one\'s group, a line per agent with its machine', async () => {
    const fix = { task: 'CO-1', shown: 'AC-1', title: 'Fix the login' }
    taskAnswer = { a1: { ...fix, role: 'fix' }, a2: { ...fix, role: 'review' } }
    taskAgents.value = taskAnswer
    herdrState.value = { ok: true, workspaces, machines, panes: panes.map(p => p.id === 'w2:p1' ? { ...p, coreAddress: 'a1' } : p.id === 'laptop/w1:p1' ? { ...p, coreAddress: 'a2' } : p) } as never
    const w = await mountHome()
    expect(w.findAll('.state-group.working .card').map(c => c.attributes('data-pane'))).toEqual(['w1:p1'])
    const row = w.find('.state-group.blocked .card')
    expect(row.find('.card-title').text()).toBe('Fix the login')
    expect(row.findAll('[data-testid="task-agent-line"]').map(l => l.text())).toEqual(['fix · Server', 'review · Laptop'])
  })

  it('filters state groups by a machine group, including an empty group', async () => {
    machineGroups.value = [{ id: '*group:studio', name: 'Studio', machines: ['laptop', 'devbox'] }, { id: '*group:empty', name: 'Empty', machines: [] }]
    const w = await mountHome()
    await w.findAll('.machine-bar-item').find(b => b.text().includes('Studio'))!.trigger('click')
    // A single machine shown: its cards need no machine label.
    expect(w.find('.state-group .card').attributes('data-pane')).toBe('laptop/w1:p1')
    expect(w.find('.state-group .card-origin').exists()).toBe(false)
    await w.findAll('.machine-bar-item').find(b => b.text().includes('Empty'))!.trigger('click')
    expect(w.findAll('.state-group .card')).toHaveLength(0)
    expect(w.find('.machine-empty').text()).toBe('No machines in this group.')
  })

  it('filters named sessions by their base machine and excludes reconnecting rows', async () => {
    const session = { ...machine('laptop/session', 'Laptop'), baseKey: 'laptop', session: 'review' }
    const sessionPane = pane('session/w1:p1', session.key, 'working')
    herdrState.value = { ok: true,
      machines: [machines[0]!, session, machine('reconnecting', 'Reconnecting', 'connecting')],
      workspaces: [...workspaces.slice(0, 2), { id: sessionPane.workspace, number: 3, label: 'Review', focused: false, machine: session.key }],
      panes: [...panes.slice(0, 2), sessionPane, pane('reconnecting/w1:p1', 'reconnecting', 'blocked')],
    }
    machineGroups.value = [{ id: '*group:studio', name: 'Studio', machines: ['laptop'] }]
    const w = await mountHome()
    expect(w.find('[data-pane="reconnecting/w1:p1"]').exists()).toBe(false)
    await w.findAll('.machine-bar-item').find(b => b.text().includes('Studio'))!.trigger('click')
    expect(w.findAll('.state-group .card')).toHaveLength(1)
    expect(w.find('.state-group .card').attributes('data-pane')).toBe(sessionPane.id)
  })

  it('a single machine: no bar (All and that machine are the same list), no machine label', async () => {
    // Herdr's state lists no machine when there is only this one.
    herdrState.value = { ok: true, workspaces: workspaces.slice(0, 2), panes: panes.slice(0, 2) }
    hostLabel.value = 'Server'
    const w = await mountHome()
    expect(w.find('.machine-bar').exists()).toBe(false)
    expect(w.findAll('.state-group .card')).toHaveLength(2)
    expect(w.find('.card-origin').exists()).toBe(false)
    hostLabel.value = ''
  })

  it('shows All first, then each machine with its state and count', async () => {
    const w = await mountHome()
    const items = w.findAll('.machine-bar-item')
    expect(items.map(i => i.find('.machine-bar-label').text())).toEqual(['All', 'Server', 'Laptop', 'Devbox'])
    // An offline machine's agents are stale: the counts leave them out.
    expect(items.map(i => i.find('.machine-bar-count').text())).toEqual(['3', '2', '1', '0'])
    expect(items[0]!.classes()).toContain('on')
    expect(items[0]!.find('.machine-bar-state').exists()).toBe(false)
    expect(items[1]!.classes()).toContain('online')
    expect(items[3]!.classes()).toContain('offline')
    // No section per machine: the offline one sits on the bottom line.
    expect(w.findAll('.state-group .card')).toHaveLength(3)
    expect(w.findAll('.state-away-item').map(a => a.attributes('data-machine'))).toEqual(['devbox'])
  })

  it('a tap shows that machine only, and the choice is kept on the device', async () => {
    const w = await mountHome()
    const shown = () => w.findAll('.state-group .card').map(c => c.attributes('data-pane'))
    await w.findAll('.machine-bar-item')[2]!.trigger('click')
    expect(shown()).toEqual(['laptop/w1:p1'])
    expect(w.findAll('.machine-bar-item')[2]!.attributes('aria-pressed')).toBe('true')
    expect(localStorage.getItem('machineBarPick')).toBe('"laptop"')
    // The counters follow the machine shown.
    expect(w.findAll('.stats .stat b').map(b => b.text())).toEqual(['0', '1', '0'])
    // The local machine's key is empty, and still a machine of its own.
    await w.findAll('.machine-bar-item')[1]!.trigger('click')
    expect(shown().sort()).toEqual(['w1:p1', 'w2:p1'])
    await w.findAll('.machine-bar-item')[0]!.trigger('click')
    expect(shown()).toHaveLength(3)
  })

  it('follows the settings: order, items taken off, turned off', async () => {
    machineBarOrder.value = ['laptop', BAR_ALL]
    machineBarHidden.value = ['']
    const w = await mountHome()
    expect(w.findAll('.machine-bar-label').map(i => i.text())).toEqual(['Laptop', 'All', 'Devbox'])
    // A machine off the bar still shows under All.
    expect(w.findAll('.state-group .card-origin').map(b => b.text())).toContain('Server')
    expect(w.find('.state-machines').exists()).toBe(false)
    // Turned off: still no machine chips.
    machineBarOn.value = false
    await nextTick()
    expect(w.find('.machine-bar').exists()).toBe(false)
    expect(w.find('.state-machines').exists()).toBe(false)
  })

})

describe('Settings › Machine bar', () => {
  beforeEach(() => { reset(); setState() })
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; reset() })

  it('lists All and every machine, a checkbox takes one off the bar', async () => {
    const w = track(await mountSuspended(MachineBarSettings))
    const rows = w.findAll('.bar-pref-row')
    expect(rows.map(r => r.find('.bar-pref-label span').text())).toEqual(['All', 'Server', 'Laptop', 'Devbox'])
    expect(rows.every(r => (r.find('input[type="checkbox"]').element as HTMLInputElement).checked)).toBe(true)
    await rows[2]!.find('input[type="checkbox"]').setValue(false)
    expect(machineBarHidden.value).toEqual(['laptop'])
    expect(localStorage.getItem('machineBarHidden')).toBe('["laptop"]')
    expect(w.findAll('.bar-pref-row')[2]!.classes()).toContain('off')
  })

  it('arrow keys on the handle move an item, Reset puts everything back', async () => {
    const w = track(await mountSuspended(MachineBarSettings))
    await w.findAll('.bar-pref-grip')[0]!.trigger('keydown', { key: 'ArrowDown' })
    expect(machineBarOrder.value).toEqual(['', BAR_ALL, 'laptop', 'devbox'])
    await w.findAll('.bar-pref-grip')[3]!.trigger('keydown', { key: 'ArrowUp' })
    expect(machineBarOrder.value).toEqual(['', BAR_ALL, 'devbox', 'laptop'])
    expect(w.findAll('.bar-pref-row').map(r => r.attributes('data-bar-id'))).toEqual(['', BAR_ALL, 'devbox', 'laptop'])
    machineBarHidden.value = ['devbox']
    machineBarSaved.value = 'laptop'
    await nextTick()
    await w.find('.bar-pref-reset').trigger('click')
    expect(machineBarOrder.value).toEqual([])
    expect(machineBarHidden.value).toEqual([])
    expect(machineBarSaved.value).toBe(BAR_ALL)
  })

  it('a single machine: All and that machine', async () => {
    herdrState.value = { ok: true, workspaces: [], panes: [] } as never
    const w = track(await mountSuspended(MachineBarSettings))
    expect(w.findAll('.bar-pref-row').map(r => r.attributes('data-bar-id'))).toEqual([BAR_ALL, ''])
    expect(w.findAll('.bar-pref-label span').map(r => r.text())).toEqual(['All', 'herdr'])
    expect(w.find('.bar-pref-state').classes()).toContain('online')
  })

  it('turned off, the list goes', async () => {
    const w = track(await mountSuspended(MachineBarSettings))
    machineBarOn.value = false
    await nextTick()
    expect(w.find('.bar-pref-list').exists()).toBe(false)
    expect(localStorage.getItem('machineBar')).toBe('0')
  })
})

describe('machine groups', () => {
  beforeEach(() => { reset(); setState() })
  afterEach(() => reset())

  it('counts and filters a group in its own order, then falls back when hidden', async () => {
    machineGroups.value = [{ id: '*group:home', name: 'Home', machines: ['laptop', ''] }]
    const w = await mountHome()
    const group = w.findAll('.machine-bar-item')[1]!
    expect(group.text()).toBe('Home3')
    expect(group.find('.machine-bar-group').exists()).toBe(true)
    await group.trigger('click')
    // The group's order: Laptop's card first in its state group.
    expect(w.findAll('.state-group.working .card-origin').map(b => b.text())).toEqual(['Laptop', 'Server'])
    expect(w.find('.state-away').exists()).toBe(false)
    machineBarHidden.value = ['*group:home']
    await nextTick()
    expect(w.findAll('.state-away-item')).toHaveLength(1)
  })

  it('creates, reorders, saves, edits, cancels and deletes a group', async () => {
    const w = track(await mountSuspended(MachineBarSettings))
    await w.find('.new-machine-group').trigger('click')
    expect(w.find('.save-machine-group').attributes('disabled')).toBeDefined()
    await w.find('.machine-group-name input').setValue(' Home ')
    await w.find('[data-bar-id=""] input').setValue(true)
    await w.find('[data-bar-id="laptop"] input').setValue(true)
    await w.find('[data-bar-id="laptop"] .bar-pref-grip').trigger('keydown', { key: 'ArrowUp' })
    expect(machineGroups.value).toEqual([])
    await w.find('.save-machine-group').trigger('click')
    expect(machineGroups.value[0]).toMatchObject({ name: 'Home', machines: ['laptop', ''] })
    expect(JSON.parse(localStorage.getItem('machineGroups')!)[0].machines).toEqual(['laptop', ''])
    const id = machineGroups.value[0]!.id
    await w.find(`[data-bar-id="${id}"] input`).setValue(false)
    expect(machineBarHidden.value).toEqual([id])
    await w.find('.machine-group-list button').trigger('click')
    await w.find('.machine-group-name input').setValue('Changed')
    await w.findAll('button').find(b => b.text() === 'Cancel')!.trigger('click')
    expect(machineGroups.value[0]!.name).toBe('Home')
    await w.find('.machine-group-list button').trigger('click')
    machineBarSaved.value = id
    await w.find('.delete-machine-group').trigger('click')
    expect(machineGroups.value).toEqual([])
    expect(machineBarSaved.value).toBe(BAR_ALL)
    expect(machineBarHidden.value).toEqual([])
  })

  it("an empty group never shows the only machine's agents", async () => {
    herdrState.value = { ok: true, workspaces: workspaces.slice(0, 2), panes: panes.slice(0, 2) } as never
    machineGroups.value = [{ id: '*group:empty', name: 'Empty', machines: [] }]
    machineBarSaved.value = '*group:empty'
    const w = await mountHome()
    expect(w.findAll('.card')).toHaveLength(0)
  })
})

describe('a tab showing one machine', () => {
  beforeEach(() => { reset(); setState(); menuState.open = false })
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; eventsOpen.value = false; menuState.open = false; reset() })
  // Long press with a finger: the phone's menu sheet.
  // Fake timers: a real press costs half a second each.
  async function press(el: Element) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      el.dispatchEvent(new PointerEvent('pointerdown', { pointerType: 'touch', clientX: 5, clientY: 5, bubbles: true }))
      vi.advanceTimersByTime(500)
      el.dispatchEvent(new PointerEvent('pointerup', { pointerType: 'touch', bubbles: true }))
      vi.runOnlyPendingTimers()
    } finally { vi.useRealTimers() }
  }

  it('a long press on the tab opens the machine\'s actions; no machine label on its cards', async () => {
    machineBarSaved.value = 'laptop'
    const w = await mountHome()
    expect(w.findAll('.state-group .card')).toHaveLength(1)
    expect(w.find('.card-origin').exists()).toBe(false)
    await press(w.find('[data-bar-id="laptop"]').element)
    expect(menuState.open).toBe(true)
    expect(menuState.items.map(i => 'label' in i ? i.label : '')).toContain('New agent here')
  })

  it('an offline machine stays on the bottom line, with its error', async () => {
    herdrState.value = { ...herdrState.value, machines: machines.map(m => m.key === 'devbox' ? { ...m, error: 'SSH unavailable' } : m) } as never
    machineBarSaved.value = 'devbox'
    const w = await mountHome()
    expect(w.find('.state-away-item').attributes('title')).toContain('SSH unavailable')
    expect(w.find('[data-bar-id="devbox"]').classes()).toContain('offline')
  })

  it('a group\'s menu opens its settings', async () => {
    machineGroups.value = [{ id: '*group:solo', name: 'Solo', machines: ['laptop'] }]
    machineBarSaved.value = '*group:solo'
    const w = await mountHome()
    await press(w.find('[data-bar-id="*group:solo"]').element)
    expect(menuState.items.map(i => i.label)).toEqual(['Group settings'])
    navigate.mockClear()
    menuState.items[0]!.run!()
    expect(navigate).toHaveBeenCalledWith({ path: '/settings', query: { section: 'appearance', group: '*group:solo' } })
    menuState.open = false
    // "All" has no menu.
    await press(w.find('[data-bar-id="*"]').element)
    expect(menuState.open).toBe(false)
  })

  it('Settings › Group settings opens that group\'s editor', async () => {
    machineGroups.value = [{ id: '*group:solo', name: 'Solo', machines: ['laptop'] }]
    navigate.mockClear()
    const w = track(await mountSuspended(MachineBarSettings, { route: { path: '/settings', query: { section: 'appearance', group: '*group:solo' } } }))
    await vi.waitFor(() => expect(w.find('.machine-group-name input').exists()).toBe(true))
    expect((w.find('.machine-group-name input').element as HTMLInputElement).value).toBe('Solo')
    // Read once: the query goes, the editor stays.
    expect(navigate).toHaveBeenCalledWith({ path: '/settings', query: { section: 'appearance' } }, { replace: true })
  })
})
