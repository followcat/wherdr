// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addPromptHistory, caretOnVisualEdge, historyDirection, PromptHistory, PROMPT_HISTORY_MAX } from '../app/utils/promptHistory'

const draft = { text: 'Unsent\n  draft  ', start: 2, end: 2 }
describe('prompt history', () => {
  it('mixes commands and messages, ignores blank texts and consecutive duplicates, and caps entries', () => {
    let entries: string[] = []
    for (let n = 0; n < 120; n++) entries = addPromptHistory(entries, `Message ${n}`)
    expect(entries).toHaveLength(PROMPT_HISTORY_MAX)
    expect(entries[0]).toBe('Message 20')
    expect(addPromptHistory(entries, ' Message 119 ')).toEqual(entries)
    expect(addPromptHistory(entries, ' \n ')).toEqual(entries)
    expect(addPromptHistory(entries, '/compact').at(-1)).toBe('/compact')
    expect(addPromptHistory(['hello', '/compact'], 'hello')).toEqual(['hello', '/compact', 'hello'])
  })
  it('removes reference lines and preserves paragraph spacing', () => {
    expect(addPromptHistory([], '↳ Quote point 11:37 : Continue? —\nYes\n\nPlease proceed.')).toEqual(['Yes\n\nPlease proceed.'])
    expect(addPromptHistory([], '↳ Quote point : Continue? —')).toEqual([])
    expect(addPromptHistory([], '\\↳ Quote point : Continue? —')).toEqual(['\\↳ Quote point : Continue? —'])
  })
  it('recalls newest first, stops at the oldest, and restores the exact draft and caret', () => {
    const history = new PromptHistory()
    const entries = ['first', '/compact']
    expect(history.move(1, draft, entries)).toBeNull()
    expect(history.move(-1, draft, [])).toBeNull()
    expect(history.move(-1, draft, entries)?.text).toBe('/compact')
    expect(history.move(-1, draft, entries)?.text).toBe('first')
    expect(history.move(-1, draft, entries)).toBeNull()
    expect(history.move(1, draft, entries)?.text).toBe('/compact')
    expect(history.move(1, draft, entries)).toEqual(draft)
    expect(history.move(1, draft, entries)).toBeNull()
  })
  it('does not change entries when recalled text is edited or new messages arrive', () => {
    const history = new PromptHistory()
    const entries = ['first', 'second']
    history.move(-1, draft, entries)
    expect(history.move(-1, { text: 'edited second', start: 0, end: 0 }, [...entries, 'new'])?.text).toBe('first')
    expect(history.move(1, draft, entries)?.text).toBe('second')
    expect(entries).toEqual(['first', 'second'])
    history.reset()
    expect(history.move(1, draft, entries)).toBeNull()
  })
  it('keeps panes independent', () => {
    const a = new PromptHistory(), b = new PromptHistory()
    a.move(-1, draft, ['agent A'])
    expect(b.move(-1, { ...draft, text: '' }, ['agent B'])?.text).toBe('agent B')
    expect(a.move(1, draft, [])).toEqual(draft)
  })
})

describe('history arrow boundaries', () => {
  const field = (text: string, at: number) => ({ text, start: at, end: at })
  it('allows empty fields and the first or last logical line', () => {
    expect(historyDirection({ key: 'ArrowUp' }, field('', 0))).toBe(-1)
    expect(historyDirection({ key: 'ArrowUp' }, field('abc\ndef\nghi', 2))).toBe(-1)
    expect(historyDirection({ key: 'ArrowDown' }, field('abc\ndef\nghi', 9))).toBe(1)
    expect(historyDirection({ key: 'ArrowDown' }, field('', 0))).toBe(1)
  })
  it('leaves arrows inside multiline text to the caret', () => {
    for (const key of ['ArrowUp', 'ArrowDown']) expect(historyDirection({ key }, field('abc\ndef\nghi', 5))).toBeNull()
  })
  it('leaves selections, modified keys, composition and handled keys alone', () => {
    expect(historyDirection({ key: 'ArrowUp' }, { text: 'abc', start: 0, end: 2 })).toBeNull()
    for (const flag of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey', 'isComposing', 'defaultPrevented']) {
      expect(historyDirection({ key: 'ArrowUp', [flag]: true }, field('', 0))).toBeNull()
    }
    expect(historyDirection({ key: 'ArrowUp', keyCode: 229 }, field('', 0))).toBeNull()
    expect(historyDirection({ key: 'Enter' }, field('', 0))).toBeNull()
  })
})


describe('wrapped lines', () => {
  // No layout in tests: wrap the mirror every 10 characters.
  const rects = (span: Element) => {
    const start = span.previousSibling?.textContent?.length ?? 0, length = Math.max(1, span.textContent!.length)
    const lines = new Set(Array.from({ length }, (_, n) => Math.floor((start + n) / 10)))
    return [...lines].map(line => ({ top: line * 20 }))
  }
  afterEach(() => { vi.restoreAllMocks() })
  const press = (key: string, text: string, at: number) => {
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: Element) { return rects(this) as unknown as DOMRectList })
    const el = document.createElement('textarea')
    el.value = text
    el.setSelectionRange(at, at)
    return historyDirection({ key }, { text, start: at, end: at }, edge => caretOnVisualEdge(el, edge))
  }
  const long = 'aaaaaaaaa bbbbbbbbb ccccccccc'
  it('recalls with Up only on the first visual line', () => {
    expect(press('ArrowUp', long, 4)).toBe(-1)
    expect(press('ArrowUp', long, 14)).toBeNull()
    expect(press('ArrowUp', `${long}\nnext`, 4)).toBe(-1)
  })
  it('recalls with Down only on the last visual line', () => {
    expect(press('ArrowDown', long, 24)).toBe(1)
    expect(press('ArrowDown', long, 14)).toBeNull()
    expect(press('ArrowDown', `first\n${long}`, 30)).toBe(1)
  })
})

describe('per-pane history storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })
  it('persists text without references, survives reloads, and isolates panes', async () => {
    const stored = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    })
    let api = await import('../app/composables/usePromptHistory')
    api.rememberPrompt('pane-a', '↳ Quote point : Continue? —\nYes')
    api.rememberPrompt('pane-a', '/compact')
    api.rememberPrompt('pane-b', 'Different agent')
    vi.resetModules()
    api = await import('../app/composables/usePromptHistory')
    expect(api.promptHistoryFor('pane-a')).toEqual(['Yes', '/compact'])
    expect(api.promptHistoryFor('pane-b')).toEqual(['Different agent'])
  })
  it('works in memory if browser storage fails', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('Unavailable') },
      setItem: () => { throw new Error('Full') },
    })
    const api = await import('../app/composables/usePromptHistory')
    api.rememberPrompt('pane-c', 'Remember this')
    expect(api.promptHistoryFor('pane-c')).toEqual(['Remember this'])
  })
  it('ignores malformed storage and limits loaded entries', async () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key.endsWith('bad') ? 'invalid JSON' : JSON.stringify([null, 1, ...Array.from({ length: 120 }, (_, n) => `Text ${n}`)]),
    })
    const api = await import('../app/composables/usePromptHistory')
    expect(api.promptHistoryFor('bad')).toEqual([])
    expect(api.promptHistoryFor('large')).toHaveLength(100)
    expect(api.promptHistoryFor('large')[0]).toBe('Text 20')
  })
})
