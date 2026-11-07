// opencode-identity producer core — injectable seams only. The thin ./tui
// entry wires real node modules; unit tests drive fakes. Invariant: with no
// explicit ctx.options.enabled === true, or without the EXACT supported
// ctx.app.version, nothing touches fs/net/proc — the producer is inert.
import { encodeFrame, projectRoute } from './frame'

export interface FsLike {
  mkdirSync(p: string, o: { mode?: number }): unknown
  chmodSync(p: string, m: number): unknown
  existsSync(p: string): boolean
  lstatSync(p: string): {
    isSocket(): boolean, isDirectory(): boolean,
    isSymbolicLink(): boolean, dev: number, ino: number, uid: number,
    mode: number,
  }
  unlinkSync(p: string): unknown
  rmdirSync(p: string): unknown
}
export interface ConnLike {
  end(d: string): void, destroy(): void
  on(e: string, f: (e?: unknown) => void): void
  setTimeout?(ms: number, f: () => void): void
}
export interface ServerLike {
  listen(p: string, cb?: () => void): void
  on(e: string, f: (e: unknown) => void): void
  close(): void
}
export interface NetLike { createServer(cb: (c: ConnLike) => void): ServerLike }

export interface ProducerDeps {
  env: Record<string, string | undefined>
  fs: FsLike
  net: NetLike
  randomBytes(n: number): Uint8Array
  now(): number
  pid: number
  uid: number                     // this process's own euid
  gen(): string | null
}

export interface ProducerResult {
  off: string | null
  socket?: string
  dir?: string
  cleanup?(): void
}

export const SUPPORTED_APP_VERSION = '2.2.5'
const MAX_CONNS = 4
const CONN_MS = 1000
const SOCK_PATH_MAX = 107   // AF_UNIX sun_path bound in BYTES (Linux)
const DIR_MODE = 0o700
const FILE_MODE = 0o600
const GEN_OK = /^\d{1,20}$/       // /proc starttime birth is numeric

function hex(b: Uint8Array): string {
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

function safeAbs(p: string | undefined): p is string {
  return typeof p === 'string' && p.length > 1 && p[0] === '/'
    && !p.includes('\0')
}

const byteLen = (s: string) => Buffer.byteLength(s, 'utf8')

// Explicit opt-in + exact observed version + own XDG private dir chain +
// bounded listener + read-on-connect actual getter frame. `off` carries the
// concrete reason the producer stayed inert; the caller (tui.ts) maps any
// off to an undefined cleanup.
export function startProducer(ctx: any, deps: ProducerDeps): ProducerResult {
  if (ctx?.options?.enabled !== true) return { off: 'disabled' }
  const ver = ctx?.app?.version            // observed runtime evidence only
  if (typeof ver !== 'string') return { off: 'missing_app_version' }
  if (ver !== SUPPORTED_APP_VERSION) return { off: 'unsupported_app_version:' + ver.slice(0, 32) }
  if (!Number.isInteger(deps.pid) || deps.pid <= 0) return { off: 'bad_pid' }
  if (!Number.isInteger(deps.uid) || deps.uid < 0) return { off: 'bad_uid' }
  const gen = deps.gen()
  if (!gen || !GEN_OK.test(gen)) return { off: 'no_proc_generation' }
  // own state root: a set-but-invalid XDG fails closed; HOME only when absent
  const xdg = deps.env.XDG_STATE_HOME
  const base = xdg
    ? (safeAbs(xdg) ? xdg : null)
    : (safeAbs(deps.env.HOME) ? deps.env.HOME + '/.local/state' : null)
  if (!base) return { off: 'no_state_dir' }
  const chain = [`${base}/wherdr`, `${base}/wherdr/opencode-ident`,
    `${base}/wherdr/opencode-ident/v1`]
  const dir = `${chain[2]}/${deps.pid}-${gen}`
  const sock = dir + '/current.sock'         // versioned protocol path
  if (byteLen(sock) > SOCK_PATH_MAX || sock.includes('\0'))
    return { off: 'socket_path_too_long' }

  const fs = deps.fs
  const nonce = hex(deps.randomBytes(16))
  const conns = new Set<ConnLike>()
  let srv: ServerLike | null = null
  let dead = false                            // revokes accept + late bind
  let ready = false                           // set only after chmod'd bind
  // endpoint pin captured at the earliest stat AFTER bind; EVERY removal
  // requires the current stat to match it — unverified/replaced objects
  // (same-uid, foreign, non-socket) are preserved, never unlinked
  let ownSock: { dev: number, ino: number, uid: number } | null = null
  const made: { p: string, dev: number, ino: number, uid: number }[] = []
  const releaseOwn = () => {                  // pinned removal only
    if (!ownSock) return                      // unverified: never delete
    try {
      const st = fs.lstatSync(sock)
      if (st.isSocket() && st.dev === ownSock.dev
          && st.ino === ownSock.ino && st.uid === ownSock.uid)
        fs.unlinkSync(sock)
    } catch {}
  }
  const teardownOwn = () => {                 // close listener + release pin
    ready = false
    dead = true
    try { srv?.close() } catch {}
    releaseOwn()
  }
  const cleanup = () => {
    teardownOwn()
    for (const c of conns) try { c.destroy() } catch {}
    for (const d of [...made].reverse()) {    // only dirs WE created
      try {
        const st = fs.lstatSync(d.p)
        if (st.isDirectory() && st.dev === d.dev
            && st.ino === d.ino && st.uid === d.uid)
          fs.rmdirSync(d.p)
      } catch {}
    }
  }
  // dir chain: intermediates may exist only if own/safe (dir, own uid, no
  // symlink, never group/other-writable); the leaf is NEVER adopted — a
  // pre-existing leaf refuses instead of being trusted
  for (const p of chain) {
    if (!fs.existsSync(p)) continue
    const st = fs.lstatSync(p)
    if (st.isSymbolicLink() || !st.isDirectory()
        || st.uid !== deps.uid || (st.mode & 0o022))
      return { off: 'state_dir_unsafe:' + p.slice(-48) }
  }
  if (fs.existsSync(dir)) return { off: 'state_dir_exists' }
  if (fs.existsSync(sock)) return { off: 'socket_path_exists' }
  try {
    for (const p of [...chain, dir]) {
      if (fs.existsSync(p)) continue
      fs.mkdirSync(p, { mode: DIR_MODE })
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink() || !st.isDirectory()
          || st.uid !== deps.uid || (st.mode & 0o022)) {
        cleanup()                             // remove OUR made dirs only
        return { off: 'state_dir_unsafe:' + p.slice(-48) }
      }
      made.push({ p, dev: st.dev, ino: st.ino, uid: st.uid })
      fs.chmodSync(p, DIR_MODE)               // throws -> cleanup rmdirs it
    }
  } catch (e) {
    cleanup()                                 // bounded owned cleanup
    return { off: 'state_dir_failed:' + String(e).slice(0, 120) }
  }

  let seq = 0
  const errFrame = (code: string) => encodeFrame({
    seq: ++seq, nonce, pid: deps.pid, gen, t_ms: deps.now(),
    pv: 1, ver, kind: 'route_err', err: code,
  } as never)!
  srv = deps.net.createServer((c) => {
    // error handling on EVERY conn incl. rejected/excess — never unhandled
    try {
      c.on('error', () => { conns.delete(c); try { c.destroy() } catch {} })
    } catch {}
    try { c.on('close', () => conns.delete(c)) } catch {}
    if (dead || !ready || conns.size >= MAX_CONNS) {
      try { c.destroy() } catch {}            // refused: no getter, no frame
      return
    }
    conns.add(c)
    try { c.setTimeout?.(CONN_MS, () => c.destroy()) } catch {}
    let route: unknown = null
    try { route = ctx.ui.router.current() }   // ACTUAL getter, on connect
    catch { c.end(errFrame('getter_failed')); return }
    const body = encodeFrame({
      seq: ++seq, nonce, pid: deps.pid, gen, t_ms: deps.now(),
      pv: 1, ver, kind: 'route', route: projectRoute(route),
    } as never)
    c.end(body ?? errFrame('frame_over_cap'))
  })
  srv.on('error', () => {                     // revoke + close, fail closed
    teardownOwn()
    for (const c of conns) try { c.destroy() } catch {}
  })
  try {
    srv.listen(sock, () => {
      // earliest post-bind stat: pin OUR endpoint first — an unverifiable
      // object means close/refuse only, never unlink someone else's file
      try {
        const st = fs.lstatSync(sock)
        if (!st.isSocket() || st.uid !== deps.uid)
          throw new Error('own socket stat mismatch')
        ownSock = { dev: st.dev, ino: st.ino, uid: st.uid }
      } catch { teardownOwn(); return }       // no pin -> close only
      if (dead) { teardownOwn(); return }     // cleanup beat the bind
      try { fs.chmodSync(sock, FILE_MODE) }
      catch { teardownOwn(); return }         // fail closed: release pin
      ready = true
    })
  } catch (e) {
    cleanup()
    return { off: 'listen_failed:' + String(e).slice(0, 120) }
  }
  return { off: null, socket: sock, dir, cleanup }
}
