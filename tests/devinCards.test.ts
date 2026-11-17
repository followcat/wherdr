// Devin's /usage, /context and /session-stats as cards in the conversation: the
// store reads the answer off the pane's screen after the send, keeps it in
// memory per pane, and places it among the transcript items (server/utils/devinCards.ts).
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createDevinCards } from '../server/utils/devinCards'
import { coreSend, type CoreInputDeps } from '../server/utils/coreInput'
import type { ChatItem, Pane } from '../shared/types'

const screen = (name: string) => readFileSync(new URL(`./fixtures/core-screens/${name}.txt`, import.meta.url), 'utf8')
// Before any command: no echo of the three commands on the screen.
const IDLE = readFileSync(new URL('./fixtures/devin-idle.txt', import.meta.url), 'utf8')
const T0 = Date.parse('2026-11-17T03:19:30Z')
const DEVIN = { id: 'w1:devin', agent: 'devin', coreAddress: 't1', workspace: 'w1' } as Pane
const at = (ms: number) => new Date(T0 + ms).toISOString()
const item = (role: ChatItem['role'], ms: number): ChatItem => ({ role, text: role, ts: at(ms) })

// A clock, and a pane whose screen follows what the test wrote into it.
function rig(screenNow: () => string) {
  let t = T0
  const reads: string[] = []
  const store = createDevinCards({
    read: async () => { const s = screenNow(); reads.push(s); return s },
    now: () => t,
    sleep: async (ms) => { t += ms },
    windowMs: 3000,
    step: 300,
  })
  return { store, reads }
}
const kept = (store: ReturnType<typeof createDevinCards>) => store.place(DEVIN.id, []).map(i => i.card!)

describe('a Devin command sent from wherdr', () => {
  it('is kept as a card once its block is on the screen, timed at the send', async () => {
    let written = 0
    const { store } = rig(() => (written ? screen('devin-usage-turn') : IDLE))
    const r = await store.sending(DEVIN, '/usage', async () => { written++; return { ok: true } })
    expect(r).toEqual({ ok: true })
    expect(store.place(DEVIN.id, [item('user', -2000), item('assistant', -1000)])).toEqual([
      item('user', -2000),
      item('assistant', -1000),
      {
        role: 'devinCard',
        text: expect.stringContaining('Daily 30% used'),
        ts: at(0),
        card: expect.objectContaining({ command: '/usage', kind: 'usage', windows: [{ label: 'Daily', percent: 30, reset: 'resets in 4h 39m' }, { label: 'Weekly', percent: 20, reset: 'resets Nov 22, 4:00 PM (UTC+8)' }] }),
      },
    ])
  })

  it('takes the newest echo of the command, not one already on the screen', async () => {
    let written = 0
    const screens = [IDLE, screen('devin-usage-fresh'), screen('devin-usage-twice')]
    const { store } = rig(() => screens[written]!)
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(kept(store).map(c => c.windows[0])).toEqual([{ label: 'Daily', percent: 29, reset: 'resets in 4h 41m' }, { label: 'Daily', percent: 32, reset: 'resets in 4h 36m' }])
  })

  it('keeps no card while the screen shows only the echo that was there before the send', async () => {
    const { store } = rig(() => screen('devin-usage-turn'))
    await store.sending(DEVIN, '/usage', async () => ({}))
    expect(kept(store)).toEqual([])
    expect(store.mark(DEVIN.id)).toBe('')
  })

  it('reads on while the block is still being written, then keeps it whole', async () => {
    let written = 0
    let partial = 1
    const partialScreen = '❭ /usage\n Usage\n Daily   ■■■■■■■■■■  30% used  · resets in 4h 39m\n'
    const { store } = rig(() => (!written ? IDLE : partial-- > 0 ? partialScreen : screen('devin-usage-turn')))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(kept(store)).toMatchObject([{ windows: [{ percent: 30 }, { percent: 20 }] }])
  })

  it('waits for the end of a block still being written, then keeps the whole card', async () => {
    let written = 0
    let reads = 0
    const full = screen('devin-context-turn')
    const cut = full.slice(0, full.indexOf(' ● Tools')) + ' ● Tools  ....▄▄▄'
    const { store } = rig(() => (written ? (reads++ === 0 ? cut : full) : IDLE))
    await store.sending(DEVIN, '/context', async () => { written++; return {} })
    expect(kept(store)).toMatchObject([{ kind: 'context', categories: [{ label: 'System prompt' }, { label: 'Tools' }, { label: 'Messages' }, { label: 'Free' }] }])
  })

  it('waits while only the echo is on the screen, its block not written yet', async () => {
    let written = 0
    let reads = 0
    const echoOnly = '❭ /usage\n⠸⠀ Thinking · 1s (esc twice to interrupt)\n'
    const { store } = rig(() => (written ? (reads++ === 0 ? echoOnly : screen('devin-usage-turn')) : IDLE))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(kept(store)).toMatchObject([{ kind: 'usage', windows: [{ percent: 30 }, { percent: 20 }] }])
  })

  it('keeps no card from a block still incomplete when its window ends', async () => {
    let written = 0
    const cut = '❭ /usage\n Usage\n Daily   ■■■■■■■■■■  30% used  · resets in 4h 39m\n'
    const { store } = rig(() => (written ? cut : IDLE))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(kept(store)).toEqual([])
  })

  it('gives up after its window with no card, and still returns the send result', async () => {
    const { store, reads } = rig(() => IDLE)
    expect(await store.sending(DEVIN, '/usage', async () => ({ ok: true }))).toEqual({ ok: true })
    expect(reads.length).toBeGreaterThan(2)
    expect(kept(store)).toEqual([])
  })

  it('keeps the sends of one pane apart: the second is read after the first is kept', async () => {
    let written = 0
    const screens = [IDLE, screen('devin-usage-turn'), screen('devin-usage-twice')]
    const { store } = rig(() => screens[written]!)
    await Promise.all([
      store.sending(DEVIN, '/usage', async () => { written++; return {} }),
      store.sending(DEVIN, '/usage', async () => { written++; return {} }),
    ])
    expect(kept(store).map(c => c.windows[0]!.percent)).toEqual([30, 32])
  })

  it('keeps the card of a command sent mid-turn when an older echo of it scrolls off the screen', async () => {
    let written = 0
    const before = [
      '❭ /context',
      ' Context usage  swe-2-max',
      ' ● System prompt  ▄▄▄▄....  5.8k   2%',
      ' ● Free           ....▄▄▄▄  248.6k  95%',
      ' ─────────────────────────────────',
      '   Total                      13.4k/262k   5%',
      '',
      ' ✓ find /usr/share/doc -type f',
      ' ✓ ls /usr/share/doc',
      ' ✓ wc -l',
      '⠸⠀ Thinking · 5s (esc twice to interrupt)',
      '─────────────────────────────────',
      '❭ Guide Devin while it works',
      '─────────────────────────────────',
      'SWE-2 Max',
    ].join('\n')
    // The turn printed on: the old echo is gone above the screen, the two tool lines stay.
    const after = [
      ' ✓ find /usr/share/doc -type f',
      ' ✓ ls /usr/share/doc',
      ' ✓ wc -l',
      ' ✓ head -5',
      '',
      '❭ /context',
      ' Context usage  swe-2-max',
      ' ● System prompt  ▄▄▄▄....  7.4k   3%',
      ' ● Free           ....▄▄▄▄  222.5k  85%',
      ' ─────────────────────────────────',
      '   Total                      39.5k/262k  15%',
      '',
      '⠸⠀ Thinking · 6s (esc twice to interrupt)',
      '─────────────────────────────────',
      '❭ Guide Devin while it works',
      '─────────────────────────────────',
      'SWE-2 Max',
    ].join('\n')
    const { store } = rig(() => (written ? after : before))
    await store.sending(DEVIN, '/context', async () => { written++; return {} })
    expect(kept(store)).toMatchObject([{ kind: 'context', total: { used: '39.5k', percent: 15 } }])
  })

  it('refuses a command while Devin waits on a dialog: its text and Enter would answer the dialog', async () => {
    const { store, reads } = rig(() => IDLE)
    const sent: string[] = []
    await expect(store.sending({ ...DEVIN, status: 'blocked' }, '/context', async () => { sent.push('send'); return {} })).rejects.toMatchObject({ code: 'blocked' })
    expect(sent).toEqual([])
    expect(reads).toEqual([])
  })

  it('leaves every other message alone: text other than the three commands, other agents', async () => {
    const { store, reads } = rig(() => screen('devin-usage-turn'))
    const calls: string[] = []
    await store.sending(DEVIN, 'hello', async () => { calls.push('hello'); return {} })
    await store.sending({ ...DEVIN, agent: 'claude' }, '/usage', async () => { calls.push('claude'); return {} })
    expect(calls).toEqual(['hello', 'claude'])
    expect(reads).toEqual([])
    expect(kept(store)).toEqual([])
  })

  it('is captured through coreSend, the path both the composer and the raw input use', async () => {
    let written = 0
    const screens = [IDLE, screen('devin-usage-turn')]
    const calls: string[] = []
    const store = createDevinCards({
      read: async () => { calls.push('read'); return screens[written]! },
      now: () => T0,
      sleep: async () => {},
      windowMs: 3000,
      step: 300,
    })
    const deps: CoreInputDeps = {
      call: async (method) => {
        calls.push(method)
        written++
        return { started: null } as never
      },
      pane: id => (id === DEVIN.id ? DEVIN : undefined),
      panes: () => [DEVIN],
      refresh: () => {},
      turnSettleMs: 0,
      settleMs: 0,
      card: store.sending,
    }
    await coreSend(deps, { pane_id: DEVIN.id, text: '/usage' })
    // Baseline, the send, then the block read twice: a block is kept once two reads agree.
    expect(calls).toEqual(['read', 'terminal.send', 'read', 'read'])
    expect(kept(store)).toMatchObject([{ command: '/usage', kind: 'usage' }])
    expect(kept(store)[0]).toMatchObject({ windows: [{ percent: 30 }, { percent: 20 }] })
  })
})

describe('the cards in the conversation', () => {
  it('sits after the items written before its send and before the ones written after', async () => {
    let written = 0
    const { store } = rig(() => (written ? screen('devin-usage-turn') : IDLE))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    const placed = store.place(DEVIN.id, [item('user', -2000), item('assistant', -1000), item('assistant', 5000)])
    expect(placed.map(i => i.role)).toEqual(['user', 'assistant', 'devinCard', 'assistant'])
  })

  it('is shown first when its window starts at the conversation root, sent before the first message', async () => {
    let written = 0
    const { store } = rig(() => (written ? screen('devin-usage-turn') : IDLE))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(store.place(DEVIN.id, [item('assistant', 60_000)], true).map(i => i.role)).toEqual(['devinCard', 'assistant'])
  })

  it('is not shown in a window that starts after its send', async () => {
    let written = 0
    const { store } = rig(() => (written ? screen('devin-usage-turn') : IDLE))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(store.place(DEVIN.id, [item('assistant', 60_000)]).map(i => i.role)).toEqual(['assistant'])
  })

  it('moves the mark when a card is kept, so an unchanged transcript is not answered as unchanged', async () => {
    let written = 0
    const screens = [IDLE, screen('devin-usage-turn'), screen('devin-usage-twice')]
    const { store } = rig(() => screens[written]!)
    expect(store.mark(DEVIN.id)).toBe('')
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    const first = store.mark(DEVIN.id)
    expect(first).not.toBe('')
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    expect(kept(store)).toHaveLength(2)
    expect(store.mark(DEVIN.id)).not.toBe(first)
  })

  it('goes when its pane is gone', async () => {
    let written = 0
    const { store } = rig(() => (written ? screen('devin-usage-turn') : IDLE))
    await store.sending(DEVIN, '/usage', async () => { written++; return {} })
    store.prune(new Set(['w1:other']))
    expect(store.place(DEVIN.id, [])).toEqual([])
    expect(store.mark(DEVIN.id)).toBe('')
  })
})
