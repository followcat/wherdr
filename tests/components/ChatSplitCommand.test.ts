import { afterEach, describe, expect, it, vi } from 'vitest'
import { createError, readBody } from 'h3'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ChatView from '~/components/ChatView.vue'
import { desk, herdrState } from '~/composables/useHerdr'
import { menuState } from '~/composables/useUi'
import { panePath } from '~/composables/useWorkspaces'
import type { Pane } from '#shared/types'

const { toasts, navigate } = vi.hoisted(() => ({ toasts: [] as Array<[string, boolean]>, navigate: vi.fn() }))
mockNuxtImport('toast', () => (msg: string, err = false) => { toasts.push([msg, err]) })
mockNuxtImport('navigateTo', () => navigate)

const pane: Pane = { id: 'ab12~w1:p1', machine: 'ab12', workspace: 'ab12~w1', tab: 'ab12~w1:t1', tabLabel: null, agent: 'claude', name: null, label: null, status: 'working', title: null, cwd: '/project', agentSession: null }
const calls: unknown[] = []
// What the server answers: reuse of a free split, a new split (none, or the
// existing one was busy), or a refusal when no idle prompt could be verified.
let reply: { created: boolean } | 'refused' = { created: false }
registerEndpoint('/api/chat', () => ({ available: true, token: 'split-command', file: '/project/chat.jsonl', items: [{ role: 'assistant', text: 'Try `! gcloud auth login`.', ts: null }] }))
registerEndpoint('/api/split-command', { method: 'POST', handler: async event => {
  calls.push(await readBody(event))
  if (reply === 'refused') throw createError({ statusCode: 409, data: { code: 'busy_pane', error: 'Cannot verify an idle shell prompt. No command was sent.' }, statusMessage: 'Cannot verify an idle shell prompt. No command was sent.' })
  return { ok: true, pane_id: reply.created ? 'ab12~w1:p3' : 'ab12~w1:p2', created: reply.created }
} })

async function runFromMenu(beforeRun?: () => void) {
  const w = await mountSuspended(ChatView, { props: { pane, localQueued: [] } })
  await expect.poll(() => w.find('.md-cmd').exists()).toBe(true)
  await w.find('.md-cmd').trigger('click')
  expect(menuState.items.map(i => i.label)).toContain('Run in split terminal')
  expect(calls).toHaveLength(0)
  beforeRun?.()
  await menuState.items.find(i => i.label === 'Run in split terminal')!.run!()
  return w
}

describe('chat command split terminal menu', () => {
  afterEach(() => { calls.length = 0; toasts.length = 0; navigate.mockReset(); reply = { created: false }; menuState.open = false; menuState.items = []; herdrState.value = { ok: false, workspaces: [], panes: [] } })

  it.each([
    ['a free split is reused', false, 'Command sent to split terminal', 'ab12~w1:p2'],
    ['no free split (none, or busy) opens a new one', true, 'Command sent to a new split terminal', 'ab12~w1:p3'],
  ])('%s, then shows that terminal', async (_name, created, message, target) => {
    // Shell selection and readiness belong to the server; the component must
    // never send text through the agent or guess readiness from its cache.
    reply = { created }
    desk.value = false
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await runFromMenu()
    try {
      expect(calls).toEqual([{ pane_id: pane.id, command: 'gcloud auth login' }])
      expect(w.emitted('sent')).toBeUndefined()
      expect(toasts).toEqual([[message, false]])
      expect(navigate).toHaveBeenCalledWith(panePath(target))
    } finally { w.unmount() }
  })

  it('opens the split inside the agent tab on desktop', async () => {
    // The desktop dropdown is covered by the e2e spec; here the menu opens as
    // on a phone and the click lands once the layout is the desktop one.
    reply = { created: true }
    desk.value = false
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await runFromMenu(() => { desk.value = true })
    try {
      expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ query: { pane: 'ab12~w1:p3' } }))
    } finally { w.unmount(); desk.value = false }
  })

  it('reports a refusal and stays on the chat', async () => {
    reply = 'refused'
    desk.value = false
    herdrState.value = { ok: true, workspaces: [], panes: [pane] }
    const w = await runFromMenu()
    try {
      expect(calls).toHaveLength(1)
      expect(toasts).toHaveLength(1)
      expect(toasts[0]![1]).toBe(true)
      expect(navigate).not.toHaveBeenCalled()
    } finally { w.unmount() }
  })
})
