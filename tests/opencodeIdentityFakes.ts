// fake fs/net/proc seams — records every effectful call; NOTHING touches a
// real socket or filesystem. Stat-faithful: kind/uid/mode/dev/ino so the
// producer's private-dir, pin and cleanup checks run against real shapes.
import type { ProducerDeps } from '../integrations/opencode-identity/identity'

type Kind = 'dir' | 'file' | 'sock' | 'link'
interface Ent { kind: Kind, mode: number, uid: number, dev: number, ino: number }

const SELF_UID = 1000, SELF_PID = 4242
let inoSeq = 10000

export class FakeConn {
  writes: string[] = []
  listeners = new Map<string, (e?: unknown) => void>()
  destroyed = false
  constructor(public srv: FakeServer) { srv.conns.add(this) }
  on(e: string, f: (e?: unknown) => void) { this.listeners.set(e, f) }
  emit(e: string, err?: unknown) { this.listeners.get(e)?.(err) }
  end(d: string) {
    this.writes.push(d)
    setTimeout(() => { this.srv.conns.delete(this); this.emit('close') }, 0)
  }
  close() {
    if (this.destroyed) return
    this.destroyed = true
    this.srv.conns.delete(this)
    this.emit('close')
  }
  destroy() { this.close() }
  setTimeout(_ms: number, _f: () => void) {}
}

export class FakeServer {
  conns = new Set<FakeConn>()
  cb: ((c: FakeConn) => void) | null = null
  errorCb: ((e: unknown) => void) | null = null
  done: (() => void) | null = null     // deferred listen completion
  pending = false
  closed = false
  path = ''
  constructor(public fs: FakeFs, private defer = false) {}
  on(e: string, f: (e: unknown) => void) { if (e === 'error') this.errorCb = f }
  emit(e: string, v?: unknown) { if (e === 'error') this.errorCb?.(v) }
  listen(p: string, done?: () => void) {
    this.path = p
    if (this.defer) { this.pending = true; this.done = done ?? null; return }
    this.fs.bindSock(p); this.fs.onBound?.(p); done?.()
  }
  flushListen() {
    if (!this.pending) return
    this.pending = false
    this.fs.bindSock(this.path); this.fs.onBound?.(this.path); this.done?.()
  }
  connect() { const c = new FakeConn(this); this.cb?.(c); return c }
  close() { this.closed = true; this.conns.clear() }
}

export class FakeFs {
  ents = new Map<string, Ent>()
  created: string[] = []               // mkdir paths, in order
  unlinked: string[] = []
  rmdired: string[] = []
  statLog: string[] = []
  lstatLog: string[] = []
  chmodLog: [string, number][] = []
  chmodThrow: string | null = null
  onBound: ((p: string) => void) | null = null  // swap path right after bind
  ent(p: string) { return this.ents.get(p) }
  plant(p: string, kind: Kind, o: Partial<Ent> = {}) {
    this.ents.set(p, { kind, mode: 0, uid: SELF_UID,
      dev: 1, ino: ++inoSeq, ...o })
  }
  bindSock(p: string) { this.plant(p, 'sock') }
  existsSync = (p: string) => this.ents.has(p)
  fileMode(p: string) { return this.ents.get(p)?.mode }
  mkdirSync = (p: string, o: { mode?: number }) => {
    const e = this.ents.get(p)
    if (e) throw new Error('EEXIST ' + p)
    this.created.push(p)
    this.ents.set(p, { kind: 'dir', mode: o.mode ?? 0o755,
      uid: SELF_UID, dev: 1, ino: ++inoSeq })
  }
  chmodSync = (p: string, m: number) => {
    this.chmodLog.push([p, m])
    if (this.chmodThrow === p) {
      const cur = this.ents.get(p)
      if (cur?.kind === 'sock') this.plant(p, 'sock')  // raced replacement
      throw new Error('EPERM ' + p)
    }
    const e = this.ents.get(p)
    if (!e) throw new Error('ENOENT ' + p)
    e.mode = m
  }
  unlinkSync = (p: string) => {
    this.unlinked.push(p)
    if (!this.ents.delete(p)) throw new Error('ENOENT ' + p)
  }
  rmdirSync = (p: string) => {
    this.rmdired.push(p)
    this.ents.delete(p)
  }
  lstatSync = (p: string) => {
    this.lstatLog.push(p)
    const e = this.ents.get(p)
    if (!e) throw new Error('ENOENT ' + p)
    return { isSocket: () => e.kind === 'sock',
      isDirectory: () => e.kind === 'dir',
      isSymbolicLink: () => e.kind === 'link',
      dev: e.dev, ino: e.ino, uid: e.uid, mode: e.mode }
  }
}

export function fakeDeps(o: {
  env?: Record<string, string | undefined>
  socketExists?: boolean, gen?: string | null | (() => string | null)
  pid?: number, uid?: number
  asyncListen?: boolean, chmodThrow?: string
} = {}) {
  const fs = new FakeFs()
  fs.chmodThrow = o.chmodThrow ?? null
  if (o.socketExists) fs.plant(
    '/st/wherdr/opencode-ident/v1/4242-999/current.sock', 'sock')
  const srv = new FakeServer(fs, !!o.asyncListen)
  const meta: string[] = []                // every runtime-metadata call
  const deps = {
    env: { XDG_STATE_HOME: '/st', HOME: '/h', ...o.env },
    fs,
    net: { createServer: (cb: (c: FakeConn) => void) => {
      meta.push('net'); srv.cb = cb as never; return srv as never } },
    randomBytes: (n: number) => { meta.push('random'); return new Uint8Array(n).fill(7) },
    now: () => { meta.push('now'); return 1000 },
    pid: o.pid ?? SELF_PID,
    uid: o.uid ?? SELF_UID,
    gen: () => { meta.push('gen')
      return typeof o.gen === 'function' ? o.gen() : o.gen ?? '999' },
    srv,
    get unlinked() { return fs.unlinked },
    // every effectful seam call; stays [] while the producer is inert
    logs: () => [...meta, ...fs.created, ...fs.unlinked,
      ...fs.rmdired, ...fs.statLog, ...fs.lstatLog,
      ...fs.chmodLog.map(c => c[0]), ...srv.conns],
  } as ProducerDeps & {
    env: Record<string, string | undefined>, fs: FakeFs, srv: FakeServer,
    unlinked: string[], logs(): unknown[],
  }
  return deps
}
export { SELF_UID, SELF_PID }
