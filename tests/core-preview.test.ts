import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { createCorePreviews, lastLine } from '../server/utils/corePreview'
import type { Pane } from '../shared/types'

const pane = (id: string, extra: Partial<Pane> = {}) => ({ id, workspace: 'w', coreAddress: `m/${id}`, agent: null, status: 'idle', ...extra }) as Pane
const settle = () => new Promise(r => setTimeout(r, 5))

describe('omp preview', () => {
  it('never shows omp\'s status line and context gauge as the card preview', async () => {
    const screen = 'Tests pass.\n ⠸ 4s > ⬢ Model > 🗑 ~/demo > ⑂ main ▶────100%──────╎───┃─────1M─\n╰─'
    const p = createCorePreviews({ reply: async () => null, read: async () => screen })
    p.apply([pane('o', { agent: 'omp', stateSeq: 1 })])
    await settle()
    const list = [pane('o', { agent: 'omp', stateSeq: 1 }), pane('s', { stateSeq: 1 })]
    p.apply(list)
    await settle()
    p.apply(list)
    expect(list[0]!.preview).toBe('Tests pass.')
    // Another terminal is read as before.
    expect(list[1]!.preview).toContain('100%')
  })
})

describe('lastLine', () => {
  it('skips Claude\'s duration line and shows the last answer', () => {
    const screen = readFileSync(new URL('./fixtures/claude-done-time.txt', import.meta.url), 'utf8')
    expect(lastLine(screen)).toBe('Hello, all good.')
    expect(lastLine('* Compiled for 3s ok')).toBe('* Compiled for 3s ok')
    expect(lastLine(readFileSync(new URL('./fixtures/claude-done.txt', import.meta.url), 'utf8'))).toBe("C'est fait : 12 tests verts.")
  })

  it('skips prompts, rules and blanks', () => {
    expect(lastLine('build ok\n\nuser@host:~/dir$ \n')).toBe('build ok')
    expect(lastLine('The build passes.\n────────\n❯\n')).toBe('The build passes.')
    expect(lastLine('user@host:~$')).toBeNull()
  })
  it('ignores drawings: braille logos and block elements', () => {
    expect(lastLine('⠈⠙⠛⠿⠿⠿⠿⠛⠉\n')).toBeNull()
    expect(lastLine('Ready to go\n  ⠈⠙⠛⠿⠿⠿⠿⠛⠉  \n ▀▀▀ ▄▄ \n')).toBe('Ready to go')
    expect(lastLine('Build ⠿ 3 files')).toBe('Build ⠿ 3 files')
  })
  it('ignores TUI footers', () => {
    expect(lastLine('Welcome back\n────\n❯\n────\n  ← for agents · ? for shortcuts')).toBe('Welcome back')
    expect(lastLine('Done\n  ⏵⏵ auto mode on (shift+tab to cycle)')).toBe('Done')
    expect(lastLine('Done\n  auto mode on (shift+tab to cycle)')).toBe('Done')
    expect(lastLine('Done\n  ? for shortcuts')).toBe('Done')
    expect(lastLine('Quick check\n Enter to confirm · Esc to cancel')).toBe('Quick check')
    expect(lastLine('← for agents · ? for shortcuts')).toBeNull()
    expect(lastLine('The shortcuts are listed below')).toBe('The shortcuts are listed below')
    expect(lastLine('x'.repeat(300))!.length).toBe(200)
  })
})

describe('core previews', () => {
  it('reads once per state, prefers the agent reply, falls back to the terminal line', async () => {
    const reads: string[] = []
    const p = createCorePreviews({ reply: async x => (x.agent ? { text: 'All done.' } : null), read: async a => { reads.push(a); return 'line one\nlast line\n' } })
    const panes = () => [pane('t1', { agent: 'claude', stateSeq: 1 }), pane('t2', { stateSeq: 1 })]
    let list = panes()
    p.apply(list)
    expect(list.map(x => x.preview)).toEqual([undefined, undefined])
    await settle()
    list = panes()
    p.apply(list)
    expect(list.map(x => x.preview)).toEqual(['All done.', 'last line'])
    await settle()
    expect(reads).toEqual(['m/t2'])
    // same state: nothing read again; a new status_ms: read again, old text kept meanwhile
    p.apply(panes())
    await settle()
    expect(reads).toHaveLength(1)
    list = [pane('t2', { stateSeq: 2 })]
    p.apply(list)
    expect(list[0]!.preview).toBe('last line')
    await settle()
    expect(reads).toHaveLength(2)
  })
  it('reads again while a new state settles, so a reply written after the switch to done shows', async () => {
    let t = 0
    let reply = 'Old reply.'
    const replies: string[] = []
    let wakes = 0
    const p = createCorePreviews({ now: () => t, reply: async () => { replies.push(reply); return { text: reply } }, read: async () => '', wake: () => { wakes++ } })
    const show = (stateSeq: number, status = 'done') => { const list = [pane('t1', { agent: 'claude', status, stateSeq } as Partial<Pane>)]; p.apply(list); return list[0]!.preview }
    show(1, 'working')
    await settle()
    // working -> done: read at once, but the conversation still ends on the old reply
    show(2)
    await settle()
    expect(replies).toHaveLength(2)
    reply = 'X'
    t = 1000
    show(2)
    await settle()
    expect(replies).toHaveLength(2) // too soon
    t = 2500
    expect(show(2)).toBe('Old reply.')
    await settle()
    expect(replies).toHaveLength(3)
    expect(wakes).toBeGreaterThan(0) // the new text asks for a new state
    expect(show(2)).toBe('X')
    // once settled, nothing is read again for the same state
    t = 20_000
    show(2)
    await settle()
    t = 30_000
    show(2)
    await settle()
    expect(replies.length).toBeLessThanOrEqual(5)
    const n = replies.length
    t = 40_000
    show(2)
    await settle()
    expect(replies).toHaveLength(n)
  })
  it('gets the new reply without any other poll: its own wake-ups drive the re-reads', async () => {
    vi.useFakeTimers()
    try {
      let reply = 'Old reply.'
      let reads = 0
      let current: Pane[] = []
      const p = createCorePreviews({ reply: async () => { reads++; return { text: reply } }, read: async () => '', wake: () => { current = [pane('t1', { agent: 'claude', status: 'done', stateSeq: 2 } as Partial<Pane>)]; p.apply(current) } })
      p.apply([pane('t1', { agent: 'claude', status: 'working', stateSeq: 1 } as Partial<Pane>)])
      await vi.advanceTimersByTimeAsync(10)
      // the switch to done is seen once; the reply reaches the file 3 s later
      current = [pane('t1', { agent: 'claude', status: 'done', stateSeq: 2 } as Partial<Pane>)]
      p.apply(current)
      await vi.advanceTimersByTimeAsync(3000)
      reply = 'X'
      await vi.advanceTimersByTimeAsync(2500)
      expect(current[0]!.preview).toBe('X')
      // settled: the wake-ups stop
      await vi.advanceTimersByTimeAsync(20_000)
      const n = reads
      await vi.advanceTimersByTimeAsync(20_000)
      expect(reads).toBe(n)
    } finally { vi.useRealTimers() }
  })
  it('limits the readings in flight and forgets gone panes', async () => {
    let active = 0, peak = 0
    const p = createCorePreviews({ reply: async () => null, read: async () => { peak = Math.max(peak, ++active); await settle(); active--; return 'x' } })
    p.apply(Array.from({ length: 10 }, (_, i) => pane(`t${i}`)))
    await settle()
    expect(peak).toBe(4)
    p.apply([])
  })
})
