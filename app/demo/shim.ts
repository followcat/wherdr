// Network of the demo build: `fetch` and `WebSocket` are replaced before the
// app starts. /api/* and /ws/* are answered by the in-browser DemoServer; the
// demo's own static files (under the app base URL) load normally; every other
// request is refused. Nothing can reach a real wherdr server or another host.
import { DemoServer } from './server'
import { DEV_SERVER_SCREEN, SHELL_REFUSAL, agentScreen } from './terminal'
import { DEV_SERVER } from './scenario'

const enc = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
const frame = (s: string, cols: number, rows: number) => JSON.stringify({ type: 'terminal.frame', bytes: enc(s), width: cols, height: rows })

// Enough of the WebSocket interface for the app (on* handlers, send, close).
class DemoSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  binaryType: BinaryType = 'blob'
  protocol = ''
  extensions = ''
  bufferedAmount = 0
  onopen: ((e: Event) => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: ((e: CloseEvent) => void) | null = null
  onerror: ((e: Event) => void) | null = null
  private stop: (() => void) | null = null
  private receive: ((data: string) => void) | null = null

  constructor(readonly url: string, server: DemoServer) {
    super()
    const u = new URL(url)
    setTimeout(() => {
      if (this.readyState !== 0) return
      const route = u.pathname
      if (route !== '/ws/events' && route !== '/ws/term') return this.finish(1008)
      this.readyState = 1
      this.fire('open', new Event('open'))
      if (route === '/ws/events') this.events(server)
      else this.terminal(server, u.searchParams)
    }, 20)
  }

  private fire(type: 'open' | 'message' | 'close' | 'error', e: Event) {
    const handler = this[`on${type}`] as ((e: Event) => void) | null
    handler?.call(this, e)
    this.dispatchEvent(e)
  }

  private deliver(data: string) {
    if (this.readyState === 1) this.fire('message', new MessageEvent('message', { data }))
  }

  private events(server: DemoServer) {
    const sendState = () => this.deliver(JSON.stringify(server.state()))
    sendState()
    this.stop = server.onState(sendState)
    this.receive = (raw) => {
      try {
        const m = JSON.parse(raw)
        if (m?.type === 'viewing') server.setViewing(typeof m.pane === 'string' ? m.pane : null, Boolean(m.visible))
      } catch { /* not JSON */ }
    }
  }

  private terminal(server: DemoServer, q: URLSearchParams) {
    const id = q.get('pane') || ''
    const p = server.pane(id)
    let cols = Number(q.get('cols')) || 100
    let rows = Number(q.get('rows')) || 32
    if (!p) return this.finish(1008)
    if (id === DEV_SERVER) {
      let line = ''
      this.deliver(frame(DEV_SERVER_SCREEN, cols, rows))
      this.receive = (raw) => {
        const m = JSON.parse(raw)
        if (m?.type === 'terminal.resize' && m.cols && m.rows) {
          cols = m.cols
          rows = m.rows
          return this.deliver(frame(DEV_SERVER_SCREEN + line, cols, rows))
        }
        if (m?.type !== 'terminal.input' || typeof m.text !== 'string') return
        for (const ch of m.text as string) {
          if (ch === '\r') {
            this.deliver(frame(line.trim() ? SHELL_REFUSAL : '\r\n', cols, rows))
            line = ''
          } else if (ch === '\x7f') {
            if (line) this.deliver(frame('\b \b', cols, rows))
            line = line.slice(0, -1)
          } else if (ch >= ' ') {
            line += ch
            this.deliver(frame(ch, cols, rows))
          }
        }
      }
      return
    }
    let input = ''
    const draw = () => {
      const pane = server.pane(id)
      if (pane) {
        const interactive = server.interactiveScreen(id)
        this.deliver(frame(interactive ? `\x1b[2J\x1b[H${interactive.replace(/\n/g, '\r\n')}` : agentScreen(pane, server.chat(id), input, cols, rows), cols, rows))
      }
    }
    draw()
    const offState = server.onState(draw)
    const offChat = server.onChat(pane => { if (pane === id) draw() })
    this.stop = () => { offState(); offChat() }
    this.receive = (raw) => {
      let m: { type?: string, text?: string, cols?: number, rows?: number, keys?: string[] }
      try { m = JSON.parse(raw) }
      catch { return }
      if (m.type === 'terminal.resize' && m.cols && m.rows) {
        cols = m.cols
        rows = m.rows
        return draw()
      }
      if (m.type === 'keys' && server.terminalKeys(id, m.keys || [])) return
      if (m.type === 'keys' && m.keys?.includes('esc')) return void server.interrupt(id)
      const text = m.type === 'terminal.input' || m.type === 'paste' ? m.text || '' : ''
      if (server.interactiveScreen(id)) {
        server.terminalKeys(id, [...text].map(ch => ch === '\r' ? 'enter' : ch === '\x1b' ? 'esc' : ch))
        return
      }
      for (const ch of text) {
        if (ch === '\r') {
          if (input.trim()) server.prompt(id, input)
          input = ''
        } else if (ch === '\x7f') input = input.slice(0, -1)
        else if (ch === '\x1b') server.interrupt(id)
        else if (ch >= ' ') input += ch
      }
      draw()
    }
  }

  send(data: string) {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError')
    if (typeof data === 'string') this.receive?.(data)
  }

  close(code = 1000) {
    if (this.readyState >= 2) return
    this.readyState = 2
    setTimeout(() => this.finish(code), 0)
  }

  private finish(code: number) {
    this.stop?.()
    this.stop = null
    this.readyState = 3
    this.fire('close', new CloseEvent('close', { code, wasClean: code === 1000 }))
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// Installs the demo network. `base`: the app's base URL ("/demo/"), the only
// place real files are fetched from.
export function installDemoNetwork(base: string, server = new DemoServer()) {
  const realFetch = window.fetch.bind(window)
  const origin = location.origin
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : null
    const url = new URL(req ? req.url : String(input), location.href)
    const method = (init?.method || req?.method || 'GET').toUpperCase()
    init?.signal?.throwIfAborted()
    if (url.origin !== origin) throw new TypeError(`Blocked by the wherdr demo: ${url.origin}`)
    if (url.pathname.startsWith('/api/')) {
      let body: Record<string, unknown> = {}
      const raw = init?.body
      if (typeof raw === 'string') {
        try { body = JSON.parse(raw) }
        catch { /* not JSON */ }
      } else if (raw) {
        return json(403, { error: 'Demo — nothing runs here. Files are not uploaded anywhere.', code: 'demo' })
      }
      const r = server.handle(method, url.pathname + url.search, body)
      // A short delay, like a real round trip on a private network.
      const { promise, resolve } = Promise.withResolvers<void>()
      setTimeout(resolve, 60)
      await promise
      return json(r.status, r.body)
    }
    if (url.pathname.startsWith(base)) return realFetch(input, init)
    return json(404, { error: 'Not in the demo' })
  }
  window.WebSocket = class extends DemoSocket {
    constructor(url: string | URL) {
      super(String(url), server)
    }
  } as unknown as typeof WebSocket
  // A task's screenshots (<img src="/api/pm/shot?…">, never fetched): the made-up
  // images of the demo's own files (app/demo/public/shots).
  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    ...src,
    set(v: string) { src.set!.call(this, String(v).replace(/^\/api\/pm\/shot\?.*file=([\w.]+).*$/, `${base}shots/$1`)) },
  })
  // No service worker, push subscription or install prompt in the demo.
  if ('serviceWorker' in navigator) {
    Object.defineProperty(navigator.serviceWorker, 'register', { value: () => Promise.reject(new Error('No service worker in the demo')) })
  }
  return server
}
