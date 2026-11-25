// The "Tabs of this space" sheet (AgentView.vue) shows each tab's terminal
// title under its label — even when the title repeated the label, so every
// row looked like a duplicated entry (#1000). The description shows only when
// it adds information.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { defineComponent, h } from 'vue'
import { UApp } from '#components'
import AgentView from '~/components/AgentView.vue'
import { herdrState } from '~/composables/useHerdr'
import { menuState } from '~/composables/useUi'
import type { Pane } from '#shared/types'

// The conversation's messages (none by default).
registerEndpoint('/api/chat', () => ({ available: true, token: 't', file: '/home/user/demo/t.jsonl', start: 0, items: [] }))

const pane = (id: string, tab: string, label: string): Pane => ({
  id, coreAddress: `host/${id}`, workspace: 'w1', tab, tabLabel: null, agent: null,
  name: null, label, status: null, title: '', cwd: '/home/user/demo', agentSession: null,
})

const setState = () => {
  herdrState.value = {
    ok: true,
    panes: [pane('w1:p1', 'w1:t1', 'build'), pane('w1:p2', 'w1:t2', 'server')],
    workspaces: [{ id: 'w1', label: 'demo', number: 1, status: null, worktree: false }],
    tabs: [
      { id: 'w1:t1', workspace: 'w1', label: 'build', number: 1, layout: null },
      { id: 'w1:t2', workspace: 'w1', label: 'api', number: 2, layout: null },
    ],
  } as never
}

afterEach(() => {
  herdrState.value = { ok: false, workspaces: [], panes: [] }
  menuState.open = false
})

it('tab map: a row keeps its description only when it differs from the label', async () => {
  // Tab "build" holds a pane named "build" (the description would repeat the
  // label); tab "api" holds a pane named "server" (a description that adds).
  setState()
  const w = await mountSuspended(defineComponent({ render: () => h(UApp, null, () => h(AgentView, { paneId: 'w1:p1' })) }), { route: '/a/w1:p1', attachTo: document.body })
  try {
    await w.find('[data-testid="space-map"]').trigger('click')
    expect(menuState.open).toBe(true)
    expect(menuState.title).toBe('Tabs of this space')
    const rows = menuState.items.slice(0, 2) // the tab rows, before the separator and New tab
    expect(rows.map(r => r.label)).toEqual(['build', 'api'])
    expect(rows[0]).not.toHaveProperty('desc')
    expect(rows[1]!.desc).toBe('server')
  } finally { w.unmount() }
})
