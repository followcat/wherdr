// The interactive-terminal overlay opens on 'terminal' sustained 500 ms —
// about one read at the viewed pace. A TUI redraws constantly, so any single
// read can lose the input field mid-paint (the quota footer, a rule) and
// classifyScreen falls through to 'terminal'. Publishing that one-off read
// flaps the overlay: open on the bad read, closed by the next good one. The
// pane's interaction must therefore publish 'terminal' only after two
// consecutive terminal reads; every other value publishes at once.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createCoreScreens } from '../server/utils/coreScreen'
import type { Pane } from '../shared/types'

const idle = readFileSync(new URL('./fixtures/core-screens/devin-idle.txt', import.meta.url), 'utf8')
// The same screen mid-redraw: the quota footer gone, confirmedInput fails.
const midRedraw = idle.replace(/\n[^\n]*Context:[^\n]*\n?$/, '')

const pane: Pane = { id: 'core:ta', workspace: 'w', tab: 'w:t', tabLabel: null, agent: 'devin', name: null, label: null, status: 'idle', title: null, cwd: null, agentSession: null, coreAddress: 'local/ta' }

function run(text: () => string) {
  let t = 0
  const s = createCoreScreens({ call: async () => ({ text: text() }), viewed: () => true, now: () => t })
  return async (ms: number) => { t = ms; const p: Pane = { ...pane }; await s.enrich([p]); return p }
}

describe('enrich: interaction hysteresis on terminal', () => {
  it('a single mid-redraw read does not open the terminal; two in a row do', async () => {
    let text = idle
    const at = run(() => text)
    expect((await at(0)).interaction).toBe('input')
    text = midRedraw
    expect((await at(1000)).interaction).toBe('input')
    expect((await at(2000)).interaction).toBe('terminal')
    // Back to input at once: the overlay can close on the next good read.
    text = idle
    expect((await at(3000)).interaction).toBe('input')
  })
  it('alternating redraw reads never publish terminal', async () => {
    let flip = false
    const at = run(() => (flip = !flip) ? midRedraw : idle)
    for (let t = 0; t <= 8000; t += 1000) expect((await at(t)).interaction).not.toBe('terminal')
  })
  it('a cached re-parse is not a second read: the streak follows the read', async () => {
    let text = idle
    const at = run(() => text)
    expect((await at(0)).interaction).toBe('input')
    // Past the startup window a viewed pane is read only when due.
    text = midRedraw
    expect((await at(40_000)).interaction).toBe('input')
    // Enrich passes over the same read must not advance the streak.
    expect((await at(40_100)).interaction).toBe('input')
    expect((await at(40_200)).interaction).toBe('input')
    // The confirmation read is due after 250 ms, sooner than the viewed pace.
    expect((await at(40_300)).interaction).toBe('terminal')
  })
  it('a working period resets the streak', async () => {
    let t = 0
    let status: Pane['status'] = 'idle'
    const s = createCoreScreens({ call: async () => ({ text: midRedraw }), viewed: () => true, now: () => t })
    const enr = async (ms: number) => { t = ms; const p: Pane = { ...pane, status }; await s.enrich([p]); return p }
    expect((await enr(0)).interaction).not.toBe('terminal')
    status = 'working'
    await enr(1000)
    status = 'idle'
    // After the work break the streak starts over: one read is still unconfirmed.
    expect((await enr(2000)).interaction).not.toBe('terminal')
    expect((await enr(3000)).interaction).toBe('terminal')
  })
  it('keeps the last published interaction while a terminal read is unconfirmed', async () => {
    let text = idle
    const at = run(() => text)
    expect((await at(0)).interaction).toBe('input')
    text = midRedraw
    // The pane object is rebuilt every poll: 'input' must come from the
    // screen module's memory, not the stale pane field.
    expect((await at(1000)).interaction).toBe('input')
  })
  it('asks for the confirmation read while a terminal observation is pending', async () => {
    let t = 0
    const wakes: number[] = []
    const s = createCoreScreens({ call: async () => ({ text: midRedraw }), viewed: () => true, now: () => t, wake: ms => wakes.push(ms) })
    const p: Pane = { ...pane }
    await s.enrich([p])
    expect(p.interaction).not.toBe('terminal')
    expect(wakes).toEqual([250])
    t = 1000
    const q: Pane = { ...pane }
    await s.enrich([q])
    expect(q.interaction).toBe('terminal')
    expect(wakes).toEqual([250])
  })
})
