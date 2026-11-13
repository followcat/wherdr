// coreModelctl on fake deps: every terminal.* call is recorded; screens come
// from fixtures. The gate, the busy lock, menu cleanup and each list path —
// never a real agent.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCoreModelCtl, parseCmdModels, type CoreModelCtlDeps } from '../server/utils/coreModelctl'
import type { Pane } from '../shared/types'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
const idle = fx('claude-idle.txt')
const menu1 = fx('claude-model-1.txt')
const menu2 = fx('claude-model-2.txt')
const ask = fx('claude-ask.txt')

type Op = { method: string, params: any }
function make(over: Partial<CoreModelCtlDeps> & { screens?: (string | (() => string | Promise<string>))[] } = {}) {
  const ops: Op[] = []
  let i = 0
  const screens = over.screens ?? [idle]
  const pane: Pane = { id: 'h1', agent: 'claude', status: 'idle', coreAddress: 't:1', machine: '' } as Pane
  const noted: { pane: string, agent: string, list: any }[] = []
  const deps: CoreModelCtlDeps = {
    call: async (method: string, params: object) => {
      ops.push({ method, params })
      if (method === 'terminal.read') {
        const s = screens[Math.min(i++, screens.length - 1)]
        return { text: typeof s === 'function' ? await s() : s }
      }
      return {}
    },
    pane: id => (id === 'h1' ? pane : undefined),
    machine: async () => ({ local: true, home: '/home/user', label: 'host-a', exec: null }) as any,
    execLocal: async () => ({ code: 0, stdout: Buffer.from('acme/alpha  Alpha one\nacme/beta   Beta two (default)\nDecision models\nx'), stderr: '' }),
    transcript: async () => ({ id: 'acme/beta', label: 'Beta two', at: '2026-01-01T00:00:00Z' }),
    currentModel: async () => null,
    opencodeModels: async () => [
      { id: 'm1', providerID: 'acme', name: 'Alpha', enabled: true },
      { id: 'm2', providerID: 'acme', name: 'Beta', enabled: true },
      { id: 'm3', providerID: 'globex', name: 'Beta', enabled: true },
      { id: 'm4', providerID: 'acme', name: 'Off', enabled: false },
    ],
    noteList: (p, agent, list) => { noted.push({ pane: `${p.machine}|${agent}`, agent, list }) },
    sleep: async () => {},
    now: () => 1000,
    ...over,
  }
  return { ctl: createCoreModelCtl(deps), ops, noted, pane, deps }
}
const sends = (ops: Op[]) => ops.filter(o => o.method === 'terminal.send')
const keys = (ops: Op[]) => ops.filter(o => o.method === 'terminal.keys')
const reads = (ops: Op[]) => ops.filter(o => o.method === 'terminal.read')

describe('gate (TOCTOU)', () => {
  it('a native prompt appearing after the initial gate: zero sends', async () => {
    // Gate read #1 sees the idle input; the sendInput re-gate sees a prompt.
    const { ctl, ops } = make({ screens: [idle, ask] })
    await expect(ctl.listModels('h1')).rejects.toThrow(/waiting for an answer|did not show up|changed/i)
    expect(sends(ops)).toHaveLength(0)
  })
  it('refuses panes outside the supported set and non-input screens', async () => {
    const { ctl } = make({ screens: [idle] })
    await expect(ctl.listModels('nope')).rejects.toThrow(/Pane not found/)
    const { ctl: c2, ops: o2 } = make({ screens: [ask] })
    await expect(c2.listModels('h1')).rejects.toThrow(/waiting for an answer/)
    expect(sends(o2)).toHaveLength(0)
  })
})

describe('menu lifecycle', () => {
  it('closes the menu in finally when a read fails mid-scan', async () => {
    const gone = () => { throw new Error('read gone') }
    // gate, sendInput gate, menu shown — then the scan's next read dies.
    // closeMenu still runs: it sees the menu and sends esc.
    const { ctl, ops } = make({ screens: [idle, idle, menu1, gone, menu1, idle] })
    await expect(ctl.listModels('h1')).rejects.toThrow('read gone')
    expect(keys(ops).some(o => o.params.keys.includes('esc'))).toBe(true)
  })
  it('a second operation on the same pane is refused while one runs', async () => {
    let release: (() => void) | null = null
    let held = true
    const slow = () => held ? new Promise<string>(r => { release = () => { held = false; r(menu1) } }) : menu1
    const { ctl } = make({ screens: [idle, idle, menu1, slow] })
    const first = ctl.listModels('h1')
    await new Promise(r => setTimeout(r, 10))
    await expect(ctl.listModels('h1')).rejects.toThrow(/already running/)
    release?.()
    await first.catch(() => {})
  })
})

describe('listModels dispatch', () => {
  it('claude: gated /model menu read, all pages, esc at the end', async () => {
    const { ctl, ops, noted } = make({ screens: [idle, idle, menu1, menu1, menu2, menu2, menu2, menu2, idle] })
    const list = await ctl.listModels('h1')
    expect(list.agent).toBe('claude')
    expect(list.options.map(o => o.label)).toContain('Opus 5.5')
    expect(sends(ops).map(o => o.params.text)).toEqual(['/model'])
    expect(keys(ops).some(o => o.params.keys.includes('esc'))).toBe(true)
    expect(noted[0]!.pane).toBe('|claude') // `${machine}|${agent}` — local machine key is ''
    expect(noted[0]!.list).toBe(list)
  })
  it('omp: gated alt+p selector read', async () => {
    const sel = fx('omp-selector.txt')
    const { ctl, ops, noted, pane } = make({ screens: [idle, idle, sel, sel, idle] })
    pane.agent = 'omp'
    const list = await ctl.listModels('h1')
    expect(list.agent).toBe('omp')
    expect(list.options.length).toBeGreaterThan(0)
    expect(keys(ops)[0]!.params.keys).toEqual(['alt+p'])
    expect(sends(ops)).toHaveLength(0)
    expect(noted[0]!.pane).toBe('|omp')
  })
  it('omp narrow selector: refused, selector closed, no list', async () => {
    const narrow = fx('omp-selector-narrow-nerd.txt')
    const { ctl, ops, noted, pane } = make({ screens: [idle, idle, narrow, narrow, idle] })
    pane.agent = 'omp'
    await expect(ctl.listModels('h1')).rejects.toThrow(/too narrow/i)
    expect(keys(ops).some(o => o.params.keys.includes('esc'))).toBe(true)
    expect(noted).toHaveLength(0)
  })
  it('devin: gated /model menu read', async () => {
    const dm = fx('devin-menu.txt')
    const didle = fx('devin-idle.txt')
    const { ctl, ops, noted, pane } = make({ screens: [didle, didle, didle, dm, dm, dm, dm, dm, dm, dm, dm, dm, dm, dm, didle] })
    pane.agent = 'devin'
    const list = await ctl.listModels('h1')
    expect(list.agent).toBe('devin')
    expect(list.options.length).toBeGreaterThan(0)
    expect(sends(ops).map(o => o.params.text)).toEqual(['/model'])
    expect(noted[0]!.pane).toBe('|devin')
  })
  it('opencode: service read — zero terminal IO, still under busy', async () => {
    const { ctl, ops, noted, pane } = make({})
    pane.agent = 'opencode'
    const list = await ctl.listModels('h1')
    expect(list.options.map(o => o.label)).toEqual(['Alpha', 'Beta (acme)', 'Beta (globex)'])
    expect(list.options[0]!.hint).toBe('acme/m1')
    expect(ops).toHaveLength(0) // no terminal.read/keys/send at all
    expect(noted[0]!.pane).toBe('|opencode')
  })
  it('cmd: exec + parseCmdModels — zero terminal IO', async () => {
    const { ctl, ops, noted, pane } = make({})
    pane.agent = 'cmd'
    const list = await ctl.listModels('h1')
    expect(list.options.map(o => o.label)).toEqual(['acme/alpha', 'acme/beta'])
    expect(list.options[1]).toMatchObject({ current: true, isDefault: true })
    expect(ops).toHaveLength(0)
    expect(noted[0]!.pane).toBe('|cmd')
  })
  it('cmd: CLI missing → no_cli', async () => {
    const { ctl, pane } = make({ execLocal: async () => ({ code: 127, stdout: Buffer.from(''), stderr: 'cmd CLI not found' }) })
    pane.agent = 'cmd'
    await expect(ctl.listModels('h1')).rejects.toThrow(/not found/i)
  })
})

describe('parseCmdModels', () => {
  it('parses rows, marks default, stops at Decision models', () => {
    const o = parseCmdModels('acme/alpha  Alpha one\nacme/beta   Beta two (default)\nDecision models\nfoo/bar  X', 'acme/alpha')
    expect(o.map(x => x.label)).toEqual(['acme/alpha', 'acme/beta'])
    expect(o[0]).toMatchObject({ current: true, isDefault: false })
    expect(o[1]).toMatchObject({ current: false, isDefault: true, hint: 'Beta two' })
  })
})
