// omp's running step while it works, on real screens.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ompActivityOf, parseOmpActivity } from '../server/utils/ompActivity'

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

describe('parseOmpActivity', () => {
  it('reads the running step and the elapsed time of the turn', () => {
    expect(parseOmpActivity(fx('omp-working.txt'))).toEqual({ step: 'Sleeping first time', elapsed: 5 })
    expect(parseOmpActivity('\n  ⠧ Finding Fixed section          My session\n ⠧ 1h 2m 7s > ◒ Opus 5.5 > 📁 ~/demo\n╰─')).toEqual({ step: 'Finding Fixed section', elapsed: 3727 })
  })
  it('generic "Working…" before the first tool: no step, but the timer', () => {
    expect(parseOmpActivity(fx('omp-working-generic.txt'))).toEqual({ step: null, elapsed: 0 })
  })
  it('nothing once the turn is over, or far up in the conversation', () => {
    expect(parseOmpActivity(fx('omp-done.txt'))).toBeNull()
    expect(parseOmpActivity(fx('omp-idle-powerline.txt'))).toBeNull()
    expect(parseOmpActivity(['  ⎋ Old step', ...Array(20).fill('text'), ' ⠋ 3s > ◒ Opus 5.5'].join('\n'))).toEqual({ step: null, elapsed: 3 })
  })
  it('nerd and ascii symbol presets; an ascii spinner only above a timer', () => {
    expect(parseOmpActivity('\n  \u{F12B7} Sleeping first time          My session\n ⠹ 5s > Opus 5.5\n╰─')).toEqual({ step: 'Sleeping first time', elapsed: 5 })
    expect(parseOmpActivity('\n  Esc Sleeping first time          My session\n | 1m 5s > Opus 5.5\n╰─')).toEqual({ step: 'Sleeping first time', elapsed: 65 })
    expect(parseOmpActivity('Done:\n- first point\n- second point\n')).toBeNull()
  })
})

describe('ompActivityOf', () => {
  it('turns the elapsed time into a start time, stable from one reading to the next', () => {
    const a = ompActivityOf({ step: 'A', elapsed: 5 }, null, 10_000)!
    expect(a).toEqual({ step: 'A', since: 5_000 })
    expect(ompActivityOf({ step: 'B', elapsed: 6 }, a, 11_600)).toEqual({ step: 'B', since: 5_000 })
    expect(ompActivityOf({ step: 'B', elapsed: 1 }, a, 60_000)).toEqual({ step: 'B', since: 59_000 })
    expect(ompActivityOf(null, a)).toBeNull()
  })
})
