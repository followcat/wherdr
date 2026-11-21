import { afterEach, beforeAll, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AgentCard from '~/components/AgentCard.vue'
import PhoneIdentity from '~/components/PhoneIdentity.vue'
import { desk, herdrState } from '~/composables/useHerdr'
import { currentPaneItems, paneItems, splitAgentPane } from '~/composables/useSpaces'
import { newAgentOpen } from '~/composables/useUi'
import type { Pane } from '#shared/types'

// herdr-core has no move or swap: the pane menus must not offer them (Split right and
// Split down, a shell in wherdr's own layout of the tab, are offered by the plan's pane menu).
const ws = { id: 'w1', label: 'api', number: 1, status: null, worktree: false }
const pane: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'claude', name: 'build', label: null, status: 'idle', title: '', cwd: '/', agentSession: null }
const second: Pane = { ...pane, id: 'w1:p2', name: 'tests' }
const rect = (x: number) => ({ x, y: 0, width: 40, height: 20 })
const layout = { tab: 'w1:t1', workspace: 'w1', zoomed: false, focused: 'w1:p1', area: { x: 0, y: 0, width: 80, height: 20 }, panes: [{ pane: 'w1:p1', rect: rect(0) }, { pane: 'w1:p2', rect: rect(40) }] }
const state = () => ({ ok: true, panes: [pane, second], workspaces: [ws], tabs: [{ id: 'w1:t1', workspace: 'w1', label: 'main', number: 1, layout }] }) as never
const LAYOUT = /^(Move to…|Swap with)/

let cfg: { core?: boolean }
let was: boolean | undefined
beforeAll(() => { cfg = useRuntimeConfig().public as { core?: boolean }; was = cfg.core })
afterEach(() => {
  cfg.core = was
  desk.value = false
  herdrState.value = { ok: false, panes: [], workspaces: [] }
})
const labels = (items: { label?: string }[]) => items.map(i => i.label ?? '')

it('core mode: no move or swap entry in the pane menus; rename and close stay', () => {
  herdrState.value = state()
  cfg.core = true
  for (const items of [currentPaneItems(pane), paneItems(pane)]) {
    const l = labels(items)
    expect(l.filter(x => LAYOUT.test(x))).toEqual([])
    expect(l).toContain('Rename pane')
    expect(l.some(x => /^Close/.test(x))).toBe(true)
  }
  expect(labels(paneItems(pane))).toEqual(expect.arrayContaining(['Split right', 'Split down', 'Split with agent…']))
})

it('Split with agent… opens the New agent sheet on that pane', () => {
  herdrState.value = state()
  const item = paneItems(pane).find(i => i.label === 'Split with agent…') as { run: () => void }
  item.run()
  try {
    expect(splitAgentPane.value?.id).toBe('w1:p1')
    expect(newAgentOpen.value).toBe(true)
  } finally { newAgentOpen.value = false; splitAgentPane.value = null }
})

it('core mode: the phone "Panes and tabs" sheet has no move or swap', async () => {
  cfg.core = true
  herdrState.value = state()
  const w = await mountSuspended(PhoneIdentity, { props: { pane, workspace: ws }, attachTo: document.body })
  try {
    await w.find('.phone-identity').trigger('click')
    await new Promise(r => setTimeout(r, 0))
    const items = [...document.querySelectorAll('.phone-identity-details .menu > *')].map(el => el.textContent!.trim())
    expect(items).toContain('Rename pane')
    expect(items.filter(x => LAYOUT.test(x))).toEqual([])
  } finally { w.unmount() }
})

it('core mode: the home card right-click menu has no move or swap', async () => {
  cfg.core = true
  desk.value = true
  herdrState.value = state()
  const w = await mountSuspended(AgentCard, { props: { pane } })
  try {
    await nextTick()
    const items = w.findComponent({ name: 'UContextMenu' }).props('items').flat() as { label?: string }[]
    expect(items.some(i => /^Close this pane/.test(i.label ?? ''))).toBe(true)
    expect(labels(items).filter(x => LAYOUT.test(x))).toEqual([])
  } finally { w.unmount() }
})
