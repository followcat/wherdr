import { describe, expect, it } from 'vitest'
import { FRAME, type FramedCore, type StreamHandler } from '../server/utils/coreFramed'
import { CoreError } from '../server/utils/core'
import { openCoreTerm } from '../server/utils/coreTerm'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function setup(opts: { terminal?: object | null, attachError?: CoreError, watch?: boolean, attachGate?: Promise<void> } = {}) {
  const sent: { channel: number, kind: number, payload: Buffer }[] = []
  const calls: { method: string, params: any }[] = []
  const streams = new Map<number, StreamHandler>()
  let closeFn: (() => void) | null = null
  let closed = false
  const core: FramedCore = {
    async call<T>(method: string, params: any = {}) {
      calls.push({ method, params })
      if (method === 'events.subscribe') return { channel: 2, terminals: opts.terminal === null ? [] : [{ address: 'm/t7', state: 'live', cols: 200, rows: 50, ...opts.terminal }] } as T
      if (method === 'terminal.attach') { await opts.attachGate; if (opts.attachError) throw opts.attachError; return { channel: 3 } as T }
      return {} as T
    },
    send: (channel, kind, payload = Buffer.alloc(0)) => { sent.push({ channel, kind, payload }) },
    stream: (channel, handler) => { streams.set(channel, handler) },
    onClose: (fn) => { closeFn = fn },
    close: () => { closed = true },
  }
  const out: any[] = []
  let wsClosed: number | undefined
  const ws = { send: (d: string) => out.push(JSON.parse(d)), close: (code?: number) => { wsClosed = code }, isOpen: () => wsClosed === undefined }
  const url = new URL(`http://x/ws/term?pane=p1&cols=40&rows=20${opts.watch ? '&takeover=0' : ''}`)
  const sess = openCoreTerm(ws, url, { endpoint: '/sock', address: id => (id === 'p1' ? 'm/t7' : null), connect: async () => core })
  return { sess: sess!, sent, calls, streams, out, wsClosed: () => wsClosed, closed: () => closed, lose: () => closeFn?.() }
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
