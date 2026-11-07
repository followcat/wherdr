import { expect, it } from 'vitest'
import { encodeFrame, FRAME_CAP, projectRoute } from '../integrations/opencode-identity/frame'
import { startProducer } from '../integrations/opencode-identity/identity'
import { fakeDeps, SELF_UID } from './opencodeIdentityFakes'

// Producer semantics over injected fakes: default-off across ALL effectful
// seams, exact observed version, own-XDG private dir chain, BYTE-bounded
// wire encoder, exact (grammar-checked, never truncated) identity,
// read-on-connect freshness, connection bound, async/own-object teardown.
// The decoder/context-cache/peer-bound consumer ships in the helper unit.

let getterCalls = 0
function ctx(over: Record<string, unknown> = {}) {
  const state = { route: { type: 'session', sessionID: 'ses_a' } as Record<string, unknown> }
  return {
    options: { enabled: true },
    app: { version: '2.2.5' },
    ui: { router: { current: () => { getterCalls++; return state.route } } },
    setRoute(r: Record<string, unknown>) { state.route = r },
    ...over,
  }
}
const DIR = '/st/wherdr/opencode-ident/v1/4242-999'
const decode = (w: string) => JSON.parse(w) as Record<string, any>

it('default off: disabled/missing/unsupported version touch ZERO seams', () => {
  for (const c of [{}, ctx({ options: {} }), ctx({ options: { enabled: false } })]) {
    getterCalls = 0
    const deps = fakeDeps()
    expect(startProducer(c as never, deps).off).toBe('disabled')
    expect(deps.logs()).toEqual([])
    expect(getterCalls).toBe(0)
  }
  for (const app of [{}, { version: '2.2.4' }, { version: '2.2.5-beta' }]) {
    getterCalls = 0
    const deps = fakeDeps()
    expect(String(startProducer(ctx({ app }) as never, deps).off)).toMatch(/version/)
    expect(deps.logs()).toEqual([])
    expect(getterCalls).toBe(0)
  }
})

it('binds own XDG state dir chain, private modes, BYTE-bounded socket path', () => {
  const deps = fakeDeps({ env: { XDG_STATE_HOME: '/st' } })
  const r = startProducer(ctx(), deps)
  expect(r.off).toBeNull()
  expect(deps.fs.lstatSync(DIR).mode).toBe(0o700)
  expect(deps.srv?.path).toBe(DIR + '/current.sock')
  expect(deps.fs.fileMode(DIR + '/current.sock')).toBe(0o600)
  expect(deps.fs.existsSync(DIR + '/nonce')).toBe(false)  // no nonce file
  r.cleanup!()
})

it('paths: HOME only when XDG absent; invalid nonempty XDG fails closed', () => {
  const rel = fakeDeps({ env: { XDG_STATE_HOME: 'rel', HOME: '/h' } })
  expect(String(startProducer(ctx(), rel).off)).toMatch(/state|home/i)
  const emptyX = fakeDeps({ env: { XDG_STATE_HOME: '', HOME: '/h' } })
  const r1 = startProducer(ctx(), emptyX)
  expect(r1.off).toBeNull()
  expect(r1.socket).toBe('/h/.local/state/wherdr/opencode-ident/v1/4242-999/current.sock')
  r1.cleanup!()
  expect(startProducer(ctx(), fakeDeps({
    env: { XDG_STATE_HOME: undefined, HOME: undefined },
  })).off).toMatch(/state|home/i)
  const uni = fakeDeps({ env: { XDG_STATE_HOME: '/' + '€'.repeat(40) } })
  expect(String(startProducer(ctx(), uni).off)).toMatch(/too_long|length/)  // 121 BYTES
  const nul = fakeDeps({ env: { XDG_STATE_HOME: '/st\0x' } })
  expect(String(startProducer(ctx(), nul).off)).toMatch(/nul|unsafe|state/)
})

it('private dir chain: reused leaf refused; unsafe intermediates rejected', () => {
  const d = fakeDeps()
  d.fs.plant(DIR, 'dir', { uid: SELF_UID, mode: 0o700 })
  d.fs.plant(DIR + '/current.sock', 'sock', { mode: 0o600 })
  expect(String(startProducer(ctx(), d).off)).toMatch(/exists|unsafe/)
  expect(d.unlinked).toEqual([])
  expect(d.fs.fileMode(DIR + '/current.sock')).toBe(0o600)  // untouched
  const mid = '/st/wherdr/opencode-ident/v1'
  for (const [kind, o] of [
    ['dir', { uid: 2000, mode: 0o755 }], ['link', { uid: SELF_UID }],
    ['dir', { uid: SELF_UID, mode: 0o777 }],
  ] as const) {
    const f = fakeDeps()
    f.fs.plant(mid, kind, o)
    expect(String(startProducer(ctx(), f).off)).toMatch(/unsafe|dir/)
    expect(f.unlinked).toEqual([])
  }
})

it('mkdir ok + safe stat + chmod throw still removes the verified owned dir', () => {
  // fail on the SECOND chain dir: 'wherdr' already made+recorded,
  // 'opencode-ident' made+verified but its chmod throws -> bounded cleanup
  // must rmdir BOTH; nothing may remain after the refusal
  const d = fakeDeps({ chmodThrow: '/st/wherdr/opencode-ident' })
  expect(String(startProducer(ctx(), d).off)).toMatch(/dir|unsafe|failed/)
  expect(d.fs.existsSync('/st/wherdr/opencode-ident')).toBe(false)
  expect(d.fs.existsSync('/st/wherdr')).toBe(false)
})

it('invalid process facts refuse before any filesystem work', () => {
  for (const o of [
    { pid: 0 }, { pid: -3 }, { pid: 1.5 }, { uid: -1 },
    { gen: () => 'a/b' }, { gen: () => 'x' }, { gen: () => null },
  ] as const) {
    const deps = fakeDeps(o)
    expect(String(startProducer(ctx(), deps).off)).toMatch(/pid|uid|gen|proc/i)
    expect(deps.fs.lstatLog).toEqual([])
  }
})

it('read-on-connect: EACH connect runs the actual getter (A then B)', () => {
  getterCalls = 0
  const deps = fakeDeps()
  const c = ctx()
  const r = startProducer(c, deps)
  const a = decode(deps.srv!.connect().writes[0])
  c.setRoute({ type: 'session', sessionID: 'ses_b' })
  const b = decode(deps.srv!.connect().writes[0])
  expect(getterCalls).toBe(2)
  expect(a.route.sessionID).toBe('ses_a')
  expect(b.route.sessionID).toBe('ses_b')      // real new getter output
  expect(b.seq).toBe(a.seq + 1)
  expect(b.ver).toBe('2.2.5')                  // echoes observed ctx value
  r.cleanup!()
})

it('identity is exact: invalid/overlong/non-ASCII sessionID -> non-session', () => {
  for (const sid of ['x'.repeat(500), 'x'.repeat(125), 'ses_é', 'SES_A', 42]) {
    const out = projectRoute({ type: 'session', sessionID: sid })
    expect(out.type).not.toBe('session')
    expect(out).not.toHaveProperty('sessionID')
  }
  expect(projectRoute({ type: 'session', sessionID: 'ses_ok-1_X' })).toEqual({ type: 'session', sessionID: 'ses_ok-1_X' })
  expect(projectRoute({ type: 'home' })).toEqual({ type: 'home' })
  expect(projectRoute(null)).toEqual({ type: 'unknown' })
  const deps = fakeDeps()
  const c = ctx()
  c.setRoute({ type: 'session', sessionID: 'x'.repeat(500) })
  const r = startProducer(c, deps)
  const w = deps.srv!.connect().writes[0]
  expect(w.length).toBeLessThanOrEqual(FRAME_CAP)
  expect(decode(w).route.type).not.toBe('session')
  r.cleanup!()
})

it('error frames carry a fixed code, never raw getter exception text', () => {
  const deps = fakeDeps()
  const secret = 'token-9f3c-private'
  const r = startProducer(ctx({ ui: { router: { current() { getterCalls++; throw new Error(secret) } } } }), deps)
  const w = deps.srv!.connect().writes[0]
  expect(w.length).toBeLessThanOrEqual(FRAME_CAP)
  const f = decode(w)
  expect(f.kind).toBe('route_err')
  expect(w).not.toContain(secret)
  r.cleanup!()
})

it('connection bound: stalled peers hold slots; excess refused without output/getter', () => {
  getterCalls = 0
  const deps = fakeDeps()
  const r = startProducer(ctx(), deps)
  const open = [...Array(4)].map(() => deps.srv!.connect())
  expect(deps.srv!.conns.size).toBe(4)
  const calls = getterCalls
  const fifth = deps.srv!.connect()
  expect(fifth.destroyed).toBe(true)
  expect(fifth.writes).toEqual([])
  expect(getterCalls).toBe(calls)
  open[0].close()
  const sixth = deps.srv!.connect()
  expect(sixth.destroyed).toBe(false)
  expect(sixth.writes).toHaveLength(1)
  open[1].emit('error', new Error('EPIPE'))    // reset releases the slot too
  const seventh = deps.srv!.connect()
  expect(seventh.writes).toHaveLength(1)
  r.cleanup!()
})

it('teardown: stat-matched socket only; deferred bind still removed; chmod fail closed', () => {
  const deps = fakeDeps()
  const r = startProducer(ctx(), deps)
  deps.fs.plant(r.socket!, 'sock', { mode: 0o600 })       // same-type replacement, new ino
  r.cleanup!(); r.cleanup!()                              // idempotent
  expect(deps.unlinked).not.toContain(r.socket)
  const d2 = fakeDeps({ asyncListen: true })              // cleanup BEFORE bind
  const r2 = startProducer(ctx(), d2)
  r2.cleanup!()
  d2.srv!.flushListen()                                   // bind fires later
  expect(d2.fs.existsSync(r2.socket!)).toBe(false)        // own socket removed
  expect(d2.unlinked).toContain(r2.socket)
  const d2b = fakeDeps({ asyncListen: true })
  const r2b = startProducer(ctx(), d2b)
  r2b.cleanup!()
  d2b.fs.onBound = () => d2b.fs.plant(r2b.socket!, 'sock', { uid: 2000 })
  d2b.srv!.flushListen()                                  // bind races FOREIGN object
  expect(d2b.fs.existsSync(r2b.socket!)).toBe(true)       // unverified: kept
  expect(d2b.unlinked).toEqual([])
  const d3 = fakeDeps({ asyncListen: true, chmodThrow: '/st/wherdr/opencode-ident/v1/4242-999/current.sock' })
  const r3 = startProducer(ctx(), d3)
  d3.srv!.flushListen()                                   // chmod fails + path REPLACED same-uid
  expect(d3.fs.existsSync(r3.socket!)).toBe(true)         // replacement preserved, never unlinked
  expect(d3.unlinked).not.toContain(r3.socket)
  expect(d3.srv!.closed).toBe(true)
})

it('accept callback guarded: pre-ready conns refused w/o getter; error revokes', () => {
  getterCalls = 0
  const d = fakeDeps({ asyncListen: true })
  const r = startProducer(ctx(), d)
  const early = d.srv!.connect()                          // arrives before ready
  expect(early.destroyed).toBe(true)
  expect(early.writes).toEqual([])                        // refused, no frame
  expect(getterCalls).toBe(0)                             // getter never invoked
  d.srv!.flushListen()                                    // now ready
  getterCalls = 0
  const ok = d.srv!.connect()
  expect(decode(ok.writes[0]).route.sessionID).toBe('ses_a')
  d.srv!.emit('error', new Error('EADDRINUSE'))           // revokes + closes
  expect(d.srv!.closed).toBe(true)
  getterCalls = 0
  const after = d.srv!.connect()
  expect(after.destroyed).toBe(true)
  expect(after.writes).toEqual([])
  expect(getterCalls).toBe(0)
  r.cleanup!()
})

it('wire encoder: BYTE cap before write, exact fields', () => {
  const good = encodeFrame({ seq: 1, nonce: 'n', pid: 1, gen: 'g', t_ms: 9, ver: '2.2.5', kind: 'route', route: { type: 'session', sessionID: 'ses_a' } })
  expect(decode(good!).route.sessionID).toBe('ses_a')
  expect(encodeFrame({ seq: 1, nonce: 'n', pid: 1, gen: 'g', t_ms: 9, kind: 'route_err', err: 'x'.repeat(5000) } as never)).toBeNull()
  expect(encodeFrame({ seq: 1, nonce: 'n', pid: 1, gen: 'g', t_ms: 9, kind: 'route_err', err: '€'.repeat(2000) } as never)).toBeNull()  // 6000 BYTES
})
