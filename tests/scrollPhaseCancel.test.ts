import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScrollThrottle } from '../server/utils/scrollThrottle'
import { createTouchScrollPacer } from '../server/utils/touchScrollPacer'

afterEach(() => vi.useRealTimers())

describe('scroll throttle tagged contributions', () => {
  it('cancelTagged removes only that phase from a merged batch', () => {
    vi.useFakeTimers()
    const sent: object[] = []
    const t = createScrollThrottle((d, l) => sent.push({ d, l }), { intervalMs: 50 })
    t.push('up', 4, 'drag')
    t.push('up', 6, 'momentum')
    t.cancelTagged('momentum')
    vi.advanceTimersByTime(60)
    expect(sent).toEqual([{ d: 'up', l: 4 }])
  })
  it('cancelTagged with mixed directions only adjusts the net', () => {
    vi.useFakeTimers()
    const sent: object[] = []
    const t = createScrollThrottle((d, l) => sent.push({ d, l }), { intervalMs: 50 })
    t.push('up', 8, 'drag')
    t.push('down', 3, 'momentum')
    t.cancelTagged('momentum')
    vi.advanceTimersByTime(60)
    expect(sent).toEqual([{ d: 'up', l: 8 }])
  })
  it('cancelTagged is a no-op for an absent tag and after flush', () => {
    vi.useFakeTimers()
    const sent: object[] = []
    const t = createScrollThrottle((d, l) => sent.push({ d, l }), { intervalMs: 50 })
    t.cancelTagged('momentum')
    t.push('up', 4, 'drag')
    vi.advanceTimersByTime(60)
    t.cancelTagged('drag')
    t.push('up', 1, 'drag')
    vi.advanceTimersByTime(60)
    expect(sent).toEqual([{ d: 'up', l: 4 }, { d: 'up', l: 1 }])
  })
})

describe('pacer phase cancel', () => {
  it('cancelWhere drops matching queue items but keeps the rest in order', () => {
    vi.useFakeTimers()
    const sent: object[] = []
    const p = createTouchScrollPacer<{ phase: string }>((d, l, v) => sent.push({ d, l, phase: v?.phase }))
    p.push('up', 2, { phase: 'drag' }, 800)
    p.push('up', 3, { phase: 'momentum' }, 240)
    p.cancelWhere(v => v?.phase === 'momentum')
    vi.runAllTimers()
    expect(sent.every(s => s.phase === 'drag')).toBe(true)
    expect(sent.length).toBe(2)
  })
  it('cancelWhere on an empty queue and with no matches is harmless', () => {
    vi.useFakeTimers()
    const sent: object[] = []
    const p = createTouchScrollPacer<{ phase: string }>((d, l, v) => sent.push({ phase: v?.phase }))
    p.cancelWhere(() => true)
    p.push('up', 2, { phase: 'drag' })
    p.cancelWhere(v => v?.phase === 'other')
    vi.runAllTimers()
    expect(sent).toEqual([{ phase: 'drag' }, { phase: 'drag' }])
  })
})
