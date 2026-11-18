import { describe, expect, it } from 'vitest'
import { COLD_HISTORY, MAX_HISTORY, clampHistoryLines } from '../shared/terminalHistory'
import { coreMayHoldMore, restoreFromBottom, shouldFetchDeep, viewForRestore, type DeepFetchInput } from '../app/utils/terminalDeepHistory'

const ask = (over: Partial<DeepFetchInput> = {}): DeepFetchInput => ({
  atTop: true,
  covered: false,
  alternate: false,
  appTakesWheel: false,
  alreadyAsked: false,
  pending: false,
  scrollbackRows: 900,
  rows: 40,
  cold: COLD_HISTORY,
  ...over,
})

describe('the deep-fetch trigger', () => {
  it('fetches when the reader reaches the top of a full cold paint', () => {
    expect(shouldFetchDeep(ask())).toBe(true)
  })

  it('never fetches before the reader reaches the top', () => {
    expect(shouldFetchDeep(ask({ atTop: false }))).toBe(false)
  })

  it('never fetches while the replay is covered', () => {
    expect(shouldFetchDeep(ask({ covered: true }))).toBe(false)
  })

  it('never fetches on the alternate screen', () => {
    expect(shouldFetchDeep(ask({ alternate: true }))).toBe(false)
  })

  it('never fetches when the app takes the wheel', () => {
    expect(shouldFetchDeep(ask({ appTakesWheel: true }))).toBe(false)
  })

  it('fetches at most once per xterm', () => {
    expect(shouldFetchDeep(ask({ alreadyAsked: true }))).toBe(false)
    expect(shouldFetchDeep(ask({ pending: true }))).toBe(false)
  })

  it('does not fetch when the cold paint ended before its own amount', () => {
    // 60 rows delivered + a 40-row grid: the core had nothing older to give.
    expect(shouldFetchDeep(ask({ scrollbackRows: 60 }))).toBe(false)
    expect(coreMayHoldMore(60, 40, COLD_HISTORY)).toBe(false)
    expect(coreMayHoldMore(160, 40, COLD_HISTORY)).toBe(true)
    // A screen that is itself as tall as the request (a very tall grid).
    expect(coreMayHoldMore(0, 50, COLD_HISTORY)).toBe(false)
  })
})

describe('the viewport restore', () => {
  it('measures the reader row from the live tail, not in buffer coordinates', () => {
    // Window top at buffer row 880 of a 900-row tail's buffer.
    expect(restoreFromBottom(900, 880)).toBe(20)
    expect(restoreFromBottom(900, 900)).toBe(0)
  })

  it('puts the same distance from the new tail after the deep paint', () => {
    expect(viewForRestore(4800, 20)).toBe(4780)
    // The tail itself stays at the tail.
    expect(viewForRestore(4800, 0)).toBe(4800)
  })

  it('clamps a restore the new buffer is too short to hold', () => {
    expect(viewForRestore(10, 4000)).toBe(0)
    expect(restoreFromBottom(5, 2_000_000)).toBe(0)
  })
})

describe('clampHistoryLines', () => {
  it('clamps a request to what a viewer may hold', () => {
    expect(clampHistoryLines(5000)).toBe(MAX_HISTORY)
    expect(clampHistoryLines(99999)).toBe(MAX_HISTORY)
    expect(clampHistoryLines(3000)).toBe(3000)
    expect(clampHistoryLines(0)).toBe(0)
    expect(clampHistoryLines(12.7)).toBe(12)
  })

  it('refuses what is not a line count', () => {
    expect(clampHistoryLines(undefined)).toBeNull()
    expect(clampHistoryLines('x')).toBeNull()
    expect(clampHistoryLines(-1)).toBeNull()
    expect(clampHistoryLines(Number.NaN)).toBeNull()
    expect(clampHistoryLines(Number.POSITIVE_INFINITY)).toBeNull()
    expect(clampHistoryLines(null)).toBeNull()
  })
})
