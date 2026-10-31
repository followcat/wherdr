// Alternate submission keys ("Send with <key>"): only verified agent keys are
// offered, under the context they were verified in (shared/submitKeys.ts).
import { describe, expect, it } from 'vitest'
import { defaultSubmitKey, isSubmitKey, possibleSubmitKey, submitKeysFor } from '../shared/submitKeys'

describe('submit keys: the verified terminators of each agent', () => {
  it('Codex takes Tab to queue a draft, only while it works', () => {
    expect(submitKeysFor('codex', { working: true })).toEqual(['tab'])
    expect(submitKeysFor('codex', { working: false })).toEqual([])
    expect(submitKeysFor('codex')).toEqual([])
    expect(isSubmitKey('codex', 'tab', { working: true })).toBe(true)
    expect(isSubmitKey('codex', 'tab', { working: false })).toBe(false)
  })

  it('Claude takes Ctrl+Enter idle and working — verified it submits, not flushes', () => {
    expect(submitKeysFor('claude', { working: true })).toEqual(['ctrl+enter'])
    expect(submitKeysFor('claude', { working: false })).toEqual(['ctrl+enter'])
    expect(isSubmitKey('claude', 'ctrl+enter', { working: false })).toBe(true)
  })

  it('Devin takes Ctrl+Enter idle and working — verified submit and queue', () => {
    expect(submitKeysFor('devin', { working: true })).toEqual(['ctrl+enter'])
    expect(submitKeysFor('devin', { working: false })).toEqual(['ctrl+enter'])
    expect(isSubmitKey('devin', 'ctrl+enter', { working: true })).toBe(true)
  })

  it('a working Devin defaults its sends to Ctrl+Enter — Enter would steer, not queue', () => {
    expect(defaultSubmitKey('devin', { working: true })).toBe('ctrl+enter')
    expect(defaultSubmitKey('devin', { working: false })).toBeUndefined()
    expect(defaultSubmitKey('devin')).toBeUndefined()
    expect(defaultSubmitKey('claude', { working: true })).toBeUndefined()
    expect(defaultSubmitKey('codex', { working: true })).toBeUndefined()
    expect(defaultSubmitKey(undefined, { working: true })).toBeUndefined()
  })

  it('agents without a verified key only have the implicit Enter', () => {
    for (const agent of ['omp', 'shell', undefined, null]) {
      expect(submitKeysFor(agent, { working: true })).toEqual([])
      expect(isSubmitKey(agent, 'tab', { working: true })).toBe(false)
      expect(isSubmitKey(agent, 'ctrl+enter', { working: true })).toBe(false)
    }
  })

  it('what a submission asks for is kept if any context could use it', () => {
    expect(possibleSubmitKey('codex', 'tab')).toBe(true)
    expect(possibleSubmitKey('devin', 'ctrl+enter')).toBe(true)
    expect(possibleSubmitKey('claude', 'ctrl+enter')).toBe(true)
    // Enter is the default submission everywhere, never an alternate.
    expect(possibleSubmitKey('codex', 'enter')).toBe(false)
    expect(possibleSubmitKey('claude', 'tab')).toBe(false)
    expect(possibleSubmitKey(undefined, 'tab')).toBe(false)
  })
})
