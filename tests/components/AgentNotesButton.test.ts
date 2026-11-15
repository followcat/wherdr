// WHR-345: Notes lives in the conversation header, not in the sidebar.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import AgentView from '~/components/AgentView.vue'
import HeaderMenu from '~/components/HeaderMenu.vue'
import { desk, herdrState } from '~/composables/useHerdr'
import { notesOpen } from '~/composables/useNotes'
import type { MenuItem } from '~/composables/useUi'
import type { Pane } from '#shared/types'

const pane: Pane = { id: 'w1:p7', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null }
registerEndpoint('/api/chat', () => ({ available: true, token: 't', file: '/home/user/demo/t.jsonl', start: 0, items: [] }))

async function mountAt(width: number) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() { this.cb([{ contentRect: { width } }] as never, this as never) }
    unobserve() {}
    disconnect() {}
  })
  desk.value = true
  herdrState.value = { ok: true, workspaces: [], panes: [pane] }
  const w = await mountSuspended(AgentView, { props: { paneId: pane.id }, route: '/a/w1:p7', global: { stubs: { UTooltip: { template: '<div><slot /></div>' } } } })
  await nextTick()
  return w
}
const menuLabels = (w: Awaited<ReturnType<typeof mountAt>>) => (w.getComponent(HeaderMenu).props('items') as () => MenuItem[])().map(i => i.label)

afterEach(() => { vi.unstubAllGlobals(); notesOpen.value = false; desk.value = false; herdrState.value = { ok: false, workspaces: [], panes: [] } })

it('wide header: the Notes button toggles the panel and shows it open', async () => {
  const w = await mountAt(900)
  try {
    const btn = () => w.get('[data-testid="agent-notes"]')
    expect(btn().attributes('aria-pressed')).toBe('false')
    await btn().trigger('click')
    expect(notesOpen.value).toBe(true)
    expect(btn().attributes('aria-pressed')).toBe('true')
    await btn().trigger('click')
    expect(notesOpen.value).toBe(false)
    expect(menuLabels(w)).not.toContain('Notes')
  } finally { w.unmount() }
})

it('narrow header: Notes is the first entry of the header\'s … menu', async () => {
  const w = await mountAt(400)
  try {
    expect(w.find('[data-testid="agent-notes"]').exists()).toBe(false)
    const items = (w.getComponent(HeaderMenu).props("items") as () => MenuItem[])()
    expect(items[0]?.label).toBe('Notes')
    items[0]!.run!()
    expect(notesOpen.value).toBe(true)
  } finally { w.unmount() }
})
