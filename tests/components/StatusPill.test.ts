import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import StatusPill from '~/components/StatusPill.vue'
import type { Pane } from '#shared/types'

// The pane's model on the status line (AgentView / PlanCell pass `model`):
// shown only with the prop, never inferred from the pane alone.
const pane = (o: Partial<Pane> = {}): Pane => ({
  id: 'w1:p1', workspace: 'w1', tab: 't1', tabLabel: null,
  agent: 'claude', name: 'agent', label: null, status: 'idle',
  title: '', cwd: '/tmp', agentSession: null,
  model: { id: null, label: 'Opus 5.5', effort: 'high', at: null }, ...o,
})

describe('StatusPill model', () => {
  it('shows the pane model and effort when `model` is on', async () => {
    const w = await mountSuspended(StatusPill, { props: { pane: pane(), kind: true, model: true } })
    expect(w.get('.pill').text()).toContain('claude')
    expect(w.get('.pill-model').text()).toBe('Opus 5.5')
    expect(w.get('.pill-effort').text()).toBe('high')
  })
  it('hides the model without the prop or without an effort', async () => {
    const off = await mountSuspended(StatusPill, { props: { pane: pane() } })
    expect(off.find('.pill-model').exists()).toBe(false)
    const flat = await mountSuspended(StatusPill, { props: { pane: pane({ model: { id: null, label: 'Sonnet 5', at: null } }), model: true } })
    expect(flat.get('.pill-model').text()).toBe('Sonnet 5')
    expect(flat.find('.pill-effort').exists()).toBe(false)
  })
})
