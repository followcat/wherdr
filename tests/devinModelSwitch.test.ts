import { beforeEach, describe, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ sent: [] as { method: string, params: Record<string, unknown> }[], screen: '', afterAltEnter: '', pane: {} as Record<string, unknown>, afterMove: '' }))
const MENU = `
──────────────────────────────────────────
/
──────────────────────────────────────────
  SWE-2                                                ← ◼◼◼    → Max            Fast Mode Off
❭ Grok 4.7                                             ← ◼◼◼◼   → Medium          Fast Mode Off
↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel
`

vi.mock('../server/utils/env', () => ({ log: () => {} }))
vi.mock('../server/utils/actions', () => ({ closePanel: async () => false }))
vi.mock('../server/utils/machines', () => ({ machineOfPane: () => null }))
vi.mock('../server/utils/state', () => ({
  READY: new Set(['idle', 'done']),
  findPane: () => calls.pane,
  poll: () => {},
  transcripts: {
    model: async () => ({ id: 'SWE-2', label: 'SWE-2' }),
  },
}))
vi.mock('../server/utils/herdr', () => {
  const herdr = async (method: string, params: Record<string, unknown>) => {
    calls.sent.push({ method, params })
    if (method === 'pane.send_input' && calls.afterMove && (params.keys as string[]).some(k => k === 'up' || k === 'down')) calls.screen = calls.afterMove
    if (method === 'pane.send_input' && (params.keys as string[]).includes('alt+enter')) calls.screen = calls.afterAltEnter
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

import { listModels, setModel } from '../server/utils/modelctl'

beforeEach(() => {
  calls.sent = []; calls.screen = ''; calls.afterAltEnter = ''; calls.afterMove = ''
  calls.pane = { id: 'w1:p1', agent: 'devin', status: 'done' }
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
