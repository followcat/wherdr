// Backlot studio groups on Home: one collapsible row per studio and machine,
// forced open while a role waits, and counters that count every role pane.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import { eventsOpen, herdrState } from '~/composables/useHerdr'
import { homeListReady } from '~/composables/useHomeLoad'
import type { MachineInfo, Pane } from '#shared/types'

registerEndpoint('/api/pm/overview', () => ({ enabled: true, projects: [], templates: [], tasks: [] }))
registerEndpoint('/api/pm/coordinators', () => [])
registerEndpoint('/api/backlot', () => [])

const machine: MachineInfo = { key: 'm1', label: 'host-a', local: true, status: 'online', error: null, session: 'backlot' }
const rolePane = (id: string, tab: string, role: string, tabLabel: string, status: Pane['status'], over: Partial<Pane> = {}): Pane => ({
  id,
  machine: 'm1',
  session: 'backlot',
  workspace: 'w1',
  tab,
  tabLabel,
  agent: 'claude',
  name: `bl-acme-shop-${id.slice(-1)}`,
  label: null,
  status,
  title: null,
  cwd: '/home/user/acme-shop',
  agentSession: null,
  coreAddress: id,
  backlotRole: role,
  backlotStudio: 'acme-shop',
  labels: { 'backlot.studio': 'acme-shop', 'backlot.role': role, 'herdr.tab': tabLabel },
  ...over,
})
const producer = (status: Pane['status'] = 'working') => rolePane('w1:p1', 'w1:t1', 'producer', 'producer', status, { preview: 'Drafting v2 plan', stateSeq: 10 })
const actor = (status: Pane['status'] = 'idle') => rolePane('w1:p2', 'w1:t2', 'actor-t2-c1', 'actor-b t2', status, { stateSeq: 20 })
const plain = (): Pane => ({
  id: 'w1:p9', machine: 'm1', workspace: 'w2', tab: 'w2:t1', tabLabel: null, agent: 'claude', name: null, label: null,
  status: 'idle', title: 'Plain agent', cwd: '/home/user/plain', agentSession: null, coreAddress: 'w1:p9', stateSeq: 1,
})
const plainWorking = (): Pane => ({ ...plain(), id: 'w1:p8', coreAddress: 'w1:p8', status: 'working' as const })
const daemon = (): Pane => ({
  ...plain(), id: 'w1:pd', tab: 'w2:t1', name: 'backlot-stage', backlotRole: 'stage', labels: { 'backlot.role': 'stage' }, status: 'blocked', coreAddress: 'w1:pd',
})

function stateWith(panes: Pane[]) {
  herdrState.value = {
    ok: true,
    machines: [machine],
    workspaces: [
      { id: 'w1', number: 1, label: 'acme-shop', focused: false, machine: 'm1' },
      { id: 'w2', number: 2, label: 'plain', focused: false, machine: 'm1' },
    ],
    tabs: [
      { id: 'w1:t1', workspace: 'w1', machine: 'm1', label: 'producer', number: 1, layout: null },
      { id: 'w1:t2', workspace: 'w1', machine: 'm1', label: 'actor-b t2', number: 2, layout: null },
      { id: 'w2:t1', workspace: 'w2', machine: 'm1', label: 'plain', number: 1, layout: null },
    ],
    panes,
  } as never
  eventsOpen.value = true
  homeListReady.value = true
}
const pass = { template: '<div><slot /></div>' }
async function mountHome() {
  const w = await mountSuspended(HomeView, { global: { stubs: {
    UContextMenu: pass, UTooltip: pass,
    AlfredRow: { template: '<div />' }, ReviewCard: { template: '<div />' }, CoordinatorsSection: { template: '<div />' }, BacklotSection: { template: '<div />' },
  } } })
  await vi.waitFor(() => expect(w.find('[data-testid="studio-group"]').exists()).toBe(true))
  return w
}
const collapsed = () => JSON.parse(localStorage.getItem('studioCollapsed') || '[]') as string[]

let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
beforeEach(() => localStorage.removeItem('studioCollapsed'))
afterEach(() => {
  w?.unmount(); w = null
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  eventsOpen.value = false
  homeListReady.value = false
  localStorage.removeItem('studioCollapsed')
})

describe('studio groups on Home', () => {
  it('shows the header order, machine/session tag, waiting badge and role rows with agent subtitles', async () => {
    stateWith([producer(), actor('blocked'), plain(), daemon()])
    w = await mountHome()
    const group = w.get('[data-testid="studio-group"]')
    expect(group.get('.card-state').classes()).toContain('blocked')
    expect(group.get('[data-testid="studio-group-title"]').text()).toBe('acme-shop')
    expect(group.get('[data-testid="studio-group-machine"]').text()).toBe('[host-a · backlot]')
    expect(group.get('[data-testid="studio-group-waiting"]').text()).toBe('!1')
    expect(group.get('[data-testid="studio-group-toggle"]').attributes('aria-expanded')).toBe('true')
    const roles = group.findAll('[data-testid="studio-role"]')
    expect(roles).toHaveLength(2)
    expect(roles[0]!.text()).toContain('producer')
    expect(roles[0]!.text()).toContain('Claude')
    expect(roles[0]!.text()).toContain('Drafting v2 plan')
    expect(roles[1]!.text()).toContain('actor-b · t2')
    expect(w.text()).not.toContain('backlot-stage')
  })

  it('collapses and expands from the chevron or header body, persisted under studioCollapsed', async () => {
    stateWith([producer(), actor(), plain()])
    w = await mountHome()
    expect(w.findAll('[data-testid="studio-role"]')).toHaveLength(2)
    await w.get('[data-testid="studio-group-toggle"]').trigger('click')
    expect(w.findAll('[data-testid="studio-role"]')).toHaveLength(0)
    expect(collapsed()).toEqual(['backlot:m1:acme-shop'])

    w.unmount()
    stateWith([producer(), actor(), plain()])
    w = await mountHome()
    expect(w.findAll('[data-testid="studio-role"]')).toHaveLength(0)
    await w.get('[data-testid="studio-group-body"]').trigger('click')
    expect(w.findAll('[data-testid="studio-role"]')).toHaveLength(2)
    expect(collapsed()).toEqual([])
  })

  it('stays forced open while a role waits without overwriting the saved collapsed choice', async () => {
    localStorage.setItem('studioCollapsed', JSON.stringify(['backlot:m1:acme-shop']))
    stateWith([producer(), actor('blocked'), plain()])
    w = await mountHome()
    expect(w.findAll('[data-testid="studio-role"]')).toHaveLength(2)
    expect(w.get('[data-testid="studio-group-toggle"]').attributes('aria-expanded')).toBe('true')
    await w.get('[data-testid="studio-group-toggle"]').trigger('click')
    await w.get('[data-testid="studio-group-body"]').trigger('click')
    expect(w.findAll('[data-testid="studio-role"]')).toHaveLength(2)
    expect(collapsed()).toEqual(['backlot:m1:acme-shop'])
  })

  it('counts individual live role panes in section and top counters, excluding daemons', async () => {
    stateWith([producer('blocked'), actor('blocked'), plainWorking(), plain(), daemon()])
    w = await mountHome()
    expect(w.get('.agent-group.blocked .group-title .count').text()).toBe('2')
    expect(w.get('.agent-group.working .group-title .count').text()).toBe('1')
    const stats = w.findAll('.stats .stat').map(s => ({ cls: s.classes(), n: s.get('b').text() }))
    expect(stats.find(s => s.cls.includes('blocked'))?.n).toBe('2')
    expect(stats.find(s => s.cls.includes('working'))?.n).toBe('1')
    expect(stats.find(s => s.cls.includes('done'))?.n).toBe('1')
  })
})
