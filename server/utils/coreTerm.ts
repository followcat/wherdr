// Terminal relay on herdr-core: one framed connection and one attach per viewer,
// so several viewers (phone, computer, herdr desktop) watch the same program.
// The browser keeps the legacy wire messages (terminal.frame, terminal.input…).
//
// Size: like v2, a viewer fits the terminal to its screen as soon as it opens
// (and follows its window resizes) while it is in control, so the program fills
// the width. When another viewer then sets another size, this one stops imposing
// its own until it types, presses a key or asks to take control again: the latest
// active viewer wins, and two viewers never resize each other in a loop.
// `takeover=0` opens a watch-only viewer that keeps the terminal's current size.
// Sizes set by others arrive as `size` events (events.subscribe), not by polling.
// core 0.1.17's `resize_notifications` is for `observe` attaches only, which can
// never type: these viewers type, so they do not ask for it.
// Flow control: core grants 256 KiB; the browser returns credit after xterm has
// written the bytes, so the WebSocket queue stays bounded by that window.
import { CoreError } from './core'
import { FRAME, openFramed, type FramedCore } from './coreFramed'
import type { TermSession, WsLike } from './terminal'

const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number.parseInt(String(v), 10)
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt
}
const HISTORY = 1000
const WINDOW = 256 * 1024
// Never more than one credit window in flight, plus the first paint.
const MAX_OUTSTANDING = 8 * 1024 * 1024
const KEY_RE = /^[a-z0-9+\-]{1,24}$/i

interface CoreTermDeps {
  endpoint: string | undefined
  address: (pane: string) => string | null | undefined
  connect?: (endpoint: string) => Promise<FramedCore>
  log?: (msg: string) => void
}
interface Size { cols: number, rows: number }
interface Snapshot { channel: number, terminals?: { address: string, state: string, cols: number, rows: number }[] }

const closedText = (why: { reason?: string, exit_code?: number | null } | null) =>
  why?.reason === 'exited' ? `The program exited${typeof why.exit_code === 'number' ? ` (code ${why.exit_code})` : ''}`
    : why?.reason === 'killed' ? 'The program was stopped'
      : why?.reason ? `The terminal ended (${why.reason})` : 'The terminal ended'

export function openCoreTerm(ws: WsLike, url: URL, deps: CoreTermDeps): TermSession | null {
  const pane = url.searchParams.get('pane') || ''
  const address = deps.address(pane)
  if (!address) {
    ws.close(4400, 'Invalid pane')
    return null
  }
  const send = (obj: unknown) => { if (ws.isOpen()) ws.send(JSON.stringify(obj)) }
  const end = (reason: string, code: number, wsReason: string, extra: object = {}) => {
    if (done) return
    done = true
    send({ type: 'terminal.closed', reason, ...extra })
    ws.close(code, wsReason)
    core?.close()
  }
  if (!deps.endpoint) {
    send({ type: 'terminal.closed', reason: 'herdr-core is not configured' })
    ws.close(4503, 'core unavailable')
    return null
  }

  let want: Size = { cols: clamp(url.searchParams.get('cols'), 10, 400, 80), rows: clamp(url.searchParams.get('rows'), 5, 200, 24) }
  let size: Size | null = null
  // Whether this viewer imposes its size (see the header).
  let control = url.searchParams.get('takeover') !== '0'
  let core: FramedCore | null = null
  let channel = -1
  let done = false
  let outstanding = 0
  // Input before the attach answers: delivered after it, in order.
  const early: (() => void)[] = []

  const resize = (s: Size) => {
    if (channel < 0 || !core) return
    const p = Buffer.alloc(4)
    p.writeUInt16LE(s.cols, 0)
    p.writeUInt16LE(s.rows, 2)
    core.send(channel, FRAME.RESIZE, p)
    size = s
    // A zero-byte frame resizes the browser's xterm before the repaint arrives.
    send({ type: 'terminal.frame', encoding: 'ansi', width: s.cols, height: s.rows, bytes: '' })
  }
  // Tells the browser whether its size is the one shown (it offers to fit otherwise).
  const announce = () => send({ type: 'terminal.control', on: control })
  const takeControl = () => {
    if (control && size?.cols === want.cols && size.rows === want.rows) return
    control = true
    resize(want)
    announce()
  }
  const input = (bytes: Buffer) => {
    const go = () => {
      if (!core || channel < 0 || !bytes.length) return
      takeControl()
      core.send(channel, FRAME.DATA, bytes)
    }
    if (channel < 0) { if (early.length < 64) early.push(go) }
    else go()
  }
  const keys = (list: string[]) => {
    const go = () => {
      takeControl()
      core?.call('terminal.keys', { terminal: address, keys: list }, 10000)
        .catch((e: CoreError) => send({ type: 'web.error', code: e.kind, message: e.message }))
    }
    if (channel < 0) { if (early.length < 64) early.push(go) }
    else go()
  }

  const onEvent = (payload: Buffer) => {
    for (const line of payload.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      let m: { method?: string, params?: { type?: string, terminal?: string, data?: { cols?: number, rows?: number } } }
      try { m = JSON.parse(line) }
      catch { continue }
      const d = m.params?.data
      if (m.method !== 'event' || m.params?.type !== 'size' || !d || !Number.isInteger(d.cols) || !Number.isInteger(d.rows)) continue
      const next = { cols: d.cols!, rows: d.rows! }
      if (size && next.cols === size.cols && next.rows === size.rows) continue
      // Another viewer set this size: follow it, and stop imposing ours until we type.
      control = false
      size = next
      send({ type: 'terminal.frame', encoding: 'ansi', width: next.cols, height: next.rows, bytes: '' })
      announce()
    }
  }

  async function start() {
    try {
      core = await (deps.connect ?? openFramed)(deps.endpoint!)
      if (done) return core.close()
      core.onClose(() => end('Lost the connection to herdr-core', 4503, 'core disconnected'))
      const sub = await core.call<Snapshot>('events.subscribe', { terminal: address })
      const t = sub.terminals?.find(x => x.address === address) ?? sub.terminals?.[0]
      if (!t || t.state !== 'live') return end(closedText(null), 4000, 'terminal ended')
      core.stream(sub.channel, (kind, payload) => {
        if (kind !== FRAME.DATA) return
        core?.send(sub.channel, FRAME.CREDIT, u32(payload.length))
        onEvent(payload)
      })
      core.send(sub.channel, FRAME.CREDIT, u32(1024 * 1024))
      // A viewer in control attaches at its own size, which resizes the terminal
      // first: core's paint ends wrapped lines with hard newlines, so a paint
      // drawn at another width would not reflow to this one in xterm.
      size = control ? want : { cols: t.cols || want.cols, rows: t.rows || want.rows }
      const attached = await core.call<{ channel: number }>('terminal.attach', { terminal: address, cols: size.cols, rows: size.rows, history: HISTORY })
      if (done) return
      channel = attached.channel
      send({ type: 'web.capabilities', mouse: false, core: true })
      send({ type: 'terminal.frame', encoding: 'ansi', full: true, width: size.cols, height: size.rows, bytes: '' })
      core.stream(channel, (kind, payload) => {
        if (kind === FRAME.DATA) {
          outstanding += payload.length
          if (outstanding > MAX_OUTSTANDING) return end('The terminal viewer fell behind', 4500, 'backpressure')
          send({ type: 'terminal.frame', encoding: 'ansi', width: size!.cols, height: size!.rows, bytes: payload.toString('base64'), credit: payload.length })
        } else if (kind === FRAME.CLOSE) {
          let why = null
          try { why = payload.length ? JSON.parse(payload.toString('utf8')) : null }
          catch { /* reason unreadable */ }
          end(closedText(why), 4000, 'terminal ended')
        }
      })
      announce()
      for (const go of early.splice(0)) go()
    } catch (e) {
      const err = e instanceof CoreError ? e : new CoreError('protocol', 'Invalid response from herdr-core')
      deps.log?.(`core term ${address}: ${err.kind}`)
      if (err.kind === 'not_found') end(closedText(null), 4000, 'terminal ended')
      else end(err.kind === 'unavailable' || err.kind === 'disconnected' ? 'herdr-core is unreachable' : err.message, 4503, 'core unavailable')
    }
  }
  void start()

  return {
    onMessage(raw: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let m: any
      try { m = JSON.parse(raw) }
      catch { return }
      switch (m?.type) {
        case 'ping':
          send({ type: 'pong' })
          break
        case 'credit': {
          const n = clamp(m.bytes, 0, WINDOW * 64, 0)
          const back = Math.min(n, outstanding)
          if (back > 0 && core && channel >= 0) {
            outstanding -= back
            core.send(channel, FRAME.CREDIT, u32(back))
          }
          break
        }
        case 'terminal.input':
          if (typeof m.text === 'string' && m.text.length <= 65536) input(Buffer.from(m.text, 'utf8'))
          else if (typeof m.bytes === 'string' && m.bytes.length <= 90000) input(Buffer.from(m.bytes, 'base64'))
          break
        // A pasted file path: typed as text (xterm already brackets real pastes).
        case 'paste':
          if (typeof m.text === 'string' && m.text && m.text.length <= 65536) input(Buffer.from(m.text, 'utf8'))
          break
        case 'keys':
          if (Array.isArray(m.keys) && m.keys.length && m.keys.length <= 32 && m.keys.every((k: unknown) => typeof k === 'string' && KEY_RE.test(k))) keys(m.keys)
          break
        case 'take.control':
          if (channel >= 0) takeControl()
          break
        case 'terminal.resize':
          want = { cols: clamp(m.cols, 10, 400, want.cols), rows: clamp(m.rows, 5, 200, want.rows) }
          if (control && (want.cols !== size?.cols || want.rows !== size?.rows)) resize(want)
          break
        // Scrolling happens in the browser (history comes with the attach);
        // mouse reporting and visibility have no core equivalent here.
      }
    },
    onClose() {
      done = true
      if (core && channel >= 0) core.send(channel, FRAME.CLOSE)
      core?.close()
    },
  }
}

function u32(n: number) {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(n >>> 0, 0)
  return b
}
