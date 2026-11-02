import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { activeTab } from '../server/utils/settingstabs'
import { HerdrError } from '../server/utils/herdr'
import { settingsFocus, settingsTabs, tabsOfRow } from '../shared/settingsScreen'

const fx = (name: string, width = 80) => readFileSync(`tests/baselines/claude-config/${name.replace('{w}', String(width))}.ansi`, 'utf8')
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[\d;]*m|\r/g, '')
afterEach(() => vi.unstubAllGlobals())

async function navigate(initial: string, target: string, frames: Record<string, string[]> = {}, lag = 0) {
  let screen = initial, pending = '', reads = 0
  const keys: string[] = []
  const herdr = vi.fn(async (method: string, params: any) => {
    if (method === 'pane.send_input') {
      const key = params.keys[0]
      keys.push(key)
      const next = frames[key]?.shift()
      if (next) { pending = next; reads = lag }
      return {}
    }
    expect(params).toEqual({ pane_id: 'w1:p1', source: 'visible', format: 'ansi' })
    if (pending && reads-- <= 0) { screen = pending; pending = '' }
    return { read: { text: screen } }
  })
  for (const [k, v] of Object.entries({ defineApi: (h: unknown) => h, PANE_RE: /^w1:p1$/, HerdrError,
    findPane: () => ({ agent: 'claude' }), herdr, activeTab, sleep: async () => {}, choicesCache: { delete: vi.fn() } })) vi.stubGlobal(k, v)
  const handler = (await import('../server/api/settings-tab.post')).default
  return { keys, run: () => handler({}, { pane_id: 'w1:p1', target }) }
}

describe.each([80, 120])('real Claude Code 2.1.296 at %i columns', width => {
  const screen = (name: string) => fx(name, width)
  it('identifies every active tab and the persistent row cursor', () => {
    for (const [name, tab] of [['config-{w}-open', 'Config'], ['config-{w}-tabs', 'Config'], ['status-{w}', 'Status'], ['usage-{w}', 'Usage'], ['stats-{w}', 'Stats'], ['usage-{w}-direct', 'Usage']]) {
      const raw = screen(name!)
      expect(settingsTabs(plain(raw))).toEqual(['Status', 'Config', 'Usage', 'Stats'])
      expect(activeTab(raw.split('\n').find(l => tabsOfRow(plain(l)))!)).toBe(tab)
    }
    expect(plain(screen('config-{w}-tabs'))).toContain('❯ Auto-compact')
    expect(settingsFocus(plain(screen('config-{w}-tabs')))).toBe('tabs')
    expect(settingsFocus(plain(screen('config-{w}-open')))).toBe('filter')
    expect(settingsFocus(plain(screen('config-{w}-middle')))).toBe('list')
    expect(settingsFocus(plain(screen('config-{w}-disabled')))).toBe('list')
    expect(settingsFocus('←/→/tab to switch · ↓ to return · Esc to close\n' + plain(screen('config-{w}-open')))).toBe('filter')
  })
  it.each(['Status', 'Usage', 'Stats'])('switches from the filter to %s without touching a setting', async target => {
    const n = await navigate(screen('config-{w}-open'), target, {
      up: [screen('config-{w}-tabs')], left: [screen('status-{w}')], right: [screen('usage-{w}'), screen('stats-{w}')],
    }, 2)
    await expect(n.run()).resolves.toEqual({ ok: true, tab: target })
    expect(n.keys).toEqual(target === 'Status' ? ['up', 'left'] : target === 'Usage' ? ['up', 'right'] : ['up', 'right', 'right'])
  })
  it('moves up from a scrolled list and stops as soon as tabs have focus', async () => {
    const n = await navigate(screen('config-{w}-bottom'), 'Usage', {
      up: [screen('config-{w}-bottom-up'), screen('config-{w}-middle'), screen('config-{w}-disabled'), screen('config-{w}-open'), screen('config-{w}-tabs')],
      right: [screen('usage-{w}')],
    })
    await n.run()
    expect(n.keys).toEqual(['up', 'up', 'up', 'up', 'up', 'right'])
  })
  it('crosses Config from Status to Stats and checks focus again', async () => {
    const n = await navigate(screen('status-{w}'), 'Stats', {
      right: [screen('config-{w}-returned'), screen('usage-{w}'), screen('stats-{w}')],
    })
    await n.run()
    expect(n.keys).toEqual(['right', 'right', 'right'])
  })
  // Every source and destination with the real tab frames (formerly an e2e loop).
  const order = ['Status', 'Config', 'Usage', 'Stats']
  const frameOf: Record<string, string> = { Status: 'status-{w}', Config: 'config-{w}-returned', Usage: 'usage-{w}', Stats: 'stats-{w}' }
  it.each(order.flatMap(from => order.map(target => [from, target])))('goes from %s to %s with arrows only', async (from, target) => {
    const i = order.indexOf(from!), j = order.indexOf(target!)
    const dir = j > i ? 'right' : 'left'
    const passed = (j > i ? order.slice(i + 1, j + 1) : order.slice(j, i).reverse()).map(tab => screen(frameOf[tab]!))
    const n = await navigate(screen(frameOf[from!]!), target!, { [dir]: passed })
    await expect(n.run()).resolves.toEqual({ ok: true, tab: target })
    expect(n.keys).toEqual(Array(Math.abs(j - i)).fill(dir))
  })
  it('does nothing when the requested tab is already active', async () => {
    const n = await navigate(screen('config-{w}-bottom'), 'Config')
    await n.run()
    expect(n.keys).toEqual([])
  })
  it('fails explicitly when the arrow does not change the tab', async () => {
    const n = await navigate(screen('config-{w}-tabs'), 'Usage')
    await expect(n.run()).rejects.toThrow('Could not switch settings tabs.')
    expect(n.keys).toEqual(['right'])
  })
  it('refuses unknown Config focus without sending keys', async () => {
    const raw = screen('config-{w}-open').replace('↑ to tabs', 'unknown')
    const n = await navigate(raw, 'Usage')
    await expect(n.run()).rejects.toThrow('Use the terminal')
    expect(n.keys).toEqual([])
  })
  it('fails on a screen change before sending a horizontal key', async () => {
    const n = await navigate(screen('config-{w}-open'), 'Usage', { up: ['❯ Ready for input'] })
    await expect(n.run()).rejects.toThrow('Settings have changed.')
    expect(n.keys).toEqual(['up'])
  })
  it('bounds a stuck list without sending horizontal or activation keys', async () => {
    const n = await navigate(screen('config-{w}-bottom'), 'Usage')
    await expect(n.run()).rejects.toThrow('Use the terminal')
    expect(n.keys).toEqual(['up'])
  })
})

// Exercise the actual client functions: a stale follow-up screen must not
// silently paint Config as though a Usage click had succeeded.
import { bindFunction } from './stateFunction'
const clientSource = readFileSync('app/composables/useUi.ts', 'utf8')
it('reports a mismatched follow-up screen instead of silently returning to Config', async () => {
  const commandResult = { open: true, pane: 'w1:p1', cmd: '/config', text: null, tab: 'Config' }
  const read = bindFunction(clientSource, 'readCommandResult', {
    resultSeq: 1, commandResult, t: (s: string) => s,
    api: async () => ({ text: plain(fx('config-80-open')), tabs: ['Status', 'Config', 'Usage', 'Stats'], tab: 'Config' }),
  })
  await read('w1:p1', '/config', 1, 1, 'Usage')
  expect(commandResult.text).toContain('Could not switch settings tabs.')
  expect(commandResult.open).toBe(true)
})
it('keeps the confirmed tab on failure and permits retrying the displayed tab', async () => {
  const commandResult = { open: true, pane: 'w1:p1', cmd: '/config', text: 'Config', tabs: ['Status', 'Config', 'Usage', 'Stats'], tab: 'Config' }
  const api = vi.fn(async () => { throw new Error('Settings have changed.') })
  const switchTab = bindFunction(clientSource.replace('export async function switchCommandTab', 'async function switchCommandTab'), 'switchCommandTab', { resultSeq: 1, commandResult, api })
  await switchTab('Usage')
  expect(commandResult.tab).toBe('Config')
  expect(commandResult.text).toBe('Settings have changed.')
  await switchTab('Config')
  expect(api).toHaveBeenCalledTimes(2)
})
