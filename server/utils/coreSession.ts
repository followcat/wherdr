import { createConnection, type Socket } from 'node:net'
import { applyCoreEvent, liveTerminals, type CoreEvent, type CoreTerminals } from '../../shared/coreEvents'
import type { CoreTerminal } from '../../shared/coreInventory'

// One durable `events.subscribe` connection to herdr-core (like Shepherdr's CoreSession):
// a snapshot, then numbered events. A gap in `seq`, a `missed` event or silence for
// longer than the watchdog (core sends a heartbeat every 15 s) reconnects with a new
// snapshot; reconnects back off from 250 ms to 30 s. Never retries an incompatible core.
// Core sends `missed` with every terminal as of its `seq` when it resyncs a machine
// (e.g. a remote core restarted): that list replaces the held one.
export interface CoreSessionOptions {
  endpoint: string
  watchdogMs?: number
  connect?: (endpoint: string) => Socket
  // A live event, with the terminal before and after it. Not called for snapshots.
  onEvent?: (event: CoreEvent, before: CoreTerminal | undefined, after: CoreTerminal | undefined) => void
  // The held terminals changed (snapshot or event); `doc`: a shared document changed.
  onChange?: (what: 'terminal' | 'doc' | 'snapshot') => void
  onStatus?: (connected: boolean) => void
}
interface Resync { resync: true; seq: number; terminals: CoreTerminal[] }
const MAX_LINE = 16 * 1024 * 1024
const MAX_BUFFER = 4096

export class CoreSession {
  private terminals: CoreTerminals = new Map()
  private socket: Socket | null = null
  private ready = false
  private stopped = false
  private delay = 250
  private retry: ReturnType<typeof setTimeout> | null = null
  private dog: ReturnType<typeof setTimeout> | null = null
  constructor(private opts: CoreSessionOptions) {}

  /** The terminals of the last snapshot plus the events since, or null before the first snapshot. */
  snapshot(): CoreTerminal[] | null { return this.ready ? [...this.terminals.values()] : null }
  get(address: string): CoreTerminal | undefined { return this.ready ? this.terminals.get(address) : undefined }
  get connected() { return this.ready }

  start() {
    this.stopped = false
    this.open()
  }
  stop() {
    this.stopped = true
    if (this.retry) clearTimeout(this.retry)
    this.drop()
  }

  private drop() {
    if (this.dog) clearTimeout(this.dog)
    this.socket?.destroy()
    this.socket = null
    if (this.ready) { this.ready = false; this.opts.onStatus?.(false) }
  }
  private reconnect(permanent = false) {
    this.drop()
    if (this.stopped || permanent) return
    const wait = this.delay
    this.delay = Math.min(this.delay * 2, 30000)
    this.retry = setTimeout(() => this.open(), wait)
    this.retry.unref?.()
  }
  private watch(socket: Socket) {
    if (this.dog) clearTimeout(this.dog)
    this.dog = setTimeout(() => { if (this.socket === socket) this.reconnect() }, this.opts.watchdogMs ?? 45000)
    this.dog.unref?.()
  }

  private open() {
    if (this.stopped) return
    const socket = (this.opts.connect ?? createConnection)(this.opts.endpoint)
    this.socket = socket
    let buf = ''
    let snapshotSeq: number | null = null
    let last = 0
    const queue: (CoreEvent | Resync)[] = []
    const fresh = () => this.socket === socket
    this.watch(socket)
    const resync = ({ seq, terminals }: Resync) => {
      if (seq < last) return // we already hold newer facts (a snapshot taken after it)
      last = seq
      this.terminals = liveTerminals(terminals)
      this.opts.onChange?.('snapshot')
    }
    const live = (event: CoreEvent | Resync) => {
      if ('resync' in event) return resync(event)
      if (typeof event.seq === 'number') {
        if (event.seq <= last) return // already in the snapshot
        if (event.seq !== last + 1) return this.reconnect() // a gap: take a new snapshot
        last = event.seq
      }
      if (event.type === 'missed') return this.reconnect()
      if (event.type === 'heartbeat') return
      const before = event.terminal ? this.terminals.get(event.terminal) : undefined
      const what = applyCoreEvent(this.terminals, event)
      if (!what) return
      this.opts.onEvent?.(event, before, event.terminal ? this.terminals.get(event.terminal) : undefined)
      this.opts.onChange?.(what)
    }
    const line = (text: string) => {
      let m: { id?: number; method?: string; params?: CoreEvent & { terminals?: CoreTerminal[] }; result?: { seq?: number; terminals?: CoreTerminal[] }; error?: { data?: { kind?: string } } }
      try { m = JSON.parse(text) } catch { return this.reconnect() }
      if (m.id === 1) {
        if (m.error) return this.reconnect(m.error.data?.kind === 'unsupported_generation' || m.error.data?.kind === 'incompatible')
        const result = m.result
        if (!Array.isArray(result?.terminals) || typeof result.seq !== 'number') return this.reconnect()
        snapshotSeq = last = result.seq
        this.terminals = liveTerminals(result.terminals)
        this.ready = true
        this.delay = 250
        this.opts.onStatus?.(true)
        this.opts.onChange?.('snapshot')
        for (const event of queue.splice(0)) live(event)
      } else if ((m.method === 'event' || m.method === 'missed') && m.params) {
        let item: CoreEvent | Resync = m.params
        if (m.method === 'missed') {
          if (typeof m.params.seq !== 'number' || !Array.isArray(m.params.terminals)) return this.reconnect()
          item = { resync: true, seq: m.params.seq, terminals: m.params.terminals }
        }
        if (snapshotSeq === null) { if (queue.length >= MAX_BUFFER) return this.reconnect(); queue.push(item) } else live(item)
      }
    }
    socket.on('connect', () => socket.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: {} }) + '\n'))
    socket.on('data', (chunk) => {
      if (!fresh()) return
      this.watch(socket)
      buf += chunk.toString('utf8')
      if (buf.length > MAX_LINE) return this.reconnect()
      let at: number
      while (fresh() && (at = buf.indexOf('\n')) >= 0) {
        const text = buf.slice(0, at)
        buf = buf.slice(at + 1)
        if (text.trim()) line(text)
      }
    })
    socket.on('error', () => { if (fresh()) this.reconnect() })
    socket.on('close', () => { if (fresh()) this.reconnect() })
  }
}
