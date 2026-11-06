import { describe, expect, it } from 'vitest'
import { createCmdCore } from '../server/utils/commandCodeCore'
import type { ShellExec } from '../server/utils/fsx'
import { AGENT_CENSUS_SCRIPT, CMD_HEADERS_SCRIPT } from './cmdCoreFixture'
import {
  AT, clock, F, filesWire, H, hdrs, HOME, live, OTHER, PKG,
  POST, POST2, PRE, retitled, S, sess, st, stub, T, U1, U2, U3
} from './cmdCoreFixture'

describe('createCmdCore', () => {
  it('requires a live detail with a valid root pid', async () => {
    const { exec, calls } = stub({ census: H + S(4242) + T(1, 1) })
    const c = createCmdCore(exec, HOME)
    for (const d of [undefined, null, {}, { pid: 0 }, { pid: -3 }, { pid: Number.NaN }, { pid: '4242' }]) {
      expect(await c.locate(d as never)).toEqual({ unavailable: 'detail' })
    }
    // Finished/missing state fails BEFORE any census — a reused pid in the
    // current census can never resurrect a dead terminal's claim.
    for (const d of [
      { state: 'finished', pid: 4242, argv: ['cmd'] },
      { state: 'exited', pid: 4242, argv: ['cmd'] },
      { pid: 4242, argv: ['cmd'] }, // no state at all
      { state: '', pid: 4242 }
    ]) {
      expect(await c.locate(d as never)).toEqual({ unavailable: 'detail' })
    }
    expect(calls).toEqual({ census: 0, files: 0, headers: 0 })
  })

  it('locates a proven foreground cmd to its newest post-birth file', async () => {
    const { exec, calls } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)], [F('b', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('b', U2)]: { st: st(POST2), body: sess(U2) } })
    })
    const r = await createCmdCore(exec, HOME).locate(live({ pid: 9000, argv: ['bash', '-l'], foreground: { pid: 4242 } }))
    expect(r).toEqual({ file: F('b', U2), session: U2 }) // newest write wins (/clear, /resume shape)
    expect(calls).toEqual({ census: 1, files: 1, headers: 1 })
  })

  it('locates a root cmd pid only when recorded argv proves a cmd launch', async () => {
    const { exec } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    const c = createCmdCore(exec, HOME)
    for (const argv of [['cmd'], ['command-code'], ['cmdc'], ['node', '/x/bin/cmd'], ['node', PKG]]) {
      expect(await c.locate(live({ pid: 4242, argv }))).toEqual({ file: F('a', U1), session: U1 })
    }
  })

  it('rejects a root cmd pid whose recorded launch was a shell or unproven', async () => {
    const { exec } = stub({ census: H + S(4242) + T(1, 1) })
    const c = createCmdCore(exec, HOME)
    // Old bash root that exec'd cmd: pid/ticks are the shell's, not the agent's.
    for (const argv of [['bash', '-l'], ['sh', '-c', 'exec cmd'], ['node', '/srv/server.js'], [], undefined]) {
      expect(await c.locate(live({ pid: 4242, argv: argv as string[] | undefined }))).toEqual({ unavailable: 'target' })
    }
    // Same unproven birth even when the foreground reports the root pid
    // itself: the exec'd process IS the foreground, still shell-born.
    expect(await c.locate(live({ pid: 4242, argv: ['bash', '-l'], foreground: { pid: 4242 } }))).toEqual({ unavailable: 'target' })
  })

  it('targets the single direct cmd child of a shell root', async () => {
    const { exec } = stub({
      census: H + S(4242, { ppid: 9000 }) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    // Foreground reports the shell itself; ppid makes the child's own
    // generation the target — the shell's recorded argv is never consulted.
    const r = await createCmdCore(exec, HOME).locate(live({ pid: 9000, argv: ['bash', '-l', '--session', U3], foreground: { pid: 9000 } }))
    expect(r).toEqual({ file: F('a', U1), session: U1 })
  })

  it('refuses ambiguous or unproven wrapper shapes', async () => {
    const { exec } = stub({ census: H + S(4242, { ppid: 9000 }) + S(4243, { ppid: 9000 }) + T(2, 2) })
    expect(await createCmdCore(exec, HOME).locate(live({ pid: 9000, argv: ['bash', '-l'] }))).toEqual({ unavailable: 'target' })
    // A deeper wrapper: the cmd's parent is not the root, so nothing is proven.
    const { exec: e2 } = stub({ census: H + S(4242, { ppid: 9999 }) + T(1, 1) })
    expect(await createCmdCore(e2, HOME).locate(live({ pid: 9000, argv: ['bash', '-l'] }))).toEqual({ unavailable: 'target' })
    // Root pid absent from the census and no children at all.
    const { exec: e3 } = stub({ census: H + S(4242) + T(1, 1) })
    expect(await createCmdCore(e3, HOME).locate(live({ pid: 7777, argv: ['cmd'] }))).toEqual({ unavailable: 'target' })
  })

  it('refuses two same-cwd peers before any file IO but allows other-cwd peers', async () => {
    const { exec, calls } = stub({ census: H + S(4242) + S(5555) + T(2, 2) })
    expect(await createCmdCore(exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ unavailable: 'peers' })
    expect(calls).toEqual({ census: 1, files: 0, headers: 0 }) // ambiguity rejects before expensive IO
    // A second agent elsewhere does not collide.
    const { exec: e2 } = stub({
      census: H + S(4242) + S(5555, { cwd: '/w/elsewhere' }) + T(2, 2),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    expect(await createCmdCore(e2, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ file: F('a', U1), session: U1 })
  })

  it('scopes unclassifiable processes: an unrelated cwd never voids the lookup', async () => {
    const { exec } = stub({
      census: H + S(4242)
        + S(7701, { argv: ['/opt/tools/node_repl'], cwd: OTHER }) // bare REPL: argv0 only
        + S(7702, { argv: ['node', '-e', 'tick()'], cwd: '/w/eval' }) // eval code
        + S(7703, { comm: 'bun', argv: ['bun', '/srv/app.js'], cwd: '/w/bun' })
        + S(7704, { comm: 'deno', argv: ['deno', 'run', '/srv/x.ts'], cwd: '/w/deno' })
        + S(7705, { argv: ['node', '-'], cwd: '/w/stdin' }) // script on stdin
        + T(6, 6),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    expect(await createCmdCore(exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ file: F('a', U1), session: U1 })
  })

  it('refuses before file IO when an unclassifiable process shares the target cwd', async () => {
    for (const u of [
      S(7701, { argv: ['/opt/tools/node_repl'] }),
      S(7702, { argv: ['node', '-e', 'tick()'] }),
      S(7703, { comm: 'bun', argv: ['bun', '/srv/app.js'] }),
      S(7704, { comm: 'deno', argv: ['deno', 'run', '/srv/x.ts'] }),
      S(7705, { argv: ['node', '-'] }),
    ]) {
      const { exec, calls } = stub({ census: H + S(4242) + u + T(2, 2) })
      expect(await createCmdCore(exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ unavailable: 'peers' })
      expect(calls).toEqual({ census: 1, files: 0, headers: 0 })
    }
  })

  it('refuses an unclassifiable process whose cwd is unreadable, whatever the target', async () => {
    const { exec } = stub({ census: H + S(4242) + S(7701, { argv: ['/opt/tools/node_repl'], cwd: null }) + T(2, 2) })
    expect(await createCmdCore(exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ unavailable: 'peers' })
  })

  it('scopes the unclassifiable check to an eligible launch-target header cwd too', async () => {
    const seeded = (u: string) => stub({
      census: H + S(4242, { argv: ['node', '/x/bin/cmd', '--session', U2] }) + u + T(2, 2),
      files: filesWire([[F('a', U1), st(POST)], [F('r', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('r', U2)]: { st: st(POST2), body: sess(U2, OTHER) } })
    })
    // The resume target's header cwd is OTHER: an unknown there could own it.
    expect(await createCmdCore(seeded(S(7701, { argv: ['/opt/tools/node_repl'], cwd: OTHER })).exec, HOME)
      .locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ unavailable: 'peers' })
    // An unrelated unknown cannot: the legitimate launch target still wins.
    expect(await createCmdCore(seeded(S(7701, { argv: ['/opt/tools/node_repl'], cwd: '/w/three' })).exec, HOME)
      .locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ file: F('r', U2), session: U2 })
  })

  it('keeps recordless producer unknowns a global failure', async () => {
    const { exec } = stub({ census: H + S(4242) + T(2, 1, 0, 3) })
    expect(await createCmdCore(exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ unavailable: 'incomplete' })
  })

  it('enforces the strict post-birth write boundary', async () => {
    const { exec } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(AT)], [F('b', U2), st(PRE)]]),
      headers: hdrs({})
    })
    // The at-bound file is not after it, the other is pre-birth: nothing
    // eligible — explicit empty, never a last-file fallback.
    expect(await createCmdCore(exec, HOME).locate(live({ pid: 4242, argv: ['cmd'] }))).toEqual({ unavailable: 'empty' })
  })

  it('seeds a cross-cwd resume only from proven exact argv and only when globally unique', async () => {
    const seeded = (extra: [string, string][] = [], argv: string[] = ['node', '/x/bin/cmd', '--session', U2]) => stub({
      census: H + S(4242, { argv }) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)], [F('r', U2), st(POST2)], ...extra]),
      headers: hdrs({
        [F('a', U1)]: { st: st(POST), body: sess(U1) },
        [F('r', U2)]: { st: st(POST2), body: sess(U2, OTHER) } // old header cwd: only the seed admits it
      })
    })
    // Exact sampled argv: the seed adds the resumed file, and its newer write wins.
    expect(await createCmdCore(seeded().exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ file: F('r', U2), session: U2 })
    // A pre-birth duplicate of the SAME uuid in another project dir makes the
    // seed non-unique across the full catalog: omitted, cwd rule applies.
    const dup = seeded([[F('s', U2), st(PRE)]])
    expect(await createCmdCore(dup.exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ file: F('a', U1), session: U1 })
    // Retitled argv is not launch-exact: an argv array alone never seeds.
    const rt = stub({
      census: H + retitled(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)], [F('r', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('r', U2)]: { st: st(POST2), body: sess(U2, OTHER) } })
    })
    expect(await createCmdCore(rt.exec, HOME).locate(live({ pid: 9000, foreground: { pid: 4242 } }))).toEqual({ file: F('a', U1), session: U1 })
    // Recorded root argv seeds a root-equal target the same way.
    const { exec: e4 } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)], [F('r', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('r', U2)]: { st: st(POST2), body: sess(U2, OTHER) } })
    })
    expect(await createCmdCore(e4, HOME).locate(live({ pid: 4242, argv: ['cmd', '--session', U2] }))).toEqual({ file: F('r', U2), session: U2 })
  })

  it('coalesces census and header evidence across simultaneous lookups', async () => {
    const { exec, calls } = stub({
      census: H + S(4242) + S(5555, { cwd: '/w/two' }) + T(2, 2),
      files: filesWire([[F('a', U1), st(POST)], [F('b', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('b', U2)]: { st: st(POST2), body: sess(U2, '/w/two') } })
    })
    const c = createCmdCore(exec, HOME)
    const [r1, r2, r3] = await Promise.all([
      c.locate(live({ pid: 9000, foreground: { pid: 4242 } })),
      c.locate(live({ pid: 9001, foreground: { pid: 5555 } })),
      c.locate(live({ pid: 9999, argv: ['bash'] })) // target-rejected: shares census, never needs files
    ])
    expect(r1).toEqual({ file: F('a', U1), session: U1 })
    expect(r2).toEqual({ file: F('b', U2), session: U2 })
    expect(r3).toEqual({ unavailable: 'target' })
    expect(calls).toEqual({ census: 1, files: 1, headers: 1 }) // ONE machine snapshot across panes
  })

  it('refreshes after the TTL and clears location on failure without storms', async () => {
    const o = {
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)], [F('b', U2), st(POST2)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) }, [F('b', U2)]: { st: st(POST2), body: sess(U2, OTHER) } })
    }
    const { exec, calls } = stub(o)
    const cl = clock()
    const c = createCmdCore(exec, HOME, { now: cl.now })
    const d = live({ pid: 9000, foreground: { pid: 4242 } })
    expect(await c.locate(d)).toEqual({ file: F('a', U1), session: U1 })
    cl.advance(500)
    expect(await c.locate(d)).toEqual({ file: F('a', U1), session: U1 }) // same window: no refetch
    expect(calls.census).toBe(1)
    cl.advance(1000) // past the ~1s TTL
    // The pid was reused: a NEW generation in another cwd claims it — the
    // fresh census, never a cached by-pid answer, decides.
    o.census = H + S(4242, { ticks: '12400', cwd: OTHER }) + T(1, 1)
    expect(await c.locate(d)).toEqual({ file: F('b', U2), session: U2 })
    expect(calls.census).toBe(2)
    cl.advance(1500)
    o.census = 'H 100 1767225600 0\nT 0 0 0 0\n' // machine evidence unavailable
    expect(await c.locate(d)).toEqual({ unavailable: 'incomplete' }) // never the previous file
    expect(await c.locate(d)).toEqual({ unavailable: 'incomplete' })
    expect(calls.census).toBe(3) // the failed window is shared too: no RPC storm
    cl.advance(1500)
    o.census = H + S(4242) + T(1, 1)
    expect(await c.locate(d)).toEqual({ file: F('a', U1), session: U1 }) // recovery refetches
    expect(calls.census).toBe(4)
  })

  it('scopes all evidence to its own machine instance', async () => {
    const mk = (cwd: string, dir: string, id: string) => stub({
      census: H + S(4242, { cwd }) + T(1, 1),
      files: filesWire([[F(dir, id), st(POST)]]),
      headers: hdrs({ [F(dir, id)]: { st: st(POST), body: sess(id, cwd) } })
    })
    const a = mk('/w/a', 'pa', U1)
    const b = mk('/w/b', 'pb', U2)
    const d = live({ pid: 4242, argv: ['cmd'] }) // same pids on both machines
    expect(await createCmdCore(a.exec, HOME).locate(d)).toEqual({ file: F('pa', U1), session: U1 })
    expect(await createCmdCore(b.exec, HOME).locate(d)).toEqual({ file: F('pb', U2), session: U2 })
  })

  it('shares in-flight evidence across TTL expiry, settled or not', async () => {
    const cl = clock()
    let release: () => void = () => {}
    const gate = new Promise<void>(res => { release = res })
    // A gated census: the second locate inside the SAME still-pending window
    // must join it even after the TTL would have expired.
    const { exec: base } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    let censusCalls = 0
    const exec: ShellExec = (s, a, o) => s === AGENT_CENSUS_SCRIPT ? (censusCalls++, gate.then(() => base(s, a, o))) : base(s, a, o)
    const c = createCmdCore(exec, HOME, { now: cl.now })
    const d = live({ pid: 9000, foreground: { pid: 4242 } })
    const l1 = c.locate(d)
    cl.advance(2000) // far past the ~1s TTL while census still runs
    const l2 = c.locate(d)
    expect(censusCalls).toBe(1) // pending work is shared, not re-issued
    release()
    const [r1, r2] = await Promise.all([l1, l2])
    expect(r1).toEqual(r2)
    expect(r1).toEqual({ file: F('a', U1), session: U1 })
    // Same for a gated metadata/header phase: files+headers pending joins too.
    const cl2 = clock()
    let release2: () => void = () => {}
    const gate2 = new Promise<void>(res => { release2 = res })
    const { exec: b2, calls: c2 } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    let headerCalls = 0
    const exec2: ShellExec = (s, a, o) => s === CMD_HEADERS_SCRIPT ? (headerCalls++, gate2.then(() => b2(s, a, o))) : b2(s, a, o)
    const cc2 = createCmdCore(exec2, HOME, { now: cl2.now })
    const m1 = cc2.locate(d)
    cl2.advance(2000)
    const m2 = cc2.locate(d)
    await new Promise(r => setImmediate(r)) // let both chains reach the gate
    expect(c2).toEqual({ census: 1, files: 1, headers: 0 }) // one slot: files done once, headers gated
    expect(headerCalls).toBe(1) // the second call joins the pending header pass
    release2()
    const [m1r, m2r] = await Promise.all([m1, m2])
    expect(m1r).toEqual(m2r)
    expect(m1r).toEqual({ file: F('a', U1), session: U1 })
  })

  it('expires ttl=0 only after pending work settles, and never serves negative-age hits', async () => {
    const cl = clock()
    let release: () => void = () => {}
    const gate = new Promise<void>(res => { release = res })
    const { exec: base } = stub({
      census: H + S(4242) + T(1, 1),
      files: filesWire([[F('a', U1), st(POST)]]),
      headers: hdrs({ [F('a', U1)]: { st: st(POST), body: sess(U1) } })
    })
    let gating = true
    let censusCalls = 0
    const exec: ShellExec = (s, a, o) => s === AGENT_CENSUS_SCRIPT ? (censusCalls++, gating ? gate.then(() => base(s, a, o)) : base(s, a, o)) : base(s, a, o)
    const c = createCmdCore(exec, HOME, { now: cl.now, ttlMs: 0 })
    const d = live({ pid: 9000, foreground: { pid: 4242 } })
    const l1 = c.locate(d)
    cl.advance(10)
    const l2 = c.locate(d) // pending: still shares even at ttl 0
    expect(censusCalls).toBe(1)
    release()
    const [r1] = await Promise.all([l1, l2])
    expect(r1).toEqual({ file: F('a', U1), session: U1 })
    gating = false
    cl.advance(1) // settled + ttl 0 => every new call refreshes
    expect(await c.locate(d)).toEqual({ file: F('a', U1), session: U1 })
    expect(censusCalls).toBe(2)
    // A backwards injected clock can never produce a negative-age cache hit.
    const { exec: e2, calls: c3 } = stub({ census: H + S(4242) + T(1, 1) })
    const cl3 = clock()
    const c3i = createCmdCore(e2, HOME, { now: cl3.now })
    cl3.set(1000)
    expect(await c3i.locate(d)).toEqual({ unavailable: 'empty' }) // complete census, empty files
    cl3.set(500) // clock moved backwards: previous evidence must not count
    await c3i.locate(d)
    expect(c3.census).toBe(2)
  })

  it('clamps the TTL to the ~1s bound', async () => {
    const cl = clock()
    const { exec, calls } = stub({ census: H + S(4242) + T(1, 1) })
    const c = createCmdCore(exec, HOME, { now: cl.now, ttlMs: 60000 })
    const d = live({ pid: 9000, foreground: { pid: 4242 } })
    await c.locate(d)
    cl.advance(1500) // beyond 1s: a 60s override must not keep it warm
    await c.locate(d)
    expect(calls.census).toBe(2)
  })
})
