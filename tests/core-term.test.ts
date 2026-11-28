import { describe, expect, it } from 'vitest'
import { FRAME, type FramedCore, type StreamHandler } from '../server/utils/coreFramed'
import { CoreError } from '../server/utils/core'
import { openCoreTerm } from '../server/utils/coreTerm'
import { COLD_HISTORY, MAX_HISTORY } from '../shared/terminalHistory'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(opts: { terminal?: object | null, attachError?: CoreError, watch?: boolean, attachGate?: Promise<void>, reattachGate?: Promise<void> } = {}) {
  const sent: { channel: number, kind: number, payload: Buffer }[] = []
  const calls: { method: string, params: any }[] = []
  const streams = new Map<number, StreamHandler>()
  let closeFn: (() => void) | null = null
  let closed = false
  // Each attach gets its own channel number, as the core's do: 3, 4…
  let nextChannel = 3
  let attaches = 0
  const core: FramedCore = {
    async call<T>(method: string, params: any = {}) {
      calls.push({ method, params })
      if (method === 'events.subscribe') return { channel: 2, terminals: opts.terminal === null ? [] : [{ address: 'm/t7', state: 'live', cols: 200, rows: 50, ...opts.terminal }] } as T
      if (method === 'terminal.attach') {
        // A re-attach (the second attach) can be held on its own gate: the
        // first must answer so the viewer has a channel to swap from.
        const n = attaches++
        if (n > 0 && opts.reattachGate) await opts.reattachGate
        else if (n === 0 && opts.attachGate) await opts.attachGate
        if (opts.attachError) throw opts.attachError
        return { channel: nextChannel++ } as T
      }
      return {} as T
    },
    send: (channel, kind, payload = Buffer.alloc(0)) => { sent.push({ channel, kind, payload }) },
    stream: (channel, handler) => { streams.set(channel, handler) },
    onClose: (fn) => { closeFn = fn },
    close: () => { closed = true },
  }
  const out: any[] = []
  // The options each frame was sent with (compress: false for a small one).
  const sentOpts: ({ compress?: boolean } | undefined)[] = []
  let wsClosed: number | undefined
  const ws = { send: (d: string, o?: { compress?: boolean }) => { out.push(JSON.parse(d)); sentOpts.push(o) }, close: (code?: number) => { wsClosed = code }, isOpen: () => wsClosed === undefined }
  const url = new URL(`http://x/ws/term?pane=p1&cols=40&rows=20${opts.watch ? '&takeover=0' : ''}`)
  const sess = openCoreTerm(ws, url, { endpoint: '/sock', address: id => (id === 'p1' ? 'm/t7' : null), connect: async () => core })
  return { sess: sess!, sent, calls, streams, out, sentOpts, wsClosed: () => wsClosed, closed: () => closed, lose: () => closeFn?.() }
}
const resizes = (sent: { kind: number, payload: Buffer }[]) => sent.filter(f => f.kind === FRAME.RESIZE).map(f => [f.payload.readUInt16LE(0), f.payload.readUInt16LE(2)])

describe('openCoreTerm', () => {
  it('a watch-only viewer attaches at the terminal size, by its full address, and only resizes once it takes control', async () => {
    const t = setup({ watch: true })
    await tick()
    expect(t.calls.map(c => c.method)).toEqual(['events.subscribe', 'terminal.attach'])
    expect(t.calls[0]!.params).toEqual({ terminal: 'm/t7' })
    expect(t.calls[1]!.params).toMatchObject({ terminal: 'm/t7', cols: 200, rows: 50 })
    expect(t.out).toContainEqual({ type: 'terminal.control', on: false })
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 60, rows: 30 }))
    expect(resizes(t.sent)).toEqual([])
    t.sess.onMessage(JSON.stringify({ type: 'terminal.input', text: 'ls\r' }))
    expect(resizes(t.sent)).toEqual([[60, 30]])
    const data = t.sent.filter(f => f.channel === 3 && f.kind === FRAME.DATA)
    expect(data.map(f => f.payload.toString())).toEqual(['ls\r'])
    expect(t.out).toContainEqual({ type: 'terminal.control', on: true })
    // Later fits follow while in control.
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 61, rows: 30 }))
    expect(resizes(t.sent)).toEqual([[60, 30], [61, 30]])
  })

  it('passes wheel reports to the program without taking control, and nothing else', async () => {
    const t = setup({ watch: true })
    await tick()
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 60, rows: 30 }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.wheel', text: '\x1b[<64;5;9M\x1b[<64;5;9M' }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.wheel', text: '\x1b[Ma%)' }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.wheel', text: '\x1b[<64;5;9Mrm -rf ~\r' }))
    const data = t.sent.filter(f => f.channel === 3 && f.kind === FRAME.DATA)
    expect(data.map(f => f.payload.toString('latin1'))).toEqual(['\x1b[<64;5;9M\x1b[<64;5;9M', '\x1b[Ma%)'])
    expect(resizes(t.sent)).toEqual([])
    expect(t.out).not.toContainEqual({ type: 'terminal.control', on: true })
  })

  it('fits the terminal to the screen on open, and gives control up when another viewer sets the size', async () => {
    const t = setup()
    await tick()
    // Attached at this screen's size: core paints at the final width, no resize after.
    expect(t.calls[1]!.params).toMatchObject({ terminal: 'm/t7', cols: 40, rows: 20 })
    expect(t.out.find(m => m.full)).toMatchObject({ type: 'terminal.frame', width: 40, height: 20 })
    expect(resizes(t.sent)).toEqual([])
    t.streams.get(2)!(FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'size', terminal: 'm/t7', data: { cols: 120, rows: 40 } } }) + '\n'))
    expect(t.out.at(-2)).toMatchObject({ type: 'terminal.frame', width: 120, height: 40, bytes: '' })
    expect(t.out.at(-1)).toEqual({ type: 'terminal.control', on: false })
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 50, rows: 20 }))
    expect(resizes(t.sent)).toEqual([])
    t.sess.onMessage(JSON.stringify({ type: 'take.control' }))
    expect(resizes(t.sent).at(-1)).toEqual([50, 20])
  })

  it('applies a fit that arrived while the attach was on its way', async () => {
    let release!: () => void
    const t = setup({ attachGate: new Promise<void>((resolve) => { release = resolve }) })
    await tick()
    expect(t.calls[1]!.params).toMatchObject({ cols: 40, rows: 20 })
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 47, rows: 30 }))
    expect(resizes(t.sent)).toEqual([])
    release()
    await tick()
    expect(resizes(t.sent)).toEqual([[47, 30]])
    t.streams.get(3)!(FRAME.DATA, Buffer.from('x'))
    expect(t.out.at(-1)).toMatchObject({ type: 'terminal.frame', width: 47, height: 30 })
  })

  it('fits on open, follows resizes, and yields to another viewer without a fight', async () => {
    const size = (cols: number, rows: number) => Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'size', terminal: 'm/t7', data: { cols, rows } } }) + '\n')
    const t = setup()
    await tick()
    expect(resizes(t.sent)).toEqual([])
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 60, rows: 30 }))
    expect(resizes(t.sent)).toEqual([[60, 30]])
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 70, rows: 30 }))
    expect(resizes(t.sent)).toEqual([[60, 30], [70, 30]])
    // The echo of our own size is not another viewer's.
    t.streams.get(2)!(FRAME.DATA, size(70, 30))
    expect(t.out.at(-1)).not.toEqual({ type: 'terminal.control', on: false })
    // Another viewer fits: this one follows and stops imposing its size.
    t.streams.get(2)!(FRAME.DATA, size(100, 40))
    expect(t.out.at(-1)).toEqual({ type: 'terminal.control', on: false })
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 71, rows: 30 }))
    expect(resizes(t.sent)).toHaveLength(2)
  })

  it('relays output with its credit and returns no more credit than was sent', async () => {
    const t = setup()
    await tick()
    t.streams.get(3)!(FRAME.DATA, Buffer.from('hello'))
    expect(t.out.at(-1)).toEqual({ type: 'terminal.frame', encoding: 'ansi', width: 40, height: 20, bytes: Buffer.from('hello').toString('base64'), credit: 5 })
    t.sess.onMessage(JSON.stringify({ type: 'credit', bytes: 1000 }))
    t.sess.onMessage(JSON.stringify({ type: 'credit', bytes: 5 }))
    const credits = t.sent.filter(f => f.channel === 3 && f.kind === FRAME.CREDIT)
    expect(credits.map(f => f.payload.readUInt32LE(0))).toEqual([5])
  })

  it('marks a keystroke echo not to be compressed, and a repaint to be', async () => {
    const t = setup()
    await tick()
    // The attach's own control and empty frame are small, like an echo.
    // A single character's echo, as the core sends after a key.
    t.streams.get(3)!(FRAME.DATA, Buffer.from('a'))
    const echoAt = t.out.length - 1
    // A repaint: a large, repetitive frame, well over the 1 KB threshold.
    t.streams.get(3)!(FRAME.DATA, Buffer.from('\x1b[H' + 'line of a redrawn footer\r\n'.repeat(200)))
    const repaintAt = t.out.length - 1
    const frames = t.out.filter(m => m.type === 'terminal.frame')
    // The echo: one byte, marked not to be compressed, with its credit.
    expect(t.out[echoAt]).toMatchObject({ type: 'terminal.frame', credit: 1 })
    expect(t.sentOpts[echoAt]).toEqual({ compress: false })
    // The repaint: over 1 KB, marked to be compressed.
    expect(t.out[repaintAt].credit).toBeGreaterThanOrEqual(1024)
    expect(t.sentOpts[repaintAt]).toEqual({ compress: true })
    // It is the only frame of this session zlib is asked for.
    expect(t.sentOpts.filter(o => o?.compress === true)).toHaveLength(1)
    expect(frames.length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the relay reset separate from an ANSI-only attach paint of an idle screen', async () => {
    const t = setup()
    await tick()
    const frames = () => t.out.filter(m => m.type === 'terminal.frame')
    expect(frames()).toEqual([{ type: 'terminal.frame', encoding: 'ansi', full: true, width: 40, height: 20, bytes: '' }])
    expect(t.out.at(-1)).toEqual({ type: 'terminal.control', on: true })
    // Core's first_paint always includes a parser reset and input-mode state,
    // even if the program has printed nothing and the screen is blank.
    const paint = Buffer.from('\x18\x1b[H\x1b[2J\x1b[?9001l')
    t.streams.get(3)!(FRAME.DATA, paint)
    expect(frames()).toHaveLength(2)
    expect(frames()[1]).toEqual({ type: 'terminal.frame', encoding: 'ansi', width: 40, height: 20, bytes: paint.toString('base64'), credit: paint.length })
    t.sess.onClose()
  })

  it('sends named keys through terminal.keys and rejects malformed ones', async () => {
    const t = setup()
    await tick()
    t.sess.onMessage(JSON.stringify({ type: 'keys', keys: ['esc'] }))
    t.sess.onMessage(JSON.stringify({ type: 'keys', keys: ['esc; rm'] }))
    await tick()
    expect(t.calls.filter(c => c.method === 'terminal.keys').map(c => c.params)).toEqual([{ terminal: 'm/t7', keys: ['esc'] }])
  })

  it('forwards canonical chords and refuses a batch containing an unnameable key', async () => {
    const t = setup()
    await tick()
    t.sess.onMessage(JSON.stringify({ type: 'keys', keys: ['ctrl+alt+shift+left', 'ctrl+backslash', 'alt+shift+a'] }))
    t.sess.onMessage(JSON.stringify({ type: 'keys', keys: ['ctrl+]', 'esc'] }))
    await tick()
    // One name outside the key grammar refuses the whole batch: Ctrl+],
    // Ctrl+^ and Ctrl+_ have no representable name and stay text on the client.
    expect(t.calls.filter(c => c.method === 'terminal.keys').map(c => c.params)).toEqual([{ terminal: 'm/t7', keys: ['ctrl+alt+shift+left', 'ctrl+backslash', 'alt+shift+a'] }])
  })

  it('closes with the exit reason, and detaches on client close', async () => {
    const t = setup()
    await tick()
    t.streams.get(3)!(FRAME.CLOSE, Buffer.from(JSON.stringify({ reason: 'exited', exit_code: 2 })))
    expect(t.out.at(-1)).toEqual({ type: 'terminal.closed', reason: 'The program exited (code 2)' })
    expect(t.wsClosed()).toBe(4000)
    const u = setup()
    await tick()
    u.sess.onClose()
    expect(u.sent.at(-1)).toMatchObject({ channel: 3, kind: FRAME.CLOSE })
    expect(u.closed()).toBe(true)
  })

  it('reports an ended terminal, an unknown pane and a lost core', async () => {
    const ended = setup({ terminal: { state: 'finished' } })
    await tick()
    expect(ended.out).toEqual([{ type: 'terminal.closed', reason: 'The terminal ended' }])
    const lost = setup()
    await tick()
    lost.lose()
    expect(lost.out.at(-1)).toEqual({ type: 'terminal.closed', reason: 'Lost the connection to herdr-core' })
    expect(lost.wsClosed()).toBe(4503)
    let code: number | undefined
    expect(openCoreTerm({ send: () => {}, close: c => { code = c }, isOpen: () => true }, new URL('http://x/?pane=nope'), { endpoint: '/s', address: () => null })).toBeNull()
    expect(code).toBe(4400)
  })

  it('queues input sent before the attach answers', async () => {
    const t = setup()
    t.sess.onMessage(JSON.stringify({ type: 'terminal.input', text: 'a' }))
    expect(t.sent).toEqual([])
    await tick()
    expect(t.sent.filter(f => f.kind === FRAME.DATA).map(f => f.payload.toString())).toEqual(['a'])
  })
})

// A cold open asks for a few screens; the deep history comes on demand, when
// the person scrolls back to the top (shared/terminalHistory.ts).
const attaches = (calls: { method: string, params: any }[]) => calls.filter(c => c.method === 'terminal.attach')
const history = (lines: number) => JSON.stringify({ type: 'terminal.history', lines })
const frames = (out: any[]) => out.filter(m => m.type === 'terminal.frame')

describe('terminal history', () => {
  it('a cold attach asks for the cold amount, control and watch-only alike', async () => {
    const t = setup()
    await tick()
    expect(attaches(t.calls)).toHaveLength(1)
    expect(attaches(t.calls)[0]!.params.history).toBe(COLD_HISTORY)
    const w = setup({ watch: true })
    await tick()
    expect(attaches(w.calls)[0]!.params.history).toBe(COLD_HISTORY)
  })

  it('terminal.history re-attaches on the same connection, with the requested lines', async () => {
    const t = setup()
    await tick()
    t.sess.onMessage(history(MAX_HISTORY))
    await tick()
    expect(attaches(t.calls).map(c => c.params)).toEqual([
      expect.objectContaining({ terminal: 'm/t7', history: COLD_HISTORY }),
      expect.objectContaining({ terminal: 'm/t7', history: MAX_HISTORY }),
    ])
    // The deep paint is a full repaint like any attach: the browser covers it.
    expect(frames(t.out).at(-1)).toEqual({ type: 'terminal.frame', encoding: 'ansi', full: true, width: 40, height: 20, bytes: '' })
  })

  it('clamps the requested lines to what a viewer may hold', async () => {
    const t = setup()
    await tick()
    t.sess.onMessage(history(99999))
    await tick()
    expect(attaches(t.calls)[1]!.params.history).toBe(MAX_HISTORY)
    t.sess.onMessage(history(3000))
    await tick()
    expect(attaches(t.calls)[2]!.params.history).toBe(3000)
  })

  it('detaches the old channel and keeps control and the size lease as they were', async () => {
    const t = setup()
    await tick()
    // Watching another viewer's size: control is off, the size is the core's.
    t.streams.get(2)!(FRAME.DATA, Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'size', terminal: 'm/t7', data: { cols: 120, rows: 40 } } }) + '\n'))
    expect(t.out.at(-1)).toEqual({ type: 'terminal.control', on: false })
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 41, rows: 20 }))
    const before = { frames: t.out.length, resizes: resizes(t.sent).length }
    t.sess.onMessage(history(MAX_HISTORY))
    await tick()
    // The old channel is closed, the new one attached at the current size…
    expect(t.sent.filter(f => f.channel === 3 && f.kind === FRAME.CLOSE)).toHaveLength(1)
    expect(attaches(t.calls)[1]!.params).toMatchObject({ cols: 120, rows: 40, history: MAX_HISTORY })
    // …without a resize, and with control re-stated at the value it already
    // had: the shared attach tail announces it, and it must not change.
    expect(resizes(t.sent)).toHaveLength(before.resizes)
    const control = t.out.slice(before.frames).filter(m => m.type === 'terminal.control')
    expect(control).toEqual([{ type: 'terminal.control', on: false }])
    expect(t.out.slice(before.frames)).not.toContainEqual({ type: 'terminal.control', on: true })
  })

  it('streams the new channel and drops stragglers from the detached one', async () => {
    const t = setup()
    await tick()
    const old = Math.max(...t.streams.keys())
    t.sess.onMessage(history(MAX_HISTORY))
    await tick()
    const fresh = Math.max(...t.streams.keys())
    expect(fresh).toBeGreaterThan(old)
    t.streams.get(fresh)!(FRAME.DATA, Buffer.from('deep'))
    expect(t.out.at(-1)).toMatchObject({ type: 'terminal.frame', bytes: Buffer.from('deep').toString('base64'), credit: 4 })
    const printed = frames(t.out).length
    // A frame the core had already queued on the old channel never reaches the
    // browser: the new attach owns the screen.
    t.streams.get(old)!(FRAME.DATA, Buffer.from('stale'))
    expect(frames(t.out)).toHaveLength(printed)
  })

  it('starts the new channel\'s credit from zero, so a late grant cannot over-credit it', async () => {
    const t = setup()
    await tick()
    t.streams.get(3)!(FRAME.DATA, Buffer.from('old'))
    expect(t.out.at(-1)).toMatchObject({ credit: 3 })
    t.sess.onMessage(history(MAX_HISTORY))
    await tick()
    // The old attach's unreturned credit died with its channel: a credit that
    // arrives now cannot grant the new channel bytes it never sent.
    const credits = () => t.sent.filter(f => f.kind === FRAME.CREDIT && f.channel > 2)
    const before = credits().length
    t.sess.onMessage(JSON.stringify({ type: 'credit', bytes: 4096 }))
    expect(credits()).toHaveLength(before)
  })

  it('an unknown or malformed message changes nothing', async () => {
    const t = setup()
    await tick()
    const attachCount = attaches(t.calls).length
    const before = t.out.length
    // The subscription's opening grant is the only frame sent so far.
    const sent = t.sent.length
    t.sess.onMessage(JSON.stringify({ type: 'terminal.history' }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.history', lines: 'x' }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.history', lines: -5 }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.scroll', lines: 10 }))
    t.sess.onMessage(JSON.stringify({ type: 'nope' }))
    t.sess.onMessage('not json')
    await tick()
    expect(attaches(t.calls)).toHaveLength(attachCount)
    expect(t.out).toHaveLength(before)
    expect(t.sent).toHaveLength(sent)
  })

  it('a history request during the first attach is ignored, not queued', async () => {
    let release!: () => void
    const t = setup({ attachGate: new Promise<void>((resolve) => { release = resolve }) })
    t.sess.onMessage(history(MAX_HISTORY))
    release()
    await tick()
    expect(attaches(t.calls).map(c => c.params.history)).toEqual([COLD_HISTORY])
  })

  it('input and a fit sent while the re-attach is on its way land on the new channel, in order', async () => {
    let release!: () => void
    const t = setup({ reattachGate: new Promise<void>((resolve) => { release = resolve }) })
    await tick()
    // The viewer is in control; its own size is what the terminal is at.
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 42, rows: 21 }))
    expect(resizes(t.sent)).toEqual([[42, 21]])
    t.sess.onMessage(history(MAX_HISTORY))
    await tick()
    // The deep fetch closed channel 3 and is waiting for channel 4.
    const pending = attaches(t.calls)[1]!
    expect(pending.params.history).toBe(MAX_HISTORY)
    // Typed now, while the re-attach is unanswered: a keystroke, a send and a
    // new fit. None may be lost or reach the detached channel.
    t.sess.onMessage(JSON.stringify({ type: 'terminal.input', text: 'a' }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.input', text: 'b' }))
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 44, rows: 22 }))
    expect(t.sent.filter(f => f.kind === FRAME.DATA)).toEqual([])
    release()
    await tick()
    // Everything queued reaches the new channel (4), in order and once each.
    const data = t.sent.filter(f => f.channel === 4 && f.kind === FRAME.DATA).map(f => f.payload.toString())
    expect(data).toEqual(['a', 'b'])
    expect(t.sent.filter(f => f.channel === 3 && f.kind === FRAME.DATA)).toEqual([])
    // The fit asked for during the swap is applied once the channel is back.
    expect(resizes(t.sent)).toEqual([[42, 21], [44, 22]])
    expect(t.sent.filter(f => f.channel === 4 && f.kind === FRAME.RESIZE)).toHaveLength(1)
  })

  it('a watching viewer\'s fit during the re-attach is kept as want, not sent', async () => {
    let release!: () => void
    const t = setup({ watch: true, reattachGate: new Promise<void>((resolve) => { release = resolve }) })
    await tick()
    t.sess.onMessage(history(MAX_HISTORY))
    await tick()
    t.sess.onMessage(JSON.stringify({ type: 'terminal.resize', cols: 70, rows: 30 }))
    release()
    await tick()
    // Control off: the size lease stays the other viewer's, nothing is sent.
    expect(resizes(t.sent)).toEqual([])
    t.sess.onMessage(JSON.stringify({ type: 'take.control' }))
    expect(resizes(t.sent).at(-1)).toEqual([70, 30])
  })
})
