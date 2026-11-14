// The home list's header: the Board button (WHR-395, where it leads:
// tests/boardEntry.test.ts). With the machine bar off, no machine chips
// (WHR-72): only a machine that is not connected gets a line, with Reconnect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import { eventsOpen, herdrState } from '~/composables/useHerdr'
import { machineBarOn } from '~/composables/useMachineBar'
import { newAgentMachine, newAgentOpen } from '~/composables/useUi'
import type { MachineInfo, Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)
const connect = vi.fn(() => ({ ok: true }))
registerEndpoint('/api/machine/connect', { method: 'POST', handler: connect })
// Off: the button must read this overview to land anywhere but the board.
registerEndpoint('/api/pm/overview', () => ({ enabled: false, projects: [], templates: [] }))

const machine = (key: string, label: string, status: MachineInfo['status'] = 'online'): MachineInfo =>
  ({ key, label, local: key === '', status, error: null, session: 'default' })
const pane = (id: string, m: string): Pane => ({
  id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name: null, label: null,
  status: 'idle', title: `Agent ${id}`, cwd: '/tmp/demo', agentSession: null, machine: m,
})
const pass = { template: '<div><slot /></div>' }
const mountHome = () => mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })

describe('home list header', () => {
  beforeEach(() => {
    machineBarOn.value = false
    const panes = [pane('dell/w1:p1', 'dell')]
    herdrState.value = { ok: true, panes, machines: [machine('', 'Local'), machine('dell', 'Dell'), machine('vps', 'Vps', 'offline')],
      workspaces: panes.map((p, i) => ({ id: p.workspace, number: i + 1, label: `s${i}`, focused: false, machine: p.machine })) } as never
    eventsOpen.value = true
  })
  afterEach(() => {
    herdrState.value = { ok: false, workspaces: [], panes: [] }
    eventsOpen.value = false
    newAgentOpen.value = false
    newAgentMachine.value = null
    machineBarOn.value = true
    navigate.mockClear()
  })

  it('the Board button reads the overview: project management off opens Settings › Projects', async () => {
    const w = await mountHome()
    // No big title, no silenced line: one row of buttons.
    expect(w.find('.home-top .display').exists()).toBe(false)
    await w.get('[data-testid="home-board"]').trigger('click')
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/settings?section=projects'))
    w.unmount()
  })

  it('every machine online: no machine chips and no offline line', async () => {
    herdrState.value = { ...herdrState.value, machines: [machine('', 'Local'), machine('dell', 'Dell')] } as never
    const w = await mountHome()
    expect(w.find('.state-machines').exists()).toBe(false)
    expect(w.find('.state-away').exists()).toBe(false)
    w.unmount()
  })

  it('an offline machine gets one line with Reconnect', async () => {
    const w = await mountHome()
    const lines = w.findAll('.state-away-item')
    expect(lines.map(l => l.attributes('data-machine'))).toEqual(['vps'])
    expect(lines[0]!.text()).toMatch(/Vps.*offline/i)
    await lines[0]!.get('.state-away-reconnect').trigger('click')
    await vi.waitFor(() => expect(connect).toHaveBeenCalled())
    w.unmount()
  })
})
