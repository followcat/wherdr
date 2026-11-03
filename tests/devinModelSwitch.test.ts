import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ sent: [] as { method: string, params: Record<string, unknown> }[], screen: '', afterAltEnter: '', pane: {} as Record<string, unknown>, afterMove: '', transcript: null as { id: string | null, label: string } | null, onKeys: null as null | ((keys: string[]) => void) }))
const MENU = `
──────────────────────────────────────────
/
──────────────────────────────────────────
  SWE-2                                                ← ◼◼◼    → Max            Fast Mode Off
❭ Grok 4.7                                             ← ◼◼◼◼   → Medium          Fast Mode Off
↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel
`

// Live capture, search narrowed to "Fusion": the row carries the effort slider
// plus the Lead ▾ / Sidekick ▾ pair; the pricing block sits under it.
const FUSION_MENU = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                  ← ◼◼◼◼◼  → Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M

  ✱ New  ✱ Promotion  ✱ Beta  ✱ Use your ChatGPT plan  · Pairs frontier intelligence with cost-efficient execution
↑↓ select · tab lead · ←→ effort · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc cancel
`

// The composer after alt+↵ on Fusion: status line names the session's pick,
// even without a "Model set to" echo on screen.
const FUSION_STATUS = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
Fusion · GPT-6.1 Sol ◆ SWE-2 High · bypass                        See usage and cost: /session-stats
`

// Live captures, "tab" on the Fusion row: the Lead ▾ / Sidekick ▾ dropdowns
// open below it ("esc collapse" legend; "▸" is the pick, "*" the default).
const LEAD_OPEN = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                    ◼◼◼◼◼    Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off
                                                   Claude Opus 5.5
                                                 ▸ GPT-6.1 Sol
                                                   Claude Fable 5.1
                                                   GPT-6 Astra
                                                   GPT-6 Sol
                                                   GPT-5.6 Sol
                                                   Claude Opus 5
                                                   Claude Sonnet 5.5

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M
↑↓ select · tab sidekick · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc collapse
`

const SIDE_OPEN = `
──────────────────────────────────────────
/ Fusion
──────────────────────────────────────────
❭ Fusion                    ◼◼◼◼◼    Max           Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off
                                                                           SWE-2 Medium *
                                                                         ▸ SWE-2 High
                                                                           GPT-6 Luna High
                                                                           GPT-6.1 Terra High
                                                                           GPT-5.6 Luna High
                                                                           GPT-5.6 Sol High
                                                                           GLM-5.2 High
                                                                           Claude Sonnet 5.5 Medium

  ━━━━━━━━━━━━●━━━━━━━━━━━━━━━━━━━━━━━
  Input        Cached input   Output       Sidekick  Free
  $2 / 1M      $0.1 / 1M      $10 / 1M
↑↓ select · tab fast mode · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc collapse
`

// ↑↓ inside a dropdown retargets the row field live — the row shows it
// truncated ("GPT-6 Luna H…") while "▸" names the pick exactly.
const SIDE_LUNA = SIDE_OPEN
  .replace('Sidekick SWE-2 High', 'Sidekick GPT-6 Luna H…')
  .replace('▸ SWE-2 High', '  SWE-2 High')
  .replace(/(\s+)GPT-6 Luna High/, '$1▸ GPT-6 Luna High')

const FUSION_STATUS_LUNA = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
Fusion · GPT-6.1 Sol ◆ GPT-6 Luna High · bypass                   See usage and cost: /session-stats
`

const FUSION_STATUS_OPUS = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
Fusion · Claude Opus 5.5 ◆ SWE-2 High · bypass                    See usage and cost: /session-stats
`

// The picker's key handling in the mock: tab cycles the row's controls
// (effort → lead → sidekick), esc collapses a dropdown back to the menu.
function driveFusion(screens: Record<string, string>, extra?: (k: string, st: string) => string) {
  let st = 'menu'
  calls.onKeys = (keys) => {
    for (const k of keys) {
      if (k === 'tab') st = st === 'menu' ? 'lead' : st === 'lead' ? 'side' : st
      else if (k === 'esc') st = 'menu'
      else st = extra ? extra(k, st) : st
    }
    calls.screen = screens[st] || calls.screen
  }
}

// ▸ moved onto Claude Opus 5.5 in the Lead dropdown.
const LEAD_OPUS = LEAD_OPEN.replace('▸ GPT-6.1 Sol', '  GPT-6.1 Sol').replace('  Claude Opus 5.5', '▸ Claude Opus 5.5')

vi.mock('../server/utils/env', () => ({ log: () => {} }))
vi.mock('../server/utils/actions', () => ({ closePanel: async () => false }))
vi.mock('../server/utils/machines', () => ({ machineOfPane: () => null }))
vi.mock('../server/utils/state', () => ({
  READY: new Set(['idle', 'done']),
  findPane: () => calls.pane,
  poll: () => {},
  transcripts: {
    model: async () => calls.transcript,
  },
}))
vi.mock('../server/utils/herdr', () => {
  const herdr = async (method: string, params: Record<string, unknown>) => {
    calls.sent.push({ method, params })
    if (method === 'pane.send_input' && calls.afterMove && (params.keys as string[]).some(k => k === 'up' || k === 'down')) calls.screen = calls.afterMove
    if (method === 'pane.send_input' && (params.keys as string[]).includes('alt+enter')) calls.screen = calls.afterAltEnter
    if (method === 'pane.send_input' && calls.onKeys && !(params.keys as string[]).includes('alt+enter')) calls.onKeys(params.keys as string[])
    return method === 'pane.read' ? { read: { text: calls.screen } } : {}
  }
  return {
    HerdrError: class HerdrError extends Error {
      constructor(public code: string, message: string) { super(message) }
    },
    sleep: async () => {},
    herdr,
    agentPrompt: async (target: string, text: string) => { await herdr('agent.prompt', { target, text }) },
  }
})

import { currentModel, forgetModel, listModels, noteScreen, setModel } from '../server/utils/modelctl'

beforeEach(() => {
  calls.sent = []; calls.screen = ''; calls.afterAltEnter = ''; calls.afterMove = ''; calls.onKeys = null
  calls.transcript = { id: 'SWE-2', label: 'SWE-2' }
  calls.pane = { id: 'w1:p1', agent: 'devin', status: 'done' }
  forgetModel('w1:p1')
})

describe('model switching while a dialog owns the terminal', () => {
  it('refuses listModels and setModel for a Devin prompt without touching the pane', async () => {
    calls.pane.prompt = { kind: 'choices', question: 'Allow Devin to run: Exec(sleep) — Once' }
    await expect(listModels('w1:p1', true)).rejects.toMatchObject({ code: 'busy' })
    await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'busy' })
    // Not a single agent.prompt/send_input — the dialog must not be fed keys.
    expect(calls.sent).toEqual([])
  })

  it('refuses when an interactive menu or wait screen is up', async () => {
    calls.pane.menu = { kind: 'menu', options: [] }
    await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'busy' })
    calls.pane.menu = undefined; calls.pane.screen = { kind: 'other' }
    await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'busy' })
    expect(calls.sent).toEqual([])
  })
})

describe('devinSetModel verification', () => {
  it('succeeds when the echo names the requested model', async () => {
    calls.screen = MENU
    calls.afterAltEnter = '\n✓ Model set to Grok 4.7 for this session\n  ❭\n'
    const info = await setModel('w1:p1', 'Grok 4.7')
    expect(info.label).toBe('Grok 4.7')
    // The only confirm ever sent is alt+enter — plain Enter writes the global
    // default. The esc presses close any picker already open (mock screen is static).
    expect(calls.sent.filter(c => c.method === 'pane.send_input').map(c => c.params.keys)).toEqual([
      ['esc'], ['esc'], ['esc'],
      ...('Grok 4.7'.split('').map(ch => [ch])),
      ['alt+enter'],
    ])
  })

  it('a mismatched confirmation echo is stale, never success', async () => {
    calls.screen = MENU
    calls.afterAltEnter = '\n✓ Model set to SWE-2 for this session\n  ❭\n'
    await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'stale' })
  })

  it('no confirmation at all is stale too', async () => {
    calls.screen = MENU
    calls.afterAltEnter = '\n  ❭\n' // menu gone, no echo, transcript/footer unchanged
    await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'stale' })
  })

  it('selects Fusion: the status line confirms when no echo is read', async () => {
    calls.screen = FUSION_MENU
    calls.afterAltEnter = FUSION_STATUS // transcript still says SWE-2 — never "Fusion"
    const info = await setModel('w1:p1', 'Fusion')
    expect(info.label).toBe('Fusion')
    expect(calls.sent.some(c => (c.params.keys as string[] | undefined)?.includes('alt+enter'))).toBe(true)
    expect(calls.sent.some(c => (c.params.keys as string[] | undefined)?.includes('enter'))).toBe(false)
  })

  it('a stale echo of a different model does not veto the status line', async () => {
    calls.screen = FUSION_MENU
    // An older "Model set to SWE-2" echo may still be on screen; the status
    // line is the live pick and says Fusion.
    calls.afterAltEnter = `\n✓ Model set to SWE-2 for this session\n${FUSION_STATUS}`
    const info = await setModel('w1:p1', 'Fusion')
    expect(info.label).toBe('Fusion')
  })

  it('a status line naming another model is stale, never success', async () => {
    calls.screen = FUSION_MENU
    calls.afterAltEnter = `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
SWE-2 Max · bypass                                                See usage and cost: /session-stats
`
    await expect(setModel('w1:p1', 'Fusion')).rejects.toMatchObject({ code: 'stale' })
  })
})


describe('current model reporting', () => {
  it('the status line wins over a lagging transcript — Fusion stays "Fusion"', async () => {
    noteScreen('w1:p1', 'devin', FUSION_STATUS)
    expect((await currentModel(calls.pane as never))?.label).toBe('Fusion')
    // A generation under Fusion would name the lead/sidekick — still "Fusion".
    calls.transcript = { id: 'gpt-6-1-sol-xhigh', label: 'GPT-6.1 Sol XHigh' }
    expect((await currentModel(calls.pane as never))?.label).toBe('Fusion')
  })

  it('keeps the transcript id when it names the same model', async () => {
    calls.transcript = { id: 'fusion', label: 'Fusion' }
    noteScreen('w1:p1', 'devin', FUSION_STATUS)
    expect(await currentModel(calls.pane as never)).toMatchObject({ id: 'fusion', label: 'Fusion' })
  })

  it('falls back on the transcript when no status line was seen', async () => {
    noteScreen('w1:p1', 'devin', 'a screen without a status line')
    expect(await currentModel(calls.pane as never)).toMatchObject({ id: 'SWE-2', label: 'SWE-2' })
  })
})

it('a terminal-only interaction owns the pane even with ready status', async () => {
  calls.pane.interaction = 'terminal'
  calls.screen = MENU
  await expect(listModels('w1:p1', true)).rejects.toMatchObject({ code: 'busy' })
  await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'busy' })
  expect(calls.sent).toEqual([])
})

it('rechecks the selected row before confirming after a cursor move', async () => {
  calls.screen = MENU
  calls.afterMove = MENU.replace('❭ Grok', '  Grok')
  calls.afterAltEnter = '✓ Model set to SWE-2 for this session'
  await expect(setModel('w1:p1', 'SWE-2')).rejects.toMatchObject({ code: 'stale' })
  expect(calls.sent.some(c => (c.params.keys as string[] | undefined)?.includes('alt+enter'))).toBe(false)
})

it('does not accept an older successful echo above the latest mismatched echo', async () => {
  calls.screen = MENU
  calls.afterAltEnter = '✓ Model set to Grok 4.7 for this session\n✓ Model set to SWE-2 for this session'
  await expect(setModel('w1:p1', 'Grok 4.7')).rejects.toMatchObject({ code: 'stale' })
})

describe('Fusion Lead/Sidekick parts', () => {
  it('drives tab → ↓ → esc → alt+↵ and verifies the status-line pair', async () => {
    calls.screen = FUSION_MENU
    calls.afterAltEnter = FUSION_STATUS_LUNA
    driveFusion({ menu: FUSION_MENU, lead: LEAD_OPEN, side: SIDE_OPEN, sideLuna: SIDE_LUNA },
      (k, st) => (k === 'down' && st === 'side' ? 'sideLuna' : st))
    const info = await setModel('w1:p1', 'Fusion', { sidekick: 'GPT-6 Luna High' })
    expect(info.label).toBe('Fusion')
    const seq = calls.sent.filter(c => c.method === 'pane.send_input').flatMap(c => c.params.keys as string[])
    // esc×3 close stale pickers, the search chars, tab tab (effort→lead→sidekick),
    // down (SWE-2 High → GPT-6 Luna High), esc collapse, alt+enter. Never "enter".
    expect(seq).toEqual([
      'esc', 'esc', 'esc',
      ...'Fusion'.split(''),
      'tab', 'tab', 'down', 'esc', 'alt+enter',
    ])
  })

  it('picks the lead from its own dropdown (one tab)', async () => {
    calls.screen = FUSION_MENU
    calls.afterAltEnter = FUSION_STATUS_OPUS
    driveFusion({ menu: FUSION_MENU, lead: LEAD_OPEN, leadOpus: LEAD_OPUS },
      (k, st) => (k === 'up' && st === 'lead' ? 'leadOpus' : st))
    const info = await setModel('w1:p1', 'Fusion', { lead: 'Claude Opus 5.5' })
    expect(info.label).toBe('Fusion')
    const seq = calls.sent.filter(c => c.method === 'pane.send_input').flatMap(c => c.params.keys as string[])
    expect(seq.slice(-4)).toEqual(['tab', 'up', 'esc', 'alt+enter'])
  })

  it('a status-line pair that does not match the request never verifies', async () => {
    calls.screen = FUSION_MENU
    // Both picks land on screen, but the applied pair names a different lead —
    // the status line is the truth and stays GPT-6.1 Sol → stale.
    calls.afterAltEnter = FUSION_STATUS_LUNA
    driveFusion({ menu: FUSION_MENU, lead: LEAD_OPEN, leadOpus: LEAD_OPUS, side: SIDE_OPEN, sideLuna: SIDE_LUNA },
      (k, st) => (k === 'up' && st === 'lead' ? 'leadOpus' : k === 'down' && st === 'side' ? 'sideLuna' : st))
    await expect(setModel('w1:p1', 'Fusion', { lead: 'Claude Opus 5.5', sidekick: 'GPT-6 Luna High' }))
      .rejects.toMatchObject({ code: 'stale' })
  })

  it('a part name the dropdown does not offer is bad_model; parts on another model too', async () => {
    calls.screen = FUSION_MENU
    driveFusion({ menu: FUSION_MENU, lead: LEAD_OPEN, side: SIDE_OPEN })
    await expect(setModel('w1:p1', 'Fusion', { sidekick: 'No Such Model' })).rejects.toMatchObject({ code: 'bad_model' })
    calls.screen = MENU
    await expect(setModel('w1:p1', 'Grok 4.7', { lead: 'GPT-6.1 Sol' })).rejects.toMatchObject({ code: 'bad_model' })
    // Non-Devin panes reject parts outright.
    calls.pane.agent = 'claude'
    await expect(setModel('w1:p1', 'sonnet', { lead: 'X' })).rejects.toMatchObject({ code: 'unsupported' })
    calls.pane.agent = 'devin'
  })

  it('marks the current model from the status line, effort suffix included', async () => {
    // The status line prints "<model> <effort>" — SWE-2 at Max reads "SWE-2
    // Max" — while the menu row is just "SWE-2". The tick still lands on it.
    noteScreen('w1:p1', 'devin', `
❭ Ask Devin to build features, fix bugs, or work on your code
─────────────────────────────────────────────────────────────────────────
SWE-2 Max · bypass                                                See usage and cost: /session-stats
`)
    calls.screen = MENU
    const list = await listModels('w1:p1', true)
    expect(list.options.find(o => o.label === 'SWE-2')?.current).toBe(true)
    expect(list.options.find(o => o.label === 'Grok 4.7')?.current).toBe(false)
  })

  it('listModels carries the Lead/Sidekick lists on the Fusion option', async () => {
    calls.screen = FUSION_MENU
    driveFusion({ menu: FUSION_MENU, lead: LEAD_OPEN, side: SIDE_OPEN })
    const list = await listModels('w1:p1', true)
    const fusion = list.options.find(o => o.label === 'Fusion')
    expect(fusion).toBeDefined()
    expect(fusion!.parts).toEqual([
      { key: 'lead', label: 'Lead', current: 'GPT-6.1 Sol', options: expect.arrayContaining(['Claude Opus 5.5', 'GPT-6.1 Sol', 'GPT-6 Astra']) },
      { key: 'sidekick', label: 'Sidekick', current: 'SWE-2 High', options: expect.arrayContaining(['SWE-2 Medium', 'SWE-2 High', 'GPT-6 Luna High']) },
    ])
  })
})
