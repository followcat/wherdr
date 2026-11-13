// coreModelctl on fake deps: every terminal.* call is recorded; screens come
// from fixtures. The gate, the busy lock, menu cleanup and each list path —
// never a real agent.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { createCoreModelCtl, parseCmdModels, type CoreModelCtlDeps } from '../server/utils/coreModelctl'
import { ompSelectorCaption } from '../server/utils/modelMenus'
import { ompModelLabel } from '../server/utils/models'
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
  const screenEff: any[] = []
  const patches: any[] = []
  // now() advances: a wait whose screen never matches must time out like in
  // production — a frozen clock turns that into an infinite poll.
  let t = 1000
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
    opencodePatchModel: async (_p, model) => {
      patches.push(model)
      return { model: { id: model.id, providerID: model.providerID, variant: model.variant } }
    },
    noteList: (p, agent, list) => { noted.push({ pane: `${p.machine}|${agent}`, agent, list }) },
    noteOverride: (paneId, info) => { overrides.push({ paneId, info }) },
    noteObservedEffort: (paneId, label, effort) => { efforts.push({ paneId, label, effort }) },
    noteScreenEffort: (paneId, effort) => { screenEff.push({ paneId, effort }) },
    sleep: async () => {},
    now: () => (t += 50),
    ...over,
  }
  return { ctl: createCoreModelCtl(deps), ops, noted, overrides, efforts, screenEff, pane, deps, patches }
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
    const { ctl, ops } = make({ screens: [idle, idle, idle, idle, menu1, gone, menu1, idle] })
    await expect(ctl.listModels('h1')).rejects.toThrow('read gone')
    expect(keys(ops).some(o => o.params.keys.includes('esc'))).toBe(true)
  })
  it('a second operation on the same pane is refused while one runs', async () => {
    let release: (() => void) | null = null
    let held = true
    const slow = () => held ? new Promise<string>(r => { release = () => { held = false; r(menu1) } }) : menu1
    const { ctl } = make({ screens: [idle, idle, idle, idle, menu1, slow] })
    const first = ctl.listModels('h1')
    await new Promise(r => setTimeout(r, 10))
    await expect(ctl.listModels('h1')).rejects.toThrow(/already running/)
    release?.()
    await first.catch(() => {})
  })
})

describe('listModels dispatch', () => {
  it('claude: gated /model menu read, all pages, esc at the end', async () => {
    const { ctl, ops, noted } = make({ screens: [idle, idle, idle, idle, menu1, menu1, menu2, menu2, menu2, menu2, idle] })
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
    const { ctl, ops, noted, pane } = make({ screens: [idle, idle, idle, sel, sel, idle] })
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
    const { ctl, ops, noted, pane } = make({ screens: [idle, idle, idle, narrow, narrow, idle] })
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
      screens: [idle, idle, idle, idle, () => cur],
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
      screens: [idle, idle, idle, idle, () => cur],
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
    const { ctl, ops } = make({ screens: [idle, idle, idle, idle, menu1, menu1, cursor4, ask] })
    await expect(ctl.setModel('h1', 'Sonnet 5')).rejects.toMatchObject({ code: 'stale' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).not.toContain('s')
    expect(seq).not.toContain('enter')
    expect(seq).toContain('esc')
  })

  it('refuses labels not in the freshly read list and closes the menu', async () => {
    const { ctl, ops } = make({ screens: [idle, idle, idle, idle, menu1] })
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

  it('refuses cmd panes for now', async () => {
    const { ctl } = make({ agent: 'cmd' })
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
      screens: [cidle, cidle, cidle, cidle, () => cur],
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

// T4: omp's alt+p selector drive (set + list), the effort paths (claude
// slider, codex effort page, omp ⇧⇥ cycle) — same fake-deps style.
describe('setModel — omp selector', () => {
  const sel = fx('omp-selector.txt')
  const sel1 = fx('omp-selector-cursor1.txt')
  const footer = fx('omp-idle-footer.txt')
  const haiku = 'anthropic/claude-haiku-4-5'

  it('drives the cursor to the row and enters — session only', async () => {
    let cur = sel
    const { ctl, ops, overrides, pane } = make({
      agent: 'omp',
      screens: [idle, idle, idle, () => cur],
      transcript: async () => ({ id: haiku, label: 'Claude Haiku 4.5', at: '2026-01-01T00:00:00Z' }),
      onKeys: (k) => {
        if (k.includes('down')) cur = sel1
        else if (k.includes('enter')) cur = footer
      },
    })
    pane.machine = ''
    const info = await ctl.setModel('h1', haiku)
    expect(info).toMatchObject({ id: haiku, label: 'Haiku 4.5' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).toEqual(['alt+p', 'down', 'enter'])
    expect(sends(ops)).toHaveLength(0) // the selector needs no typed input
    expect(overrides[0]).toMatchObject({ paneId: 'h1', info: { id: haiku } })
  })

  it('caption and label round-trip on the selector rows', async () => {
    // omp's caption names the cursor model; the id→label map derives the same.
    const caption = ompSelectorCaption(sel1, haiku)
    expect(caption?.name).toBe('Claude Haiku 4.5')
    expect(ompModelLabel(haiku)).toBe('Haiku 4.5')
    const onOpus = ompSelectorCaption(sel, 'anthropic/claude-opus-5-5')
    expect(onOpus?.name).toBe('Claude Opus 5.5')
  })

  it('an unknown id: search keys are typed, then bad_model and close', async () => {
    let cur = sel
    const { ctl, ops, overrides } = make({
      agent: 'omp',
      screens: [idle, idle, idle, () => cur],
    })
    await expect(ctl.setModel('h1', 'acme/nope')).rejects.toMatchObject({ code: 'bad_model' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).toContain('n')
    expect(seq).toContain('esc')
    expect(seq).not.toContain('enter')
    expect(overrides).toHaveLength(0)
  })

  it('a prompt appearing mid-drive: stale, no selector key sent', async () => {
    const { ctl, ops } = make({
      agent: 'omp',
      screens: [idle, idle, idle, sel, ask],
    })
    await expect(ctl.setModel('h1', haiku)).rejects.toMatchObject({ code: 'stale' })
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).toEqual(['alt+p'])
  })
})

describe('efforts — claude slider', () => {
  const effortLow = fx('claude-effort-low.txt')
  const effortMedium = fx('claude-effort-medium.txt')

  it('listEfforts: model-specific levels, zero terminal IO past the gate read', async () => {
    const { ctl, ops } = make({
      currentModel: async () => ({ id: null, label: 'Opus 5.5', effort: 'low', at: null }),
    })
    const r = await ctl.listEfforts('h1')
    expect(r.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])
    expect(r.current).toBe('low')
    expect(sends(ops)).toHaveLength(0)
    expect(keys(ops)).toHaveLength(0)
  })

  it('moves the slider and confirms with s — never Enter', async () => {
    let cur = effortLow
    const { ctl, ops, overrides, efforts, screenEff } = make({
      screens: [idle, idle, idle, idle, () => cur],
      currentModel: async () => ({ id: null, label: 'Opus 5.5', effort: 'low', at: null }),
      onKeys: (k) => {
        if (k.includes('right')) cur = effortMedium
        else if (k.includes('s')) cur = idle
      },
    })
    const info = await ctl.setEffort('h1', 'medium')
    expect(info.effort).toBe('medium')
    expect(sends(ops).map(o => o.params.text)).toEqual(['/effort'])
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq).toEqual(['right', 's'])
    expect(seq).not.toContain('enter')
    expect(screenEff[0]).toMatchObject({ paneId: 'h1', effort: 'medium' })
    expect(overrides[0].info.effort).toBe('medium')
    expect(efforts[0]).toMatchObject({ label: 'Opus 5.5', effort: 'medium' })
  })

  it('a prompt where the slider should be: no_menu, no key touches it', async () => {
    const { ctl, ops } = make({
      screens: [idle, idle, idle, idle, ask],
      currentModel: async () => ({ id: null, label: 'Opus 5.5', effort: 'low', at: null }),
    })
    await expect(ctl.setEffort('h1', 'medium')).rejects.toMatchObject({ code: 'no_menu' })
    expect(sends(ops).map(o => o.params.text)).toEqual(['/effort'])
    expect(keys(ops)).toHaveLength(0) // no arrows, no s, no esc on a prompt
  })

  it('the slider replaced mid-move: stale, close attempted, nothing sent', async () => {
    const { ctl, ops } = make({
      screens: [idle, idle, idle, idle, effortLow, ask],
      currentModel: async () => ({ id: null, label: 'Opus 5.5', effort: 'low', at: null }),
    })
    await expect(ctl.setEffort('h1', 'max')).rejects.toMatchObject({ code: 'stale' })
    expect(sends(ops).map(o => o.params.text)).toEqual(['/effort'])
    expect(keys(ops)).toHaveLength(0)
  })

  it('an unavailable level is refused before the slider opens', async () => {
    const { ctl, ops } = make({
      currentModel: async () => ({ id: null, label: 'Opus 5.5', effort: 'low', at: null }),
    })
    await expect(ctl.setEffort('h1', 'banana')).rejects.toMatchObject({ code: 'bad_effort' })
    expect(sends(ops)).toHaveLength(0)
  })
})

describe('efforts — codex menu', () => {
  const cmodel1 = fx('codex-model-1.txt')
  const cmodel2 = fx('codex-model-2.txt')
  const chigh = fx('codex-model-2-high.txt')
  const cidle = fx('codex-idle.txt')

  it('listEfforts: the local model cache wins, zero terminal IO', async () => {
    const { ctl, ops } = make({
      agent: 'codex',
      screens: [cidle],
      machine: async () => ({
        local: true, home: '/home/user', label: 'host-a',
        fs: { readFile: async () => JSON.stringify({ models: [{ slug: 'gpt-6-sol', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }] }] }) },
      }) as any,
      currentModel: async () => ({ id: 'gpt-6-sol', label: 'GPT-6-Sol', effort: 'medium', at: null }),
    })
    const r = await ctl.listEfforts('h1')
    expect(r.levels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(r.current).toBe('medium')
    expect(sends(ops)).toHaveLength(0)
    expect(keys(ops)).toHaveLength(0)
  })

  it('picks the level on the effort page and confirms with s', async () => {
    let cur = cmodel1
    const { ctl, ops, overrides, efforts } = make({
      agent: 'codex',
      screens: [cidle, cidle, cidle, cidle, () => cur],
      currentModel: async () => ({ id: 'gpt-6-sol', label: 'GPT-6-Sol', effort: 'medium', at: null }),
      onKeys: (k) => {
        if (k.includes('enter')) cur = cmodel2
        else if (k.includes('down')) cur = chigh
        else if (k.includes('s')) cur = cidle
      },
    })
    const info = await ctl.setEffort('h1', 'high')
    expect(info.effort).toBe('high')
    const seq = keys(ops).map(o => o.params.keys.join(','))
    expect(seq.indexOf('enter')).toBeLessThan(seq.indexOf('down'))
    expect(seq.indexOf('down')).toBeLessThan(seq.indexOf('s'))
    expect(overrides[0].info.effort).toBe('high')
    expect(efforts[0]).toMatchObject({ label: 'GPT-6-Sol', effort: 'high' })
  })
})

describe('efforts — omp ⇧⇥ cycle', () => {
  const footer = fx('omp-idle-footer.txt') // "◒ Opus 5.5" — the status line shows high
  const model = { id: 'anthropic/claude-opus-5-5', label: 'Opus 5.5', effort: 'low', at: '2026-01-01T00:00:00Z' }

  it('presses ⇧⇥ to the level, learns the cycle, and listEfforts knows it', async () => {
    const trs = [
      { ...model, effort: 'low', at: '2026-01-01T00:00:00Z' },
      { ...model, effort: 'high', at: '2026-01-01T00:01:00Z' },
    ]
    let ti = 0
    const { ctl, ops, overrides } = make({
      agent: 'omp',
      screens: [idle, footer, idle, footer, idle],
      transcript: async () => trs[Math.min(ti++, trs.length - 1)],
      currentModel: async () => model,
    })
    const info = await ctl.setEffort('h1', 'high')
    expect(info.effort).toBe('high')
    const tabs = keys(ops).filter(o => o.params.keys.includes('shift+tab'))
    expect(tabs).toHaveLength(1)
    expect(overrides[0].info.effort).toBe('high')
    // low → high in one press proved 'medium' skipped: the offered list drops it.
    const r = await ctl.listEfforts('h1')
    expect(r.levels).toEqual(['off', 'auto', 'low', 'high', 'xhigh', 'max'])
    expect(r.levels).not.toContain('medium')
    expect(r.levels).not.toContain('minimal')
  })

  it('a stall mid-cycle: stale, but the reached level is recorded', async () => {
    const trs = [
      { ...model, effort: 'low', at: '2026-01-01T00:00:00Z' },
      { ...model, effort: 'medium', at: '2026-01-01T00:01:00Z' },
    ]
    let ti = 0
    const { ctl, ops, overrides, efforts } = make({
      agent: 'omp',
      screens: [idle, footer, idle, footer, idle, footer],
      transcript: async () => trs[Math.min(ti++, trs.length - 1)],
      currentModel: async () => model,
    })
    await expect(ctl.setEffort('h1', 'xhigh')).rejects.toMatchObject({ code: 'stale' })
    const tabs = keys(ops).filter(o => o.params.keys.includes('shift+tab'))
    expect(tabs).toHaveLength(2)
    expect(overrides[0].info.effort).toBe('medium') // where omp really stopped
    expect(efforts[0]).toMatchObject({ effort: 'medium' })
  })

  it('listEfforts: no cycle learned yet — the default set minus minimal', async () => {
    const { ctl, ops } = make({
      agent: 'omp',
      screens: [idle],
      currentModel: async () => model,
    })
    const r = await ctl.listEfforts('h1')
    expect(r.current).toBe('low')
    expect(r.levels).toEqual(['off', 'auto', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(keys(ops)).toHaveLength(0)
  })
})

describe('efforts — refusal matrix', () => {
  it('devin/opencode/cmd have no effort UI: unsupported, nothing changed', async () => {
    for (const agent of ['devin', 'opencode', 'cmd']) {
      const { ctl, pane } = make({ agent })
      pane.agent = agent
      await expect(ctl.setEffort('h1', 'high')).rejects.toMatchObject({ code: 'unsupported' })
    }
  })
})

// T5: Devin's /model picker — search typing, cursor move, alt+enter only
// (plain Enter writes the GLOBAL default), the Fusion Lead ▾/Sidekick ▾
// pair, and the echo/status/transcript verify loop.
describe('setModel — devin', () => {
  const didle = fx('devin-idle.txt')
  const dmenu = fx('devin-menu-grok.txt')
  const dnocur = fx('devin-menu-nocursor-grok.txt')
  const dconfirm = fx('devin-confirmed.txt')
  const dswe = fx('devin-echo-swe.txt')
  const dafter = fx('devin-after.txt')
  const dfmenu = fx('devin-fusion-menu.txt')
  const dflead = fx('devin-fusion-lead.txt')
  const dfside = fx('devin-fusion-sidekick.txt')
  const dfluna = fx('devin-fusion-side-luna.txt')
  const dfopus = fx('devin-fusion-lead-opus.txt')
  const dstatus = fx('devin-status-fusion.txt')
  const dstluna = fx('devin-status-fusion-luna.txt')
  const dstopus = fx('devin-status-fusion-opus.txt')
  const dstswe = fx('devin-status-swe.txt')
  const seq = (ops: Op[]) => keys(ops).map(o => o.params.keys.join(','))

  it('searches, verifies the row, confirms with alt+enter only', async () => {
    let cur = dmenu
    const { ctl, ops, overrides } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('alt+enter')) cur = dconfirm },
    })
    const info = await ctl.setModel('h1', 'Grok 4.7')
    expect(info.label).toBe('Grok 4.7')
    expect(sends(ops).map(o => o.params.text)).toEqual(['/model'])
    expect(seq(ops)).toEqual(['G', 'r', 'o', 'k', 'space', '4', '.', '7', 'alt+enter'])
    expect(keys(ops).every(o => !o.params.keys.includes('enter') || o.params.keys.includes('alt+enter'))).toBe(true)
    expect(overrides[0].info).toMatchObject({ id: 'Grok 4.7', label: 'Grok 4.7' })
  })

  it('a mismatched confirmation echo is stale, never success', async () => {
    let cur = dmenu
    const { ctl, overrides } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('alt+enter')) cur = dswe },
    })
    await expect(ctl.setModel('h1', 'Grok 4.7')).rejects.toMatchObject({ code: 'stale' })
    expect(overrides).toHaveLength(0)
  })

  it('no confirmation at all is stale too', async () => {
    let cur = dmenu
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('alt+enter')) cur = dafter },
    })
    await expect(ctl.setModel('h1', 'Grok 4.7')).rejects.toMatchObject({ code: 'stale' })
  })

  it('selects Fusion: the status line confirms when no echo is read', async () => {
    let cur = dfmenu
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('alt+enter')) cur = dstatus },
    })
    const info = await ctl.setModel('h1', 'Fusion')
    expect(info.label).toBe('Fusion')
    const all = keys(ops).flatMap(o => o.params.keys)
    expect(all).toContain('alt+enter')
    expect(all).not.toContain('enter')
  })

  it('a stale echo of a different model does not veto the status line', async () => {
    let cur = dfmenu
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('alt+enter')) cur = dswe + dstatus },
    })
    const info = await ctl.setModel('h1', 'Fusion')
    expect(info.label).toBe('Fusion')
  })

  it('a status line naming another model is stale, never success', async () => {
    let cur = dfmenu
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('alt+enter')) cur = dstswe },
    })
    await expect(ctl.setModel('h1', 'Fusion')).rejects.toMatchObject({ code: 'stale' })
  })

  it('rechecks the selected row after a cursor move — a lost ❭ refuses', async () => {
    let cur = dmenu
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('up')) cur = dnocur },
    })
    await expect(ctl.setModel('h1', 'SWE-2')).rejects.toMatchObject({ code: 'stale' })
    expect(keys(ops).every(o => !o.params.keys.includes('alt+enter'))).toBe(true)
  })

  it('a prompt appearing mid-search: stale, nothing else sent', async () => {
    let cur = dmenu
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
      onKeys: (k) => { if (k.includes('G')) cur = ask },
    })
    await expect(ctl.setModel('h1', 'Grok 4.7')).rejects.toMatchObject({ code: 'stale' })
    expect(sends(ops).map(o => o.params.text)).toEqual(['/model'])
    expect(keys(ops).every(o => !o.params.keys.includes('alt+enter'))).toBe(true)
  })

  // The picker's control cycle in the fake: tab steps menu → lead →
  // sidekick, esc collapses to the menu, ↑↓ moves the ▸ pick. `moved`
  // names the screen shown once a pick lands (e.g. sideLuna); `after`
  // is the screen alt+enter leaves behind.
  function drive(moved: Record<string, string>, next: (k: string, st: string) => string | undefined, after: () => string) {
    let st = 'menu'
    const screens: Record<string, string> = { menu: dfmenu, lead: dflead, side: dfside, ...moved }
    return (k: string[], cur: { v: string }) => {
      for (const key of k) {
        if (key === 'alt+enter') { cur.v = after(); continue }
        if (key === 'tab') st = st === 'menu' ? 'lead' : st === 'lead' ? 'side' : st
        else if (key === 'esc') st = 'menu'
        else st = next(key, st) || st
      }
      if (!k.includes('alt+enter')) cur.v = screens[st] || cur.v
    }
  }

  it('drives tab → ↓ → esc → alt+↵ and verifies the status-line pair', async () => {
    const cur = { v: dfmenu }
    const on = drive({ sideLuna: dfluna }, (k, st) => k === 'down' && st === 'side' ? 'sideLuna' : undefined, () => dstluna)
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur.v],
      onKeys: (k) => on(k, cur),
    })
    const info = await ctl.setModel('h1', 'Fusion', { sidekick: 'GPT-6 Luna High' })
    expect(info.label).toBe('Fusion')
    const s = seq(ops)
    expect(s.slice(s.indexOf('F'))).toEqual(['F', 'u', 's', 'i', 'o', 'n', 'tab', 'tab', 'down', 'esc', 'alt+enter'])
  })

  it('picks the lead from its own dropdown (one tab)', async () => {
    const cur = { v: dfmenu }
    const on = drive({ leadOpus: dfopus }, (k, st) => k === 'up' && st === 'lead' ? 'leadOpus' : undefined, () => dstopus)
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur.v],
      onKeys: (k) => on(k, cur),
    })
    const info = await ctl.setModel('h1', 'Fusion', { lead: 'Claude Opus 5.5' })
    expect(info.label).toBe('Fusion')
    const s = seq(ops)
    expect(s.slice(-4)).toEqual(['tab', 'up', 'esc', 'alt+enter'])
  })

  it('a status-line pair that does not match the request never verifies', async () => {
    const cur = { v: dfmenu }
    const on = drive(
      { sideLuna: dfluna, leadOpus: dfopus },
      (k, st) => k === 'up' && st === 'lead' ? 'leadOpus' : k === 'down' && st === 'side' ? 'sideLuna' : undefined,
      () => dstluna)
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur.v],
      onKeys: (k) => on(k, cur),
    })
    await expect(ctl.setModel('h1', 'Fusion', { lead: 'Claude Opus 5.5', sidekick: 'GPT-6 Luna High' }))
      .rejects.toMatchObject({ code: 'stale' })
  })

  it('keeps polling when the status line lags the menu closing', async () => {
    const lag = fx('devin-echo-fusion-lag.txt')
    let cur = dfmenu
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => { const s = cur; cur = s === lag ? dstluna : s; return s }],
      onKeys: (k) => {
        for (const key of k) {
          if (key === 'alt+enter') { cur = lag; continue }
          if (key === 'tab') cur = cur === dfmenu ? dflead : cur === dflead ? dfside : cur
          else if (key === 'esc') cur = dfmenu
          else if (key === 'down' && cur === dfside) cur = dfluna
        }
      },
    })
    const info = await ctl.setModel('h1', 'Fusion', { sidekick: 'GPT-6 Luna High' })
    expect(info.label).toBe('Fusion')
  })

  it('a part name the dropdown does not offer is bad_model', async () => {
    const cur = { v: dfmenu }
    const on = drive({}, () => undefined, () => dstatus)
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur.v],
      onKeys: (k) => on(k, cur),
    })
    await expect(ctl.setModel('h1', 'Fusion', { sidekick: 'No Such Model' })).rejects.toMatchObject({ code: 'bad_model' })
  })

  it('parts on a model without selectable parts is bad_model', async () => {
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => dmenu],
    })
    await expect(ctl.setModel('h1', 'Grok 4.7', { lead: 'GPT-6.1 Sol' })).rejects.toMatchObject({ code: 'bad_model' })
    expect(keys(ops).every(o => !o.params.keys.includes('alt+enter'))).toBe(true)
  })

  it('a parts object naming an unknown part is bad_model', async () => {
    const { ctl } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => dmenu],
    })
    await expect(ctl.setModel('h1', 'Grok 4.7', { extra: 'x' })).rejects.toMatchObject({ code: 'bad_model' })
  })

  it('refuses an unknown model and a missing label', async () => {
    let cur = dmenu
    const { ctl, ops } = make({
      agent: 'devin',
      screens: [didle, didle, didle, didle, () => cur],
    })
    await expect(ctl.setModel('h1', 'No Such Model')).rejects.toMatchObject({ code: 'bad_model' })
    await expect(ctl.setModel('h1', '')).rejects.toMatchObject({ code: 'bad_model' })
    expect(keys(ops).every(o => !o.params.keys.includes('alt+enter'))).toBe(true)
  })
})

describe('setModel — opencode', () => {
  const catalog = [
    { id: 'm1', providerID: 'acme', name: 'Alpha', enabled: true, variants: ['high', 'low'] },
    { id: 'm2', providerID: 'acme', name: 'Beta', enabled: true },
    { id: 'm3', providerID: 'globex', name: 'Beta', enabled: true, modelID: 'beta-pro' },
    { id: 'm4', providerID: 'acme', name: 'Off', enabled: false },
  ]

  it('PATCHes the unique match with zero terminal IO and returns the re-read model', async () => {
    const { ctl, ops, patches } = make({ agent: 'opencode', opencodeModels: async () => catalog })
    const r = await ctl.setModel('h1', 'Beta (globex)')
    expect(r).toMatchObject({ id: 'm3', label: 'Beta' })
    // Exact whitelisted body: entry id + providerID; no variant — m3 offers
    // none and the current session runs a different model.
    expect(patches).toEqual([{ id: 'm3', providerID: 'globex' }])
    // Zero terminal IO: the switch is a service PATCH, never a keystroke.
    expect(ops.filter(o => o.method.startsWith('terminal.'))).toHaveLength(0)
  })

  it('matches by label, id, provider/model and a unique bare name only', async () => {
    for (const [wanted, id, provider] of [['Alpha', 'm1', 'acme'], ['m2', 'm2', 'acme'], ['globex/beta-pro', 'm3', 'globex']] as const) {
      const { ctl, patches } = make({ agent: 'opencode', opencodeModels: async () => catalog })
      await ctl.setModel('h1', wanted)
      expect(patches, wanted).toEqual([{ id, providerID: provider, variant: id === 'm1' ? 'high' : undefined }])
    }
    // 'Alpha' carries a variant: the current session runs another model, so
    // the entry's first variant is requested.
    for (const wanted of ['Beta', 'Nope', 'Off', 'acme/missing']) {
      const { ctl, patches } = make({ agent: 'opencode', opencodeModels: async () => catalog })
      await expect(ctl.setModel('h1', wanted), wanted).rejects.toMatchObject({ code: 'bad_model' })
      expect(patches, wanted).toHaveLength(0)
    }
  })

  it('keeps the current effort when the same model stays selected', async () => {
    const { ctl, patches } = make({
      agent: 'opencode',
      opencodeModels: async () => catalog,
      transcript: async () => ({ id: 'm1', label: 'Alpha', effort: 'low', at: null }),
    })
    await ctl.setModel('h1', 'Alpha')
    expect(patches).toEqual([{ id: 'm1', providerID: 'acme', variant: 'low' }])
  })

  it('a re-read that names another model or never returns is stale, never success', async () => {
    const { ctl, patches } = make({
      agent: 'opencode',
      opencodeModels: async () => catalog,
      opencodePatchModel: async (_p, model) => { patches.push(model); return { model: { id: 'm9', providerID: 'acme' } } },
    })
    await expect(ctl.setModel('h1', 'Alpha')).rejects.toMatchObject({ code: 'stale' })
    expect(patches).toEqual([{ id: 'm1', providerID: 'acme', variant: 'high' }])
    const { ctl: c2, patches: p2 } = make({
      agent: 'opencode',
      opencodeModels: async () => catalog,
      opencodePatchModel: async (_p, model) => { p2.push(model); return null },
    })
    await expect(c2.setModel('h1', 'Alpha')).rejects.toMatchObject({ code: 'stale' })
    expect(p2).toHaveLength(1)
    // A wrong-variant echo is stale too.
    const { ctl: c3, patches: p3 } = make({
      agent: 'opencode',
      opencodeModels: async () => catalog,
      transcript: async () => ({ id: 'm1', label: 'Alpha', effort: 'low', at: null }),
      opencodePatchModel: async (_p, model) => { p3.push(model); return { model: { id: 'm1', providerID: 'acme', variant: 'high' } } },
    })
    await expect(c3.setModel('h1', 'Alpha')).rejects.toMatchObject({ code: 'stale' })
    expect(p3).toHaveLength(1)
  })

  it('refuses parts, a missing model and a pane that is not idle', async () => {
    const { ctl, patches, pane } = make({ agent: 'opencode', opencodeModels: async () => catalog })
    await expect(ctl.setModel('h1', 'Alpha', { lead: 'x' })).rejects.toMatchObject({ code: 'bad_model' })
    await expect(ctl.setModel('h1', '')).rejects.toMatchObject({ code: 'bad_model' })
    pane.status = 'blocked'
    await expect(ctl.setModel('h1', 'Alpha')).rejects.toMatchObject({ code: 'busy' })
    pane.status = 'running'
    await expect(ctl.setModel('h1', 'Alpha')).rejects.toMatchObject({ code: 'busy' })
    expect(patches).toHaveLength(0)
  })

  it('a missing read or write seam is unavailable, not a terminal fallback', async () => {
    const { ctl, ops } = make({ agent: 'opencode', opencodeModels: undefined, opencodePatchModel: undefined })
    await expect(ctl.setModel('h1', 'Alpha')).rejects.toMatchObject({ code: 'unavailable' })
    expect(ops.filter(o => o.method.startsWith('terminal.'))).toHaveLength(0)
  })

  it('the busy lock serializes concurrent switches on the pane', async () => {
    let release: () => void = () => {}
    const { ctl, patches } = make({
      agent: 'opencode',
      opencodeModels: async () => { await new Promise<void>(r => { release = r }); return catalog },
    })
    const p1 = ctl.setModel('h1', 'Alpha')
    await expect(ctl.setModel('h1', 'Beta (acme)')).rejects.toMatchObject({ code: 'busy' })
    release()
    await p1
    expect(patches).toEqual([{ id: 'm1', providerID: 'acme', variant: 'high' }])
  })
})

// `menuMarks` → `menuLeftOpen`: a poll that classifies our own /model menu as a
// native prompt must not poison the pane — a fresh clean read repairs the
// flags instead of refusing, and a real prompt still refuses.
describe('menuLeftOpen', () => {
  it('marks the pane while a withPane op drives, cleared when the poll reads input', async () => {
    const { ctl, pane } = make({ screens: [idle, idle, idle, idle, menu1, menu1, menu2, menu2, menu2, menu2, idle] })
    expect(ctl.menuLeftOpen('h1')).toBe(false)
    await ctl.listModels('h1')
    // The op ended but no read has seen the input again: still marked.
    expect(ctl.menuLeftOpen('h1')).toBe(true)
    ctl.noteRead(pane, menu1)
    expect(ctl.menuLeftOpen('h1')).toBe(true) // still our menu, not clean
    ctl.noteRead(pane, idle)
    expect(ctl.menuLeftOpen('h1')).toBe(false)
  })
  it('stale prompt/blocked from the menu echo are repaired on a clean read, not refused', async () => {
    const { ctl, pane } = make({ screens: [idle, idle, idle, idle, menu1, menu1, menu2, menu2, menu2, menu2, idle, idle, idle, idle, idle, menu1, menu2, idle] })
    await ctl.listModels('h1')
    // What enrich writes while our menu is the screen (native choices + blocked).
    pane.status = 'blocked'
    pane.interaction = 'native'
    pane.prompt = { options: [] } as Pane['prompt']
    await ctl.listModels('h1') // gate repairs, the whole flow runs
    expect(pane.prompt).toBeUndefined()
    expect(pane.interaction).toBe('input')
    expect(pane.status).toBe('idle')
  })
  it('a real prompt on a marked pane still refuses and keeps the mark', async () => {
    const { ctl, pane, ops } = make({ screens: [idle, idle, idle, idle, menu1, menu1, menu2, menu2, menu2, menu2, idle, ask, ask] })
    await ctl.listModels('h1')
    pane.prompt = { options: [] } as Pane['prompt']
    await expect(ctl.listModels('h1')).rejects.toThrow(/waiting for an answer/)
    expect(sends(ops).filter(o => o.params.text === '/model')).toHaveLength(1)
    expect(ctl.menuLeftOpen('h1')).toBe(true)
    expect(pane.prompt).not.toBeUndefined() // a real prompt is not ours to clear
  })
  it('a poll that lands mid-op does not kill the in-flight send gate', async () => {
    // The cleanup read marks the pane like a poll would (our menu echoed as a
    // native prompt) — openMenu's sendInput gate must still fire /model.
    const polluted = () => { pane.status = 'blocked'; pane.prompt = { options: [] } as Pane['prompt']; return idle }
    const { ctl, ops, pane } = make({ screens: [idle, polluted, idle, idle, menu1, menu1, menu2, menu2, menu2, menu2, idle] })
    await ctl.listModels('h1')
    expect(sends(ops).map(o => o.params.text)).toContain('/model')
  })
})
