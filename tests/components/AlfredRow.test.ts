// WHR-403: Alfred's row at the top of the agent list: not started (the first
// tap asks for its agent), running (its agent shown), renamed (identity.md's name).
// WHR-119: its own card (emblem, what it is, its state square).
// WHR-265: the card has the mauve edge only while its conversation is open; its wash always.
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { nextTick } from 'vue'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import AlfredRow from '~/components/AlfredRow.vue'
import { agentOrder, appConfig, coarse, curPane, desk, herdrState, hiddenAgents } from '~/composables/useHerdr'
import { menuState } from '~/composables/useUi'
import { loadAlfred } from '~/composables/useCoordinators'
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
afterEach(() => { w?.unmount(); w = null; posts.length = 0; hiddenAgents.value = []; agentOrder.value = []; navigate.mockReset(); document.body.innerHTML = ''; document.documentElement.style.cssText = '' })
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
  expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('Not started')
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
  await vi.waitFor(() => expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('Not started · Claude'))
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: MAIN, program: 'claude' }]))
})

it('as the board\'s All projects banner: the same one tap, no menu', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  view = { name: 'Alfred', program: 'claude' }
  await mount({ banner: true })
  await vi.waitFor(() => expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('All projects · Not started · Claude'))
  expect(w!.findComponent({ name: 'UContextMenu' }).props('disabled')).toBe(true)
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(posts).toEqual([{ project: MAIN, program: 'claude' }]))
})

it('running and renamed: its name, its current agent, one tap opens the conversation', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  view = { name: 'Jeeves', program: 'claude', ran: 'claude', terminal: 'host/t1' }
  await mount()
  expect(w!.find('[data-testid="alfred"]').classes()).toContain('on')
  expect(w!.find('[data-testid="alfred-sub"]').text()).toBe('Ready · Claude')
  await w!.find('[data-testid="alfred-open"]').trigger('click')
  await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/a/w%3Ap1'))
  expect(posts).toEqual([])
  // Its conversation open: selected like an agent card; another one opened: not any more.
  const open = w!.find('[data-testid="alfred-open"]')
  expect(open.attributes('aria-current')).toBeUndefined()
  // Its card's look (scoped CSS loaded, see vitest.config.ts): the neutral edge of
  // other cards unless its conversation is open, then the mauve edge; its wash always.
  document.documentElement.style.cssText = '--line:#111111;--surface:#222222;--mauve:#cc88ff'
  const look = () => {
    const s = getComputedStyle(w!.find('.alfred-card').element)
    return { edge: s.borderTopColor, wash: s.backgroundImage.includes('gradient') }
  }
  const plain = { edge: '#111111', wash: true }
  expect(look()).toEqual(plain)
  curPane.value = 'w:p1'
  await nextTick()
  expect(w!.find('[data-testid="alfred"]').classes()).toContain('sel')
  // (happy-dom does not compute color-mix(), so the mauve edge is not checked here)
  expect(look().wash).toBe(true)
  // Nothing paints over the wash when selected (happy-dom computes no inner background: read the rules).
  expect(readFileSync('app/components/AlfredRow.vue', 'utf8')).not.toMatch(/\.alfred(-card)?\.sel \{[^}]*background/)
  expect(open.attributes('aria-current')).toBe('page')
  curPane.value = 'w:p2'
  await nextTick()
  expect(w!.find('[data-testid="alfred"]').classes()).not.toContain('sel')
  expect(look()).toEqual(plain)
  expect(open.attributes('aria-current')).toBeUndefined()
  curPane.value = null
  // Renamed during a turn: the new name shows as soon as the turn ends, not at the next poll.
  herdrState.value = { ok: true, workspaces: [], panes: [{ ...pane('w:p1', 'host/t1'), status: 'working' }] }
  await nextTick()
  view = { ...view, name: 'Bunter' }
  herdrState.value = { ok: true, workspaces: [], panes: [{ ...pane('w:p1', 'host/t1'), status: 'done' }] }
  await vi.waitFor(() => expect(w!.find('[data-testid="alfred-name"]').text()).toBe('Bunter'))
})

it('its card: the emblem, what it is, and its state as a square (not started, ready, working)', async () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  view = { name: 'Alfred', program: 'claude' }
  await mount()
  const sub = () => w!.find('[data-testid="alfred-sub"]')
  expect(w!.find('[data-testid="alfred-emblem"]').exists()).toBe(true)
  expect(w!.text()).toContain('Your assistant · all projects')
  // No Ask field under it (WHR-183): a tap on the row opens its conversation.
  expect(w!.find('input').exists()).toBe(false)
  await vi.waitFor(() => expect(sub().text()).toBe('Not started · Claude'))
  expect(sub().classes()).toContain('inactive')
  view = { ...view, ran: 'claude', terminal: 'host/t1' }
  herdrState.value = { ok: true, workspaces: [], panes: [pane('w:p1', 'host/t1')] }
  await loadAlfred()
  await vi.waitFor(() => expect(sub().text()).toBe('Ready · Claude'))
  expect(sub().classes()).toContain('idle')
  expect(w!.find('.alfred-go').exists()).toBe(true)
  herdrState.value = { ok: true, workspaces: [], panes: [{ ...pane('w:p1', 'host/t1'), status: 'working' }] }
  await vi.waitFor(() => expect(sub().text()).toBe('Working · Claude'))
  expect(sub().classes()).toContain('working')
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
