// "Send with <key>": the terminator of the ask travels with the message —
// through the outbox, the server record, holds and retries — and ends the
// typed text at delivery, re-checked against the agent's context then.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { bindFunction } from './stateFunction'
import { isSubmitKey } from '../shared/submitKeys'
import { isSlashCommand } from '../shared/queuedMatch'
import { HerdrError } from '../server/utils/herdr'
import { codexFieldLine, devinFieldLine, inputBox } from '../server/utils/unqueue'
import { loadQueued, type QueueEntry } from '../server/utils/queued'

const source = readFileSync(new URL('../server/utils/state.ts', import.meta.url), 'utf8')
  // bindFunction pastes the declaration into `new Function`: no `export` there.
  .replace('export function sendPrompt(', 'function sendPrompt(')
const withPaneLock = <T>(_id: string, fn: () => Promise<T>) => fn()

function sendPromptBind(pane: Record<string, unknown>) {
  const herdr = vi.fn(async () => ({}))
  const agentPrompt = vi.fn(async () => {})
  const confirmSubmitted = vi.fn(async () => {})
  const guardedSend = vi.fn(async () => ({ foreign: [], unsent: [] }))
  const log = vi.fn()
  const sendPrompt = bindFunction(source, 'sendPrompt', {
    isSubmitKey, isSlashCommand, HerdrError,
    withPaneLock,
    findPane: () => pane,
    log,
    GUARD_STATES: new Set(['idle', 'done', 'working']),
    FIELD_READERS: { codex: codexFieldLine, claude: inputBox, devin: devinFieldLine },
    codexFieldLine, inputBox,
    herdr, confirmSubmitted, fieldDeps: () => ({ box: async () => '' }),
    agentPrompt, typedFor: (_p: unknown, t: string) => t, guardedSend,
    addQueued: vi.fn(() => ({})),
    sleep: async () => {},
  }) as (p: unknown, text: string, opts?: { retry?: boolean, submitKey?: string }) => Promise<void>
  return { sendPrompt, herdr, agentPrompt, confirmSubmitted, guardedSend, log }
}

describe('sendPrompt: an alternate terminator ends the typed text', () => {
  const pane = { id: 'w1:p1', agent: 'codex', status: 'working' }

  it('Codex working: text, then the key — the same writes /api/input makes', async () => {
    const { sendPrompt, herdr, agentPrompt, confirmSubmitted } = sendPromptBind(pane)
    await sendPrompt(pane, 'Summarize the diff', { submitKey: 'tab' })
    expect(herdr.mock.calls.map(c => c[0])).toEqual(['pane.send_input', 'pane.send_input'])
    expect(herdr.mock.calls[0]![1]).toMatchObject({ pane_id: 'w1:p1', text: 'Summarize the diff' })
    expect(herdr.mock.calls[1]![1]).toMatchObject({ pane_id: 'w1:p1', keys: ['tab'] })
    // The same "field must not keep our text" check, with the terminator as
    // the retry — never Enter, which would mean something else to the agent.
    expect(confirmSubmitted).toHaveBeenCalledWith(expect.anything(), 'Summarize the diff', { submitKey: 'tab' })
    expect(agentPrompt).not.toHaveBeenCalled()
  })

  it('the context passed by delivery time: sent normally, with a log', async () => {
    const idle = { ...pane, status: 'idle' }
    const { sendPrompt, agentPrompt, confirmSubmitted, log } = sendPromptBind(idle)
    await sendPrompt(idle, 'Summarize the diff', { submitKey: 'tab' })
    expect(agentPrompt).toHaveBeenCalledWith('w1:p1', 'Summarize the diff')
    expect(confirmSubmitted).toHaveBeenCalledOnce()
    expect(confirmSubmitted.mock.calls[0]![2]).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('tab'))
  })

  it('a key the agent never takes: not stored, not sent', async () => {
    const { sendPrompt, agentPrompt, confirmSubmitted, log } = sendPromptBind(pane)
    await sendPrompt(pane, 'Summarize the diff', { submitKey: 'f5' })
    expect(agentPrompt).toHaveBeenCalledOnce()
    expect(confirmSubmitted.mock.calls[0]![2]).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('f5'))
  })

  it('a held record keeps its key: retry delivers with it too', async () => {
    const { sendPrompt, herdr } = sendPromptBind(pane)
    await sendPrompt(pane, 'Summarize the diff', { retry: true, submitKey: 'tab' })
    expect(herdr.mock.calls[1]![1]).toMatchObject({ keys: ['tab'] })
  })

  it('Devin working: text, then ctrl+enter — its queue terminator, never Enter', async () => {
    const devin = { ...pane, agent: 'devin' }
    const { sendPrompt, herdr, agentPrompt, confirmSubmitted } = sendPromptBind(devin)
    await sendPrompt(devin, 'Summarize the diff', { submitKey: 'ctrl+enter' })
    expect(herdr.mock.calls.map(c => c[0])).toEqual(['pane.send_input', 'pane.send_input'])
    expect(herdr.mock.calls[1]![1]).toMatchObject({ pane_id: 'w1:p1', keys: ['ctrl+enter'] })
    expect(confirmSubmitted).toHaveBeenCalledWith(expect.anything(), 'Summarize the diff', { submitKey: 'ctrl+enter' })
    expect(agentPrompt).not.toHaveBeenCalled()
  })
})

// Read on the real Devin CLI (v3000.11.234): its "❭" marker leads sent
// messages in the history too, so the field is the LAST "❭" line and only
// when nothing but the box rule and the status footer comes after it.
describe('devinFieldLine: the Devin input field from its screen', () => {
  const history = [
    '❭ DEVINCHECK-beta: reply with the single word BETA',
    '',
    ' BETA',
    '',
    ' ⏺ ~/AIcontrol/phone',
  ]
  const footer = ['─'.repeat(73), 'SWE-2 Max                                 Context: 14k / 262k tokens (5%)']
  const screen = (field: string) => [...history, `─ DEVINCHECK-beta: reply with the single … ${'─'.repeat(10)}`, `❭ ${field}`, ...footer].join('\n')

  it('typed draft on the field line', () => {
    expect(devinFieldLine(screen('DEVINCHECK-gamma: reply with the single word GAMMA'))).toBe('DEVINCHECK-gamma: reply with the single word GAMMA')
  })

  it('its hint lines read as an empty field', () => {
    expect(devinFieldLine(screen('Ask Devin to build features, fix bugs, or work on your code'))).toBe('')
    expect(devinFieldLine(screen('Guide Devin while it works'))).toBe('')
    expect(devinFieldLine(screen('Press Enter to send queued messages now'))).toBe('')
  })

  it('a "❭" that is only history is not the field', () => {
    // Sent messages keep the marker; without a box under them the read must
    // refuse rather than mistake the last sent message for field content.
    expect(devinFieldLine([...history, '❭ DEVINCHECK-epsilon: sent just now', ' answer coming…'].join('\n'))).toBeNull()
  })

  it('queued row above the field: the field still anchors', () => {
    const queued = ['── 1 queued ── ↑ edit · ↵ send now ──', '○ DEVINCHECK-gamma: reply with the single word GAMMA', '─'.repeat(73), '❭ Press Enter to send queued messages now', ...footer]
    expect(devinFieldLine([...history, ...queued].join('\n'))).toBe('')
  })

  it('real ANSI screens (v3000.11.234): colors and hints do not fool it', () => {
    const fx = (name: string) => readFileSync(new URL(`./captures/${name}`, import.meta.url), 'utf8')
    expect(devinFieldLine(fx('devin-idle.ansi'))).toBe('')
    expect(devinFieldLine(fx('devin-draft.ansi'))).toBe('ZETA draft for reader check')
  })
})

describe('queue records: the full payload and its key survive a restart', () => {
  it('loadQueued keeps text, full and submitKey of a persisted entry', () => {
    const now = Date.now()
    const list = [[
      'w1:p1',
      [{ id: 'w-a', text: 'cut', full: 'cut and the rest of the long paste', submitKey: 'tab', at: now, held: true }],
    ]] as [string, QueueEntry[]][]
    const loaded = new Map(loadQueued(JSON.parse(JSON.stringify(Object.fromEntries(list))), now))
    expect(loaded.get('w1:p1')![0]).toMatchObject({ text: 'cut', full: 'cut and the rest of the long paste', submitKey: 'tab', held: true })
  })

  it('loadQueued tolerates entries without the new fields', () => {
    const now = Date.now()
    const loaded = new Map(loadQueued({ 'w1:p1': [{ id: 'w-a', text: 'hi', at: now }] }, now))
    expect(loaded.get('w1:p1')![0]).toMatchObject({ text: 'hi' })
    expect(loaded.get('w1:p1')![0]!.full).toBeUndefined()
    expect(loaded.get('w1:p1')![0]!.submitKey).toBeUndefined()
  })
})
