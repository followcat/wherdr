import { afterEach, expect, it, vi } from 'vitest'
import { getEventListeners } from 'node:events'
import { chatHoverIntent, chatIntentKey, createChatIntentCache, withDeadline } from '../app/utils/chatIntent'
import type { ChatResponse, Pane } from '../shared/types'

const response: ChatResponse = { available: true, file: 'fixture.jsonl', token: 'v1', start: 4096, items: [] }
afterEach(() => vi.useRealTimers())
it('waits 65ms for a mouse, cancels on leave/unmount/context menu, and ignores touch hover', () => {
  vi.useFakeTimers()
  const run = vi.fn()
  const intent = chatHoverIntent(run)
  intent.enter('mouse')
  vi.advanceTimersByTime(64)
  expect(run).not.toHaveBeenCalled()
  intent.cancel()
  vi.advanceTimersByTime(100)
  expect(run).not.toHaveBeenCalled()
  intent.enter('touch')
  vi.advanceTimersByTime(100)
  expect(run).not.toHaveBeenCalled()
  intent.enter('mouse')
  vi.advanceTimersByTime(65)
  expect(run).toHaveBeenCalledTimes(1)
  intent.enter('mouse')
  intent.down()
  vi.advanceTimersByTime(100)
  expect(run).toHaveBeenCalledTimes(2)
})
it('deduplicates intent and hands an in-flight tail to opening once', async () => {
  let resolve!: (r: ChatResponse) => void
  const read = vi.fn(() => new Promise<ChatResponse>(r => { resolve = r }))
  const cache = createChatIntentCache(read)
  cache.preload('a', 'pane')
  cache.preload('a', 'pane')
  const opening = cache.take('a')
  resolve(response)
  expect(await opening).toBe(response)
  expect(await cache.take('a')).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(1)
})
it('isolates machine, Herdr session, pane and agent session', () => {
  const pane = { id: 'w1:p1', machine: 'demo', agentSession: 'first' } as Pane
  const original = chatIntentKey(pane, 'main')
  for (const change of [{ machine: 'other' }, { id: 'w1:p2' }, { agentSession: 'next' }, { bornAt: 1 }]) {
    expect(chatIntentKey({ ...pane, ...change }, 'main')).not.toBe(original)
  }
  expect(chatIntentKey(pane, 'other')).not.toBe(original)
})
it('expires, caps entries and bytes, and rejects failures', async () => {
  vi.useFakeTimers()
  const read = vi.fn(async () => response)
  const cache = createChatIntentCache(read)
  for (let i = 0; i < 5; i++) cache.preload(String(i), 'pane')
  expect(await cache.take('0')).toBeUndefined()
  expect(await cache.take('4')).toBe(response)
  vi.advanceTimersByTime(5001)
  expect(await cache.take('3')).toBeUndefined()
  const large = createChatIntentCache(async () => ({ ...response, token: 'x'.repeat(500_001) }))
  large.preload('large', 'pane')
  expect(await large.take('large')).toBeUndefined()
  const failed = createChatIntentCache(async () => { throw new Error('offline') })
  failed.preload('failed', 'pane')
  expect(await failed.take('failed')).toBeUndefined()
})
it('invalidates in-flight reads on lock, disconnect or session change', async () => {
  let resolve!: (r: ChatResponse) => void
  let signal!: AbortSignal
  const cache = createChatIntentCache(async (_, s) => {
    signal = s
    return new Promise<ChatResponse>(r => { resolve = r })
  })
  cache.preload('a', 'pane')
  const opening = cache.take('a')
  cache.clear()
  expect(signal.aborted).toBe(true)
  resolve(response)
  expect(await opening).toBeUndefined()
})
it('a reader that throws at once drops its entry instead of throwing to the card', async () => {
  // A card's pointerdown runs preload before the long press starts: a throw
  // here would leave the card without its long-press menu.
  const read = vi.fn<() => Promise<ChatResponse>>().mockImplementationOnce(() => { throw new TypeError('AbortSignal.any is not a function') })
    .mockResolvedValue(response)
  const cache = createChatIntentCache(read)
  expect(() => cache.preload('a', 'pane')).not.toThrow()
  expect(await cache.take('a')).toBeUndefined()
  cache.preload('a', 'pane')
  expect(await cache.take('a')).toBe(response)
})
it('builds the read deadline without AbortSignal.any (Safari before 17.4, iOS 16.4 is supported)', () => {
  vi.useFakeTimers()
  const any = AbortSignal.any
  // @ts-expect-error -- simulate an engine without AbortSignal.any
  AbortSignal.any = undefined
  try {
    const caller = new AbortController()
    const cancelled = withDeadline(caller.signal, 8000)
    expect(cancelled.aborted).toBe(false)
    caller.abort()
    expect(cancelled.aborted).toBe(true)

    const timed = withDeadline(new AbortController().signal, 8000)
    vi.advanceTimersByTime(7999)
    expect(timed.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(timed.aborted).toBe(true)
    expect((timed.reason as DOMException).name).toBe('TimeoutError')

    const early = new AbortController()
    early.abort()
    expect(withDeadline(early.signal, 8000).aborted).toBe(true)
  }
  finally { AbortSignal.any = any }
})
it('uses AbortSignal.any where it exists', () => {
  const caller = new AbortController()
  const s = withDeadline(caller.signal, 8000)
  caller.abort()
  expect(s.aborted).toBe(true)
})

it('releases a settled speculative read\'s fallback deadline while keeping its cached result', async () => {
  vi.useFakeTimers()
  const any = AbortSignal.any
  // @ts-expect-error -- simulate Safari before AbortSignal.any
  AbortSignal.any = undefined
  let caller!: AbortSignal
  try {
    const cache = createChatIntentCache(async (_pane, signal) => {
      caller = signal
      withDeadline(signal, 8000)
      return response
    })
    cache.preload('a', 'pane')
    expect(vi.getTimerCount()).toBe(1)
    expect(getEventListeners(caller, 'abort')).toHaveLength(1)
    expect(await cache.take('a')).toBe(response)
    expect(vi.getTimerCount()).toBe(0)
    expect(getEventListeners(caller, 'abort')).toHaveLength(0)
  } finally { AbortSignal.any = any }
})
