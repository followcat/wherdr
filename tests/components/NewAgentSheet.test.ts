import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import NewAgentSheet from '~/components/NewAgentSheet.vue'
import { newAgentOpen } from '~/composables/useUi'
import { herdrState } from '~/composables/useHerdr'
import { newTabSpace } from '~/composables/useSpaces'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

registerEndpoint('/api/config', () => ({ kinds: ['claude', 'codex'], home: '/repos', dirs: ['/repos'], push: { enabled: false, key: null, devices: 0 } }))
const created: Record<string, unknown>[] = []
registerEndpoint('/api/agents', async (event) => {
  const { readBody } = await import('h3')
  created.push(await readBody(event as never))
  return { pane_id: 'w1:p9' }
})

const stubs = { AppSheet: { template: '<section><slot /><slot name="footer" /></section>' } }
afterEach(() => { newAgentOpen.value = false; created.length = 0; navigate.mockClear(); herdrState.value = { ok: false, workspaces: [], panes: [] } })

it('starts a new tab in its space, in the folder of that space, then opens it', async () => {
  herdrState.value = { ok: true, workspaces: [{ id: 'w1', label: 'api', number: 1, status: null, worktree: false }], panes: [{ id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'idle', title: null, cwd: '/repos/api', agentSession: null }] }
  const w = await mountSuspended(NewAgentSheet, { global: { stubs } })
  newTabSpace.value = 'w1'
  newAgentOpen.value = true
  await flushPromises()
  expect(w.text()).toContain('New tab')
  expect(w.find('[data-kind="project"]').exists()).toBe(false)
  await w.get('.launch-btn').trigger('click')
  await vi.waitFor(() => expect(created).toHaveLength(1))
  expect(created[0]).toMatchObject({ kind: 'claude', cwd: '/repos/api', workspace: 'w1' })
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w1%3Ap9'))
  w.unmount()
})
