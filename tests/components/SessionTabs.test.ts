import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SessionTabs from '~/components/SessionTabs.vue'
import { allSessionsState } from '~/composables/useHerdr'
import type { HerdrState, Pane } from '#shared/types'

const pane = (id: string, session: string, status: Pane['status']): Pane => ({
  id, session, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null,
  label: null, status, title: null, cwd: null, agentSession: null,
})

function state(): HerdrState {
  return {
    ok: true, ready: true, workspaces: [], panes: [
      pane('w1:p1', 'default', 'idle'),
      pane('saaaaaaaaaaaaaaaa~w1:p1', 'backlot', 'blocked'),
      pane('sbbbbbbbbbbbbbbbb~w1:p1', 'backlot', 'done'),
      pane('scccccccccccccccc~w1:p1', 'alpha', 'working'),
    ],
    sessions: [
      { key: '', name: 'default', primary: true, status: 'online' },
      { key: 'sbbbbbbbbbbbbbbbb', name: 'backlot', primary: false, status: 'online' },
      { key: 'saaaaaaaaaaaaaaaa', name: 'alpha', primary: false, status: 'online' },
      { key: 'scccccccccccccccc', name: 'empty', primary: false, status: 'online' },
    ],
  }
}

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; localStorage.removeItem('sessionTab'); allSessionsState.value = { ok: false, workspaces: [], panes: [] } })

describe('SessionTabs', () => {
  it('shows primary first then alphabetical sessions, hides empty non-primary sessions and counts waiting panes', async () => {
    allSessionsState.value = state()
    const w = await mountSuspended(SessionTabs)
    mounted = w
    const tabs = w.findAll('.session-tab')
    expect(tabs.map(t => t.text())).toEqual(['default', 'alpha', 'backlot2'])
    expect(tabs.map(t => t.attributes('aria-selected'))).toEqual(['true', 'false', 'false'])
    expect(w.text()).not.toContain('empty')
    expect(w.find('.session-waiting .state-square').exists()).toBe(true)
  })

  it('persists the picked session on this device', async () => {
    allSessionsState.value = state()
    const w = await mountSuspended(SessionTabs)
    mounted = w
    await w.findAll('.session-tab')[2]!.trigger('click')
    expect(localStorage.getItem('sessionTab')).toBe('sbbbbbbbbbbbbbbbb')
    expect(w.findAll('.session-tab')[2]!.attributes('aria-selected')).toBe('true')
  })
})
