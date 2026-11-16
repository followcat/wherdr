import { afterEach, describe, expect, it, vi } from 'vitest'
import { CHOICE_GUARD_MS, choicesArmed, compactMeta, compactOpen, createListShown } from '../app/utils/compactCard'

describe('compact list card', () => {
  it('several tabs: dots per tab, no pane count', () => {
    expect(compactMeta({ tabs: 3, panes: 5 })).toMatchObject({ dots: true, panes: null })
  })
  it('one tab with several panes: pane count instead of dots', () => {
    expect(compactMeta({ tabs: 1, panes: 2 })).toMatchObject({ dots: false, panes: 2 })
  })
  it('single pane: neither', () => {
    expect(compactMeta({ tabs: 1, panes: 1 })).toMatchObject({ dots: false, panes: null })
    expect(compactMeta({})).toMatchObject({ dots: false, panes: null })
  })
})

describe('compact card of a waiting agent', () => {
  it('opens on a question, the requested action or one-tap answers', () => {
    expect(compactOpen({ status: 'blocked', preview: 'Do you want to proceed?' })).toBe(true)
    expect(compactOpen({ status: 'blocked', detail: { tool: 'bash' } })).toBe(true)
    expect(compactOpen({ status: 'blocked', choices: 2 })).toBe(true)
  })
  it('stays one line when the agent is not waiting, whatever its preview', () => {
    for (const status of ['working', 'done', 'idle', 'unknown', undefined, null])
      expect(compactOpen({ status, preview: 'Last answer', choices: 2 })).toBe(false)
  })
  it('stays one line when a waiting agent has nothing to show', () => {
    expect(compactOpen({ status: 'blocked' })).toBe(false)
    expect(compactOpen({ status: 'blocked', preview: '', detail: null, choices: 0 })).toBe(false)
  })
})

describe('one-tap answers that just appeared', () => {
  it('ignore taps for about 400 ms, then take them', () => {
    expect(CHOICE_GUARD_MS).toBe(400)
    expect(choicesArmed(1000, 1000)).toBe(false)
    expect(choicesArmed(1000, 1399)).toBe(false)
    expect(choicesArmed(1000, 1400)).toBe(true)
    // Answers that were there before the page counted time.
    expect(choicesArmed(0, 5000)).toBe(true)
  })
})

describe('cards of a list that comes on screen', () => {
  afterEach(() => vi.useRealTimers())

  it('are just there; a card mounted later opens with the transition', () => {
    vi.useFakeTimers()
    const list = createListShown()
    // First render: every card mounts at once.
    expect(list.shown()).toBe(false)
    list.mount()
    list.mount()
    vi.advanceTimersByTime(999)
    expect(list.shown()).toBe(false)
    vi.advanceTimersByTime(1)
    expect(list.shown()).toBe(true)
    // A card that changes group: the others keep the list on screen.
    list.unmount()
    expect(list.shown()).toBe(true)
    list.mount()
    expect(list.shown()).toBe(true)
  })

  it('do not replay their opening each time the list comes back', () => {
    vi.useFakeTimers()
    const list = createListShown()
    list.mount()
    list.mount()
    vi.advanceTimersByTime(1000)
    expect(list.shown()).toBe(true)
    // A conversation opens on the phone: the list, and its cards, go.
    list.unmount()
    list.unmount()
    expect(list.shown()).toBe(false)
    // Back on the list: no transition for the cards that mount with it.
    list.mount()
    list.mount()
    expect(list.shown()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(list.shown()).toBe(true)
  })

  it('is not shown by a timer started before it left the screen', () => {
    vi.useFakeTimers()
    const list = createListShown()
    list.mount()
    vi.advanceTimersByTime(600)
    list.unmount()
    list.mount()
    vi.advanceTimersByTime(600)
    expect(list.shown()).toBe(false)
    vi.advanceTimersByTime(400)
    expect(list.shown()).toBe(true)
  })
})
