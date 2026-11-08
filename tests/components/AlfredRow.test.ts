// WHR-403: Alfred's row at the top of the agent list: not started (the first
// tap asks for its agent), running (its agent shown), renamed (identity.md's name).
import { afterEach, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import AlfredRow from '~/components/AlfredRow.vue'
import { agentOrder, appConfig, coarse, curPane, desk, herdrState, hiddenAgents } from '~/composables/useHerdr'
import { menuState } from '~/composables/useUi'
import { MAIN } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)

const posts: unknown[] = []
let view: Record<string, unknown> = {}
registerEndpoint('/api/alfred', () => view)
registerEndpoint('/api/pm/coordinators', () => [])
registerEndpoint('/api/pm/coordinator-start', { method: 'POST', handler: async (e) => { posts.push(await readBody(e)); return { terminal: 'host/t9' } } })

const pane = (id: string, coreAddress: string) => ({ id, coreAddress, status: 'idle', agent: 'claude', workspace: 'w', tab: 't' }) as Pane
let w: Awaited<ReturnType<typeof mountSuspended>> | null = null
afterEach(() => { w?.unmount(); w = null; posts.length = 0; hiddenAgents.value = []; agentOrder.value = []; navigate.mockReset(); document.body.innerHTML = '' })
const mount = async (props: { banner?: boolean } = {}) => {
  w = await mountSuspended(AlfredRow, { attachTo: document.body, props })
  await vi.waitFor(() => expect(w!.find('[data-testid="alfred-name"]').text()).toBe(String(view.name)))
  return w
}

it('not started, no agent yet: a greyed row, and the first tap asks which offered program (Settings › Agents), then starts it', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  // Gemini unchecked, Codex first; Cline cannot carry Alfred.
  appConfig.value = { ...appConfig.value, kinds: ['claude', 'gemini', 'cline', 'codex'] }
  hiddenAgents.value = ['gemini']
  agentOrder.value = ['codex']
  view = { name: 'Alfred' }
  await mount()
  expect(w!.find('[data-testid="alfred"]').classes()).not.toContain('on')
  expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('not started')
  expect(w!.find('[data-testid="alfred-open"]').text()).toContain('Start')
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(document.querySelector('[data-testid="alfred-sheet"]')).not.toBeNull())
  expect(posts).toEqual([])
  // One tile per offered program, in the user's order, no models; the first picked.
  expect([...document.querySelectorAll('[data-agent]')].map(b => b.textContent!.trim())).toEqual(['Codex', 'Claude'])
  expect(document.querySelector('[data-agent="codex"]')!.getAttribute('aria-checked')).toBe('true')
  ;(document.querySelector('[data-agent="claude"]') as HTMLElement).click()
  await nextTick()
  ;(document.querySelector('[data-testid="alfred-start"]') as HTMLElement).click()
  await vi.waitFor(() => expect(posts).toEqual([{ project: MAIN, program: 'claude' }]))
})

it('not started with a remembered agent: one tap starts it with that agent', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  view = { name: 'Alfred', program: 'claude' }
  await mount()
  await vi.waitFor(() => expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('not started · Claude'))
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: MAIN, program: 'claude' }]))
})

it('as the board\'s All projects banner: the same one tap, no menu', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  view = { name: 'Alfred', program: 'claude' }
  await mount({ banner: true })
  await vi.waitFor(() => expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('All projects · not started · Claude'))
  expect(w!.findComponent({ name: 'UContextMenu' }).props('disabled')).toBe(true)
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: MAIN, program: 'claude' }]))
})

it('running and renamed: its name, its current agent, one tap opens the conversation', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  view = { name: 'Jeeves', program: 'claude', ran: 'claude', terminal: 'host/t1' }
  await mount()
  expect(w!.find('[data-testid="alfred"]').classes()).toContain('on')
  expect(w!.find('[data-testid="alfred-sub"]').text()).toMatch(/^Claude · /)
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w%3Ap1'))
  expect(posts).toEqual([])
  // Its conversation open: selected like an agent card; another one opened: not any more.
  const open = w!.find('[data-testid="alfred-open"]')
  expect(open.attributes('aria-current')).toBeUndefined()
  curPane.value = 'w:p1'
  await nextTick()
  expect(w!.find('[data-testid="alfred"]').classes()).toContain('sel')
  expect(open.attributes('aria-current')).toBe('page')
  curPane.value = 'w:p2'
  await nextTick()
  expect(w!.find('[data-testid="alfred"]').classes()).not.toContain('sel')
  expect(open.attributes('aria-current')).toBeUndefined()
  curPane.value = null
})

it('no ••• button: right click (computer) and long press (touch) open its menu, Restart with… asks for the agent', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  appConfig.value = { ...appConfig.value, kinds: ['claude', 'codex'] }
  view = { name: 'Alfred', program: 'claude', ran: 'claude', terminal: 'host/t1' }
  try {
    desk.value = true
    coarse.value = false
    await mount()
    expect(w!.find('button[aria-label*="Options"]').exists()).toBe(false)
    expect(w!.findComponent({ name: 'UContextMenu' }).props('items').flat().map((i: { label: string }) => i.label)).toEqual(['Restart with…'])
    w!.unmount()
    desk.value = false
    coarse.value = true
    await mount()
    const row = w!.find('[data-testid="alfred"]')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await row.trigger('pointerdown', { pointerType: 'touch', button: 0, clientX: 0, clientY: 0 })
      vi.advanceTimersByTime(720)
      await row.trigger('pointerup')
      await w!.find('[data-testid="alfred-open"]').trigger('click')
    } finally { vi.useRealTimers() }
    // The lifted finger does not open the conversation.
    expect(navigate).not.toHaveBeenCalled()
    expect(menuState.open).toBe(true)
    expect(menuState.items.map(i => i.label)).toEqual(['Restart with…'])
    menuState.items[0]!.run!()
    await vi.waitFor(() => expect(document.querySelector('[data-testid="alfred-sheet"]')).not.toBeNull())
    ;(document.querySelector('[data-agent="codex"]') as HTMLElement).click()
    await nextTick()
    ;(document.querySelector('[data-testid="alfred-start"]') as HTMLElement).click()
    await vi.waitFor(() => expect(posts).toEqual([{ project: MAIN, program: 'codex' }]))
  } finally { desk.value = false; coarse.value = false; menuState.open = false }
})
