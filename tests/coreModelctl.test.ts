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
function make(over: Partial<CoreModelCtlDeps> & {
  screens?: (string | (() => string | Promise<string>))[],
  agent?: string,
  onKeys?: (keys: string[]) => void,
} = {}) {
  const ops: Op[] = []
  let i = 0
  const screens = over.screens ?? [idle]
  const pane: Pane = { id: 'h1', agent: over.agent ?? 'claude', status: 'idle', coreAddress: 't:1', machine: '' } as Pane
  const noted: { pane: string, agent: string, list: any }[] = []
  const overrides: any[] = []
  const efforts: any[] = []
  const deps: CoreModelCtlDeps = {
    call: async (method: string, params: object) => {
      ops.push({ method, params })
      if (method === 'terminal.read') {
        const s = screens[Math.min(i++, screens.length - 1)]
        return { text: typeof s === 'function' ? await s() : s }
      }
      if (method === 'terminal.keys') over.onKeys?.((params as { keys: string[] }).keys)
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
    noteOverride: (paneId, info) => { overrides.push({ paneId, info }) },
    noteObservedEffort: (paneId, label, effort) => { efforts.push({ paneId, label, effort }) },
    sleep: async () => {},
    now: () => 1000,
    ...over,
  }
  return { ctl: createCoreModelCtl(deps), ops, noted, overrides, efforts, pane, deps }
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

// The switch drives the same screens the list reads: a fake `call` whose keys
// move the fixture state (like the real TUI would).
describe('setModel — claude', () => {
  const cursor4 = fx('claude-model-cursor4.txt')
  const confirm5 = fx('claude-model-confirm-sonnet5.txt')
  const confirm46 = fx('claude-model-confirm.txt')

  it('accepts the matching "Switch model?" and records the pick', async () => {
    let cur = menu1
    const { ctl, ops, overrides, efforts } = make({
      screens: [idle, idle, () => cur],
      onKeys: (k) => {
        if (k.includes('s')) cur = confirm5
        else if (k.includes('enter')) cur = idle
        else if (k.includes('down')) cur = cursor4
      },
    })
    const info = await ctl.setModel('h1', 'Sonnet 5')
    expect(info).toMatchObject({ label: 'Sonnet 5', effort: 'high' })
    expect(sends(ops).map(o => o.params.text)).toEqual(['/model'])
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).toContain('down,down,down')
    expect(seq).toContain('s')
    expect(seq).toContain('enter')
    expect(overrides[0]).toMatchObject({ paneId: 'h1', info: { label: 'Sonnet 5', effort: 'high' } })
    expect(efforts[0]).toMatchObject({ label: 'Sonnet 5', effort: 'high' })
  })

  it('declines a "Switch model?" naming another model — nothing recorded', async () => {
    let cur = menu1
    const { ctl, ops, overrides } = make({
      screens: [idle, idle, () => cur],
      onKeys: (k) => {
        if (k.includes('s')) cur = confirm46
        else if (k.includes('enter')) cur = idle
      },
    })
    await expect(ctl.setModel('h1', 'Default (recommended)')).rejects.toMatchObject({ code: 'stale' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).toContain('down,enter') // "No, go back"
    expect(overrides).toHaveLength(0)
  })

  it('a native prompt replacing the menu mid-switch: refusal, close attempted', async () => {
    const { ctl, ops } = make({ screens: [idle, idle, menu1, menu1, cursor4, ask] })
    await expect(ctl.setModel('h1', 'Sonnet 5')).rejects.toMatchObject({ code: 'stale' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).not.toContain('s')
    expect(seq).not.toContain('enter')
    expect(seq).toContain('esc')
  })

  it('refuses labels not in the freshly read list and closes the menu', async () => {
    const { ctl, ops } = make({ screens: [idle, idle, menu1] })
    await expect(ctl.setModel('h1', 'No Such Model')).rejects.toMatchObject({ code: 'bad_model' })
    expect(sends(ops)).toHaveLength(1)
    expect(keys(ops).some(o => o.params.keys.includes('esc'))).toBe(true)
  })

  it('refuses parts and a missing label before any terminal IO', async () => {
    const { ctl, ops } = make()
    await expect(ctl.setModel('h1', 'Sonnet 5', { lead: 'X' })).rejects.toMatchObject({ code: 'unsupported' })
    await expect(ctl.setModel('h1', '')).rejects.toMatchObject({ code: 'bad_model' })
    expect(ops).toHaveLength(0)
  })

  it('refuses omp/devin/opencode/cmd panes for now', async () => {
    const { ctl, pane } = make({ agent: 'omp' })
    await expect(ctl.setModel('h1', 'acme/alpha')).rejects.toMatchObject({ code: 'unsupported' })
    pane.agent = 'devin'
    await expect(ctl.setModel('h1', 'x')).rejects.toMatchObject({ code: 'unsupported' })
  })
})

describe('setModel — codex', () => {
  const cmodel1 = fx('codex-model-1.txt')
  const cmodel2 = fx('codex-model-2.txt')
  const cidle = fx('codex-idle.txt')

  it('enter selects, effort page confirms with s', async () => {
    let cur = cmodel1
    const { ctl, ops, overrides } = make({
      agent: 'codex',
      screens: [cidle, cidle, () => cur],
      onKeys: (k) => {
        if (k.includes('enter')) cur = cmodel2
        else if (k.includes('s')) cur = cidle
      },
    })
    const info = await ctl.setModel('h1', 'GPT-6-Sol')
    expect(info).toMatchObject({ label: 'GPT-6-Sol', effort: 'medium' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq.indexOf('enter')).toBeLessThan(seq.indexOf('s'))
    expect(overrides[0]).toMatchObject({ info: { label: 'GPT-6-Sol' } })
  })
})
