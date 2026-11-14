// WHR-48 regression: after #89, machines whose Claude quotas were read showed
// "Claude quotas not set up" right under their gauges (legacy status line
// reported `missing`). The home list never shows an install block now: at
// Its set-up stays in Settings › Agents only (WHR-72): no menu item either.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import HomeView from '~/components/HomeView.vue'
import { eventsOpen, herdrState, homeQuotas } from '~/composables/useHerdr'
import type { MachineInfo, Pane, Quotas } from '#shared/types'

const now = Date.now()
const win = (used: number, minutes: number) => ({ used, resetsAt: now + 3600000, minutes })
const account = (key: string, label: string, five: number, week: number) =>
  ({ five: win(five, 300), week: win(week, 10080), at: now, account: key.padEnd(16, 'a'), machines: [{ key, label }] })
// Two machines on different Claude accounts, both read from an older status line.
const quotas: Quotas = {
  claude: { five: win(4, 300), week: win(43, 10080), at: now },
  codex: null,
  claudeAccounts: [account('', 'Server', 4, 43), account('ab12', 'Laptop', 11, 7)],
  claudeSetup: [{ key: '', state: 'outdated', installable: true }, { key: 'ab12', state: 'outdated', installable: true }],
}
let served: Quotas = quotas
registerEndpoint('/api/quotas', () => served)

const machine = (key: string, label: string): MachineInfo => ({ key, label, local: key === '', status: 'online', error: null, session: 'default' })
const pane = (id: string, m: string): Pane => ({
  id, workspace: id.split(':')[0]!, tab: `${id.split(':')[0]}:t1`, tabLabel: null, agent: 'claude', name: null, label: null,
  status: 'idle', title: `Agent ${id}`, cwd: '/tmp/demo', agentSession: null, machine: m,
})
const panes = [pane('w1:p1', ''), pane('ab12/w1:p1', 'ab12')]
const pass = { template: '<div><slot /></div>' }

describe('home list: Claude quota setup', () => {
  beforeEach(() => {
    herdrState.value = { ok: true, panes, machines: [machine('', 'Server'), machine('ab12', 'Laptop')], workspaces: panes.map((p, i) => ({ id: p.workspace, number: i + 1, label: `s${i}`, focused: false, machine: p.machine })) } as never
    eventsOpen.value = true
  })
  afterEach(() => { herdrState.value = { ok: false, workspaces: [], panes: [] }; eventsOpen.value = false; homeQuotas.value = null; served = quotas })

  it('quotas read for a machine: its gauges, and no "not set up" banner', async () => {
    homeQuotas.value = quotas
    const w = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
    await new Promise(r => setTimeout(r, 0))
    expect(w.findAll('.state-machine-quotas .machine-quotas').length).toBe(2)
    expect(w.text()).not.toMatch(/not set up|non configurés/i)
    expect(w.find('.claude-setup').exists()).toBe(false)
    w.unmount()
  })

  it('a single machine without a bar: no suggestion in the header "…"', async () => {
    homeQuotas.value = { ...quotas, claudeAccounts: [], claudeSetup: [{ key: '', state: 'outdated', installable: true }] }
    herdrState.value = { ok: true, panes: panes.slice(0, 1), workspaces: [{ id: 'w1', number: 1, label: 's0', focused: false, machine: '' }] } as never
    const w = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
    expect(w.find('.machine-bar').exists()).toBe(false)
    expect(w.find('.home-actions .space-menu').exists()).toBe(false)
    w.unmount()
  })

  it('even with nothing installed, no install block in the list', async () => {
    served = { claude: null, codex: null, claudeSetup: [{ key: '', state: 'missing', installable: true }, { key: 'ab12', state: 'missing', installable: true }] }
    homeQuotas.value = served
    const w = await mountSuspended(HomeView, { global: { stubs: { UContextMenu: pass, UTooltip: pass } } })
    await new Promise(r => setTimeout(r, 0))
    expect(w.text()).not.toMatch(/not set up|non configurés|Copy command/i)
    expect(w.find('.claude-setup').exists()).toBe(false)
    w.unmount()
  })
})
