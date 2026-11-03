// Command Code sends type into its composer: Herdr's agent.prompt refuses a
// label-only pane ("not an active named agent"), so sendPrompt writes text
// then Enter itself — gated by the strict composer recognizer, never over a
// dialog, a "/" menu or a draft.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { bindFunction } from './stateFunction'
import { isSubmitKey } from '../shared/submitKeys'
import { isSlashCommand } from '../shared/queuedMatch'
import { HerdrError } from '../server/utils/herdr'
import { inputVisible } from '../server/utils/choices'
import { cmdFieldLine, codexFieldLine, devinFieldLine, inputBox } from '../server/utils/unqueue'

const source = readFileSync(new URL('../server/utils/state.ts', import.meta.url), 'utf8')
  .replace('export function sendPrompt(', 'function sendPrompt(')
const withPaneLock = <T>(_id: string, fn: () => Promise<T>) => fn()
const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

function sendPromptBind(pane: Record<string, unknown>, screen: string) {
  const herdr = vi.fn(async (method: string) => method === 'pane.read' ? { read: { text: screen } } : {})
  const agentPrompt = vi.fn(async () => {})
  const confirmSubmitted = vi.fn(async () => {})
  const fieldDeps = vi.fn(() => ({ box: async () => '' }))
  const sendPrompt = bindFunction(source, 'sendPrompt', {
    isSubmitKey, isSlashCommand, HerdrError, inputVisible, cmdFieldLine,
    withPaneLock,
    findPane: () => pane,
    log: vi.fn(),
    GUARD_STATES: new Set(['idle', 'done', 'working']),
    FIELD_READERS: { codex: codexFieldLine, claude: inputBox, devin: devinFieldLine },
    codexFieldLine, inputBox,
    herdr, confirmSubmitted, fieldDeps,
    agentPrompt, typedFor: (_p: unknown, t: string) => t, guardedSend: vi.fn(),
    addQueued: vi.fn(() => ({})),
    sleep: async () => {},
    transcripts: { opencodeShell: async () => false },
  }) as (p: unknown, text: string, opts?: { retry?: boolean, submitKey?: string }) => Promise<void>
  return { sendPrompt, herdr, agentPrompt, confirmSubmitted, fieldDeps }
}

describe('sendPrompt on a Command Code pane', () => {
  const pane = { id: 'w1:p1', agent: 'cmd', status: 'idle' }

  it('types the text then Enter — agent.prompt is never tried', async () => {
    const { sendPrompt, herdr, agentPrompt, confirmSubmitted, fieldDeps } = sendPromptBind(pane, fx('cmd-composer.txt'))
    await sendPrompt(pane, 'fix the flaky test')
    expect(herdr.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['pane.read', { pane_id: 'w1:p1', source: 'detection' }],
      ['pane.send_input', { pane_id: 'w1:p1', text: 'fix the flaky test' }],
      ['pane.send_input', { pane_id: 'w1:p1', keys: ['enter'] }],
    ])
    expect(agentPrompt).not.toHaveBeenCalled()
    // The same "field must not keep our text" check, on its own reader.
    expect(confirmSubmitted).toHaveBeenCalledWith(expect.anything(), 'fix the flaky test')
    expect(fieldDeps).toHaveBeenCalledWith(pane, cmdFieldLine)
  })

  it('a trust dialog owns the keys: held, nothing typed', async () => {
    const { sendPrompt, herdr, agentPrompt, confirmSubmitted } = sendPromptBind(pane, fx('cmd-trust-dialog.txt'))
    await expect(sendPrompt(pane, 'fix the flaky test')).rejects.toMatchObject({ code: 'no_input' })
    expect(herdr.mock.calls.map(c => c[0])).toEqual(['pane.read'])
    expect(agentPrompt).not.toHaveBeenCalled()
    expect(confirmSubmitted).not.toHaveBeenCalled()
  })

  it('a "/" menu or a draft owns the keys: held, nothing typed', async () => {
    for (const f of ['cmd-slash-menu.txt', 'cmd-draft.txt']) {
      const { sendPrompt, herdr, agentPrompt, confirmSubmitted } = sendPromptBind(pane, fx(f))
      await expect(sendPrompt(pane, 'fix the flaky test')).rejects.toMatchObject({ code: 'no_input' })
      expect(herdr.mock.calls.map(c => c[0])).toEqual(['pane.read'])
      expect(agentPrompt).not.toHaveBeenCalled()
      expect(confirmSubmitted).not.toHaveBeenCalled()
    }
  })

  it('mid-turn the composer still takes the typed text (it queues inside)', async () => {
    const working = { ...pane, status: 'working' }
    const { sendPrompt, herdr } = sendPromptBind(working, fx('cmd-composer.txt'))
    await sendPrompt(working, 'fix the flaky test')
    expect(herdr.mock.calls.map(c => c[0])).toEqual(['pane.read', 'pane.send_input', 'pane.send_input'])
  })
})

describe('flushPending: a pending first message types too', () => {
  const pane = { id: 'w1:p1', agent: 'cmd', status: 'idle' }
  function flushBind(p: Record<string, unknown>, pend: { text: string, at: number, submitKey?: string }) {
    const sendPrompt = vi.fn(async () => {})
    const agentPrompt = vi.fn(async () => {})
    const pendingPrompts = new Map([[p.id, pend]])
    const flush = bindFunction(source, 'flushPending', {
      pendingPrompts, pendingBusy: new Set(), READY: new Set(['idle', 'done']),
      sendPrompt, agentPrompt, withPaneLock,
      typedFor: (_p: unknown, t: string) => t,
      log: vi.fn(), PENDING_TTL_MS: 900000,
    }) as (p: unknown) => void
    return { flush, sendPrompt, agentPrompt, pendingPrompts }
  }

  it('Command Code goes through sendPrompt — agent.prompt refuses its label-only pane', async () => {
    const { flush, sendPrompt, agentPrompt, pendingPrompts } = flushBind(pane, { text: 'hello', at: Date.now() })
    flush(pane)
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(pane, 'hello', { submitKey: undefined }))
    expect(agentPrompt).not.toHaveBeenCalled()
    expect(pendingPrompts.has(pane.id)).toBe(false)
  })

  it('an alternate terminator takes the same path, with its key kept', async () => {
    const codex = { ...pane, agent: 'codex' }
    const { flush, sendPrompt, agentPrompt } = flushBind(codex, { text: 'hi', at: Date.now(), submitKey: 'tab' })
    flush(codex)
    await vi.waitFor(() => expect(sendPrompt).toHaveBeenCalledWith(codex, 'hi', { submitKey: 'tab' }))
    expect(agentPrompt).not.toHaveBeenCalled()
  })

  it('other agents keep the locked agent.prompt path', async () => {
    const claude = { ...pane, agent: 'claude' }
    const { flush, sendPrompt, agentPrompt } = flushBind(claude, { text: 'hi', at: Date.now() })
    flush(claude)
    await vi.waitFor(() => expect(agentPrompt).toHaveBeenCalledWith('w1:p1', 'hi'))
    expect(sendPrompt).not.toHaveBeenCalled()
  })
})

describe('cmdFieldLine: the composer field from its screen', () => {
  it('empty composer and placeholder read as an empty field', () => {
    expect(cmdFieldLine(fx('cmd-composer.txt'))).toBe('')
  })
  it('a draft is the field content, not a refusal', () => {
    expect(cmdFieldLine(fx('cmd-draft.txt'))).toBe('fix the flaky test')
  })
  it('a "/" draft is field content too — the recognizer refuses it, not the reader', () => {
    expect(cmdFieldLine(fx('cmd-slash-menu.txt'))).toBe('/')
  })
  it('a dialog reads as no field at all', () => {
    expect(cmdFieldLine(fx('cmd-trust-dialog.txt'))).toBeNull()
  })
  it('SGR styling does not fool the anchors', () => {
    const ansi = '─'.repeat(40) + '\n[1m❯ [0mfix the flaky test\n' + '─'.repeat(40)
    expect(cmdFieldLine(ansi)).toBe('fix the flaky test')
  })
})
