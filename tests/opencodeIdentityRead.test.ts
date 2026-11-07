// 6l2 consumer unit: strict decoder/context/ordered cache + typed read
// wrapper — all behind an inert, caller-opt-in API. Fake ShellExec only:
// zero real exec/proc/socket work. Neutral fixture values throughout.
import { expect, it, vi } from 'vitest'
import { decodeFrame, frameSchemaOk, FrameCache, FRESH_MS, FUTURE_MS,
  RECEIPT_MS } from '../server/utils/opencodeIdentity'
import { opencodeReadIdentity, OPENCODE_IDENT,
  IDENT_ERRORS } from '../server/utils/opencodeReadIdentity'
import type { ExecResult, ShellExec } from '../server/utils/fsx'

const REQ = { pid: 4242, uid: 1000, gen: '999', ns: 'pid:[123]' }
const ON = { enabled: true }
const CTX = { machine: 'm1', service: 'abc123', ...REQ, nonce: 'a'.repeat(32) }
const FRAME = { seq: 3, nonce: 'a'.repeat(32), pid: 4242, gen: '999',
  t_ms: 5000, pv: 1, ver: '2.2.5', kind: 'route',
  route: { type: 'session', sessionID: 'ses_a' } }
const DIGEST = 'b'.repeat(64)   // helper-derived sha256 of exact wire bytes

const reply = (v: unknown, code = 0, stderr = ''): ExecResult =>
  ({ code, stdout: Buffer.from(JSON.stringify(v)), stderr })
const fakeExec = (fn: (args: string[]) => ExecResult | Promise<ExecResult>): {
  exec: ShellExec, calls: { script: string, args: string[], opts: any }[],
} => {
  const calls: { script: string, args: string[], opts: any }[] = []
  const exec: ShellExec = async (script, args = [], opts = {}) => {
    calls.push({ script, args, opts })
    return fn(args)
  }
  return { exec, calls }
}
const okReply = (frame: unknown = FRAME, age = 100, req: unknown = REQ,
    digest: unknown = DIGEST) =>
  reply({ ok: true, req, frame, digest, age_ms: age })

it('default OFF: missing/disabled/false opt-in => zero exec, unavailable', async () => {
  for (const opts of [undefined, {}, { enabled: false }, { enabled: 1 }]) {
    const { exec, calls } = fakeExec(() => okReply())
    const r = await opencodeReadIdentity(exec, '/h', REQ, opts as never)
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])                       // ZERO exec while off
  }
})

it('request: exact fields/pinned; invalid or mutated -> zero exec, unavailable', async () => {
  for (const bad of [null, {}, { ...REQ, x: 1 }, { ...REQ, pid: 0 },
      { ...REQ, pid: 1.5 }, { ...REQ, pid: '4242' }, { ...REQ, uid: -1 },
      { ...REQ, uid: 3.2 }, { ...REQ, gen: 'a/b' }, { ...REQ, gen: '' },
      { ...REQ, gen: '9'.repeat(21) }, { ...REQ, ns: 'nonsense' },
      { ...REQ, ns: 'pid:[x]' }]) {
    const { exec, calls } = fakeExec(() => okReply())
    const r = await opencodeReadIdentity(exec, '/h', bad as never, ON)
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
  }
  const { exec, calls } = fakeExec(() => okReply())
  expect((await opencodeReadIdentity(exec, 'relative', REQ, ON)).ok).toBe(false)
  expect(calls).toEqual([])
  // coordinator-side HOME can never substitute the selected process environ:
  // the pinned wire body carries only the four request fields
  const r = await opencodeReadIdentity(fakeExec(a => {
    expect(JSON.parse(a[1])).toEqual({ pid: 4242, uid: 1000, gen: '999', ns: 'pid:[123]' })
    expect(Object.keys(JSON.parse(a[1])).sort().join()).toBe('gen,ns,pid,uid')
    return okReply()
  }).exec, '/h', REQ, ON)
  expect(r.ok).toBe(true)
})

it('wrapper: pinned request survives deferred caller mutation while pending', async () => {
  const req = { ...REQ }
  const { exec, calls } = fakeExec(async args => {
    req.pid = 1                                       // caller mutates mid-flight
    ;(req as any).extra = true
    return okReply()
  })
  const r = await opencodeReadIdentity(exec, '/h', req, ON)
  expect(r.ok).toBe(true)
  expect(JSON.parse(calls[0].args[1])).toEqual(REQ)   // pinned at submit time
})

it('wrapper: fixed argv, exact timeout/reply cap, request echo binds all fields', async () => {
  const { exec, calls } = fakeExec(() => okReply())
  const r = await opencodeReadIdentity(exec, '/h', { ...REQ }, ON)
  expect(r.ok).toBe(true)
  expect(calls).toHaveLength(1)
  expect(calls[0].script).toBe('exec python3 -X utf8 -c "$1" "$2"')
  expect(calls[0].args[0]).toBe(OPENCODE_IDENT)
  expect(JSON.parse(calls[0].args[1])).toEqual(REQ)
  expect(calls[0].opts.timeoutMs).toBe(5000)          // exact fixed budget
  expect(calls[0].opts.maxBytes).toBe(8192)           // exact reply cap
  // reply must echo the PINNED request — a foreign/old reply with a
  // healthy-looking frame is refused (all four fields, not just pid)
  for (const req of [
    { ...REQ, pid: 9999 }, { ...REQ, gen: '111' },
    { ...REQ, uid: 2000 }, { ...REQ, ns: 'pid:[9]' }, null, { pid: 4242 },
  ]) {
    const e = fakeExec(() => okReply(FRAME, 100, req))
    expect((await opencodeReadIdentity(e.exec, '/h', REQ, ON)).ok).toBe(false)
  }
  // an arbitrary route label in the reply never leaves the PUBLIC wrapper —
  // every accepted frame is normalized to the fixed tag, same as the wire
  const marker = 'fixture_private_marker'
  const e2 = fakeExec(() => okReply({ ...FRAME, route: { type: marker } }))
  const r2 = await opencodeReadIdentity(e2.exec, '/h', REQ, ON)
  expect(r2.ok).toBe(true)
  if (r2.ok) {
    expect(r2.frame.route).toEqual({ type: 'non-session' })
    expect(JSON.stringify(r2.frame)).not.toContain(marker)
  }
})

it('wrapper: malformed/late/foreign envelopes sanitize to fixed keys', async () => {
  for (const [label, result] of [
    ['unknown field', reply({ ok: true, req: REQ, frame: FRAME, digest: DIGEST, age_ms: 1, extra: 1 })],
    ['string age', reply({ ok: true, req: REQ, frame: FRAME, digest: DIGEST, age_ms: 'x' })],
    ['stale age', reply({ ok: true, req: REQ, frame: FRAME, digest: DIGEST, age_ms: FRESH_MS + 1 })],
    ['future age', reply({ ok: true, req: REQ, frame: FRAME, digest: DIGEST, age_ms: -FUTURE_MS - 1 })],
    ['missing digest', reply({ ok: true, req: REQ, frame: FRAME, age_ms: 1 })],
    ['short digest', reply({ ok: true, req: REQ, frame: FRAME, digest: 'aa', age_ms: 1 })],
    ['missing req', reply({ ok: true, frame: FRAME, digest: DIGEST, age_ms: 1 })],
    ['bad ver', reply({ ok: true, req: REQ, frame: { ...FRAME, ver: '2.2.4' }, digest: DIGEST, age_ms: 0 })],
    ['bad nonce', reply({ ok: true, req: REQ, frame: { ...FRAME, nonce: 'zz' }, digest: DIGEST, age_ms: 0 })],
    ['bad kind', reply({ ok: true, req: REQ, frame: { ...FRAME, kind: 'x' }, digest: DIGEST, age_ms: 0 })],
    ['invented error', reply({ error: 'invented' }, 1)],
    ['stderr never reflected', reply({ error: 'Traceback /home/secret' }, 1, 'secret')],
    ['truncated', { code: 0, stdout: Buffer.from('{"ok":tru'), stderr: 'oops' }],
    ['oversized', { code: 0, stdout: Buffer.alloc(9000, 65), stderr: '' }],
    ['late 124', { code: 124, stdout: Buffer.alloc(0), stderr: 'timeout' }],
    ['gone 255', { code: 255, stdout: Buffer.alloc(0), stderr: 'gone' }],
  ] as const) {
    const { exec } = fakeExec(() => result as ExecResult)
    const r = await opencodeReadIdentity(exec, '/h', REQ, ON)
    expect(r.ok, label).toBe(false)
    expect(JSON.stringify(r), label).not.toMatch(/secret|Traceback|oops/)
  }
  // ShellExec's own timeout option is not late-success detection: a reply
  // landing past the coordinator monotonic receipt budget is refused even
  // though the process exited 0 in time
  // each block needs a FRESH spy: mockRestore detaches interception, so
  // mockReturnValueOnce on a restored spy silently uses the real clock
  const clock = (...vals: number[]) => {
    const s = vi.spyOn(performance, 'now')
    for (const v of vals) s.mockReturnValueOnce(v)
    return s
  }
  let spy = clock(0, RECEIPT_MS + 1)
  try {
    const { exec } = fakeExec(() => okReply())
    expect((await opencodeReadIdentity(exec, '/h', REQ, ON)).ok).toBe(false)
  } finally { spy.mockRestore() }
  spy = clock(0, RECEIPT_MS - 1)
  try {
    const { exec } = fakeExec(() => okReply())
    const r = await opencodeReadIdentity(exec, '/h', REQ, ON)
    expect(r.ok).toBe(true)
  } finally { spy.mockRestore() }
  // transport time charges the returned age conservatively: a frame aged
  // near-fresh at emission + 500ms delivery is NO LONGER fresh — refuse
  spy = clock(0, 500)
  try {
    const { exec } = fakeExec(() => okReply(FRAME, FRESH_MS - 100))
    expect((await opencodeReadIdentity(exec, '/h', REQ, ON)).ok).toBe(false)
  } finally { spy.mockRestore() }
  // healthy neighbor: short transport is still charged into the returned
  // age — the cache never gets another raw-age window for free
  spy = clock(0, 500)
  try {
    const { exec } = fakeExec(() => okReply(FRAME, 100))
    const r = await opencodeReadIdentity(exec, '/h', REQ, ON)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.ageMs).toBe(600)            // 100 raw + 500 elapsed
  } finally { spy.mockRestore() }
  // ORIGINAL future bound unchanged: raw age below -FUTURE_MS refuses even
  // when elapsed transport could shift the effective age back into range
  spy = clock(0, 900)
  try {
    const { exec } = fakeExec(() => okReply(FRAME, -FUTURE_MS - 1))
    expect((await opencodeReadIdentity(exec, '/h', REQ, ON)).ok).toBe(false)
  } finally { spy.mockRestore() }
  for (const key of IDENT_ERRORS) {
    const { exec } = fakeExec(() => reply({ error: key }, 1))
    const r = await opencodeReadIdentity(exec, '/h', REQ, ON)
    expect(r.ok).toBe(false)
    expect((r as { error?: string }).error).toBe(key)
  }
})

it('decoder: strict schema/grammar/utf8, byte cap first, no unknown fields', () => {
  const good = JSON.stringify(FRAME)
  const d = decodeFrame(good)
  expect(d).toMatchObject({ seq: 3, nonce: 'a'.repeat(32) })
  for (const [label, raw] of [
    ['over cap', 'x'.repeat(5000)],
    ['non-ascii over cap', '€'.repeat(1400)],          // 4200 BYTES
    ['bad json', '{nope'],
    ['bad utf8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ['array', '[]'],
    ['missing seq', JSON.stringify({ ...FRAME, seq: undefined })],
    ['fractional seq', JSON.stringify({ ...FRAME, seq: 1.5 })],
    ['fractional t_ms', JSON.stringify({ ...FRAME, t_ms: 1.5 })],
    ['zero seq', JSON.stringify({ ...FRAME, seq: 0 })],
    ['bad nonce', JSON.stringify({ ...FRAME, nonce: 'x' })],
    ['bad gen', JSON.stringify({ ...FRAME, gen: 'a/b' })],
    ['bad pid', JSON.stringify({ ...FRAME, pid: -1 })],
    ['bad ver', JSON.stringify({ ...FRAME, ver: '2.2.4' })],
    ['bad pv', JSON.stringify({ ...FRAME, pv: 2 })],
    ['bool pv', JSON.stringify({ ...FRAME, pv: true })],   // never equals 1
    ['unsafe seq', JSON.stringify({ ...FRAME, seq: 9007199254740993 })],
    ['unsafe t_ms', JSON.stringify({ ...FRAME, t_ms: 9007199254740993 })],
    ['bool pid', JSON.stringify({ ...FRAME, pid: true })],
    ['bad kind', JSON.stringify({ ...FRAME, kind: 'evil' })],
    ['unknown field', JSON.stringify({ ...FRAME, secret: 'x' })],
    ['bad sid', JSON.stringify({ ...FRAME, route: { type: 'session', sessionID: 'bad' } })],
    // tagged sets: session REQUIRES the exact id; every other type carries
    // NO identity; route_err carries no route; err is a producer fixed code
    ['session no sid', JSON.stringify({ ...FRAME, route: { type: 'session' } })],
    ['home with sid', JSON.stringify({ ...FRAME, route: { type: 'home', sessionID: 'ses_a' } })],
    ['err with route', JSON.stringify({ ...FRAME, kind: 'route_err', err: 'getter_failed' })],
    ['route with err', JSON.stringify({ ...FRAME, err: 'getter_failed' })],
    ['foreign err code', JSON.stringify({ ...FRAME, kind: 'route_err', err: 'raw_traceback', route: undefined })],
  ] as const) {
    expect(typeof decodeFrame(raw as string), label).toBe('string')
  }
  // non-session tags are REDUCED to the fixed 'non-session' — a foreign or
  // private marker type never survives the decoder
  const home = decodeFrame(JSON.stringify({ ...FRAME, route: { type: 'home' } }))
  expect(home).toMatchObject({ route: { type: 'non-session' } })
  expect((home as { route?: { sessionID?: string } }).route!.sessionID).toBeUndefined()
  const marker = 'fixture_private_marker'
  const m = decodeFrame(JSON.stringify({ ...FRAME, route: { type: marker } }))
  expect(m).toMatchObject({ route: { type: 'non-session' } })
  expect(JSON.stringify(m)).not.toContain(marker)
  // producer fixed error codes decode
  const g = decodeFrame(JSON.stringify({ ...FRAME, kind: 'route_err',
    err: 'frame_over_cap', route: undefined }))
  expect(g).toMatchObject({ kind: 'route_err', err: 'frame_over_cap' })
})

it('cache: ctx-bound frames; accept/unchanged; conflict+regression REVOKE', () => {
  const c = new FrameCache()
  expect(c.update(CTX, FRAME, DIGEST, 100, 1000)).toBe('accepted')
  expect(c.current(1500, CTX)).toMatchObject({ seq: 3 })
  // same seq + identical wire digest: usable while fresh
  expect(c.update(CTX, FRAME, DIGEST, 200, 1600)).toBe('unchanged')
  // same seq + DIFFERENT wire bytes (other digest): conflict -> revoked
  expect(c.update(CTX, { ...FRAME, route: { type: 'home' } }, 'c'.repeat(64), 300, 1800)).toBe('conflict')
  expect(c.current(1900, CTX)).toBeNull()
  // healthy same-bytes recovery is 'unchanged' — the accepted watermark
  // still knows seq3/digest-A, so the SAME wire bytes restore usability
  expect(c.update(CTX, FRAME, DIGEST, 400, 2000)).toBe('unchanged')
  expect(c.update(CTX, { ...FRAME, seq: 2 }, 'd'.repeat(64), 400, 2100)).toBe('regression')
  expect(c.current(2100, CTX)).toBeNull()
  // EVERY refusal revokes a retained record — stale and future too
  expect(c.update(CTX, FRAME, DIGEST, 400, 2200)).toBe('unchanged')
  expect(c.update(CTX, { ...FRAME, seq: 4 }, 'e'.repeat(64), FRESH_MS + 1, 2300)).toBe('stale')
  expect(c.current(2300, CTX)).toBeNull()           // prior usable id is gone
  expect(c.update(CTX, FRAME, DIGEST, 400, 2400)).toBe('unchanged')
  expect(c.update(CTX, { ...FRAME, seq: 5 }, 'f'.repeat(64), -FUTURE_MS - 1, 2500)).toBe('future')
  expect(c.current(2500, CTX)).toBeNull()
})

it('cache watermark: refusals keep accepted seq/digest ordering history', () => {
  const c = new FrameCache()
  expect(c.update(CTX, FRAME, DIGEST, 100, 1000)).toBe('accepted')   // seq3/A
  // conflict at same seq other digest: refused AND revoked, ordering kept
  const other3 = { ...FRAME, route: { type: 'home' } }
  expect(c.update(CTX, other3, 'c'.repeat(64), 100, 1100)).toBe('conflict')
  expect(c.current(1100, CTX)).toBeNull()
  // post-refusal regression: a valid seq2 can NEVER be adopted after the
  // accepted seq3 — revoking usable identity did not erase ordering history
  expect(c.update(CTX, { ...FRAME, seq: 2 }, 'd'.repeat(64), 100, 1200)).toBe('regression')
  expect(c.current(1200, CTX)).toBeNull()
  // repeated conflict: seq3/digest-B stays refused forever under this ctx
  expect(c.update(CTX, other3, 'c'.repeat(64), 100, 1300)).toBe('conflict')
  expect(c.current(1300, CTX)).toBeNull()
  // same seq+same digest recovery stays usable while fresh
  expect(c.update(CTX, FRAME, DIGEST, 100, 1400)).toBe('unchanged')
  expect(c.current(1500, CTX)).toMatchObject({ seq: 3 })
  // stale/future/malformed refusals keep the watermark too
  expect(c.update(CTX, { ...FRAME, seq: 5 }, 'e'.repeat(64), FRESH_MS + 1, 1600)).toBe('stale')
  expect(c.update(CTX, { ...FRAME, seq: 2 }, 'd'.repeat(64), 100, 1700)).toBe('regression')
  expect(c.update(CTX, { nope: 1 }, 'f'.repeat(64), 100, 1750)).toBe('frame_invalid')
  expect(c.update(CTX, { ...FRAME, seq: 2 }, 'd'.repeat(64), 100, 1780)).toBe('regression')
  // higher-seq healthy neighbor: a NEW higher seq may still be accepted
  expect(c.update(CTX, { ...FRAME, seq: 6 }, 'f'.repeat(64), 100, 1800)).toBe('accepted')
  expect(c.current(1800, CTX)).toMatchObject({ seq: 6 })
})

it('cache: ctx is validated vs FRAME every time; foreign revokes, none adopted', () => {
  const c = new FrameCache()
  // a FIRST frame whose pid/gen/nonce disagree with the submitted context is
  // foreign — the context fields are never adopted from wire data
  const badPid = { ...FRAME, pid: 7777 }
  expect(c.update(CTX, badPid, DIGEST, 100, 1000)).toBe('foreign_context')
  expect(c.current(1000, CTX)).toBeNull()
  // a wrong nonce under the expected ctx is foreign on EVERY attempt —
  // retrying the identical wrong record never becomes acceptable
  const wrongN = { ...FRAME, nonce: 'b'.repeat(32) }
  expect(c.update(CTX, wrongN, 'c'.repeat(64), 100, 1100)).toBe('foreign_context')
  expect(c.update(CTX, wrongN, 'c'.repeat(64), 100, 1200)).toBe('foreign_context')
  expect(c.current(1200, CTX)).toBeNull()
  // healthy bind, then a foreign-context update revokes and is not adopted
  expect(c.update(CTX, FRAME, DIGEST, 100, 2000)).toBe('accepted')
  const other = { ...CTX, pid: 7777, gen: '42' }
  const fo = { ...FRAME, pid: 7777, gen: '42' }
  expect(c.update(other, fo, 'd'.repeat(64), 100, 2100)).toBe('foreign_context')
  expect(c.current(2100, other)).toBeNull()
  expect(c.current(2100, CTX)).toBeNull()
  // the instance NEVER rebinds: the identical foreign update stays foreign
  // forever — there is no automatic adoption on retry or over time
  expect(c.update(other, fo, 'd'.repeat(64), 120, 2200)).toBe('foreign_context')
  expect(c.current(2200, other)).toBeNull()
  // a genuinely changed context needs an EXPLICIT new cache — then a fresh
  // bound exchange can succeed; the former A stays unavailable under B
  const c2 = new FrameCache()
  expect(c2.update(other, fo, 'd'.repeat(64), 120, 2200)).toBe('accepted')
  expect(c2.current(2200, other)).toMatchObject({ pid: 7777 })
  expect(c.current(2200, other)).toBeNull()
  // frame nonce disagreeing with the bound context: foreign, revoked
  expect(c2.update(other, { ...fo, nonce: 'b'.repeat(32) }, 'e'.repeat(64), 100, 3000)).toBe('foreign_context')
  expect(c2.current(3000, other)).toBeNull()
})

it('cache: stored ctx/frame frozen — caller mutation cannot rewrite trust', () => {
  const c = new FrameCache()
  const ctx = { ...CTX }
  const frame = { ...FRAME, route: { ...FRAME.route } }
  expect(c.update(ctx, frame, DIGEST, 100, 1000)).toBe('accepted')
  ctx.pid = 9                                       // mutate caller objects
  frame.pid = 9; frame.route!.sessionID = 'ses_evil'
  expect(c.current(1500, CTX)).toMatchObject({ pid: 4242,
    route: { sessionID: 'ses_a' } })
  const got = c.current(1600, CTX)!
  expect(() => { (got as any).pid = 9 }).toThrow()  // frozen record
  expect(() => { (got.route as any).sessionID = 'x' }).toThrow()
  // a caller-supplied frame with an arbitrary tag is stored NORMALIZED —
  // the marker never reaches current() through the cache path either
  const marker = 'fixture_private_marker'
  const c2 = new FrameCache()
  expect(c2.update(CTX, { ...FRAME, route: { type: marker } }, DIGEST, 100, 2000)).toBe('accepted')
  const g2 = c2.current(2100, CTX)!
  expect(g2.route).toEqual({ type: 'non-session' })
  expect(JSON.stringify(g2)).not.toContain(marker)
})

it('cache freshness: target-side age, receipt window — never coordinator wall', () => {
  const c = new FrameCache()
  expect(c.update(CTX, FRAME, DIGEST, FRESH_MS + 1, 1000)).toBe('stale')
  expect(c.current(1000, CTX)).toBeNull()
  expect(c.update(CTX, FRAME, DIGEST, -FUTURE_MS - 1, 1000)).toBe('future')
  expect(c.update(CTX, FRAME, DIGEST, 50, 1000)).toBe('accepted')
  expect(c.current(1000 + RECEIPT_MS - 1, CTX)).not.toBeNull()
  expect(c.current(1000 + RECEIPT_MS + 1, CTX)).toBeNull()
  // a repeated OLD cache read is not a fresh exchange: receipt expiry
  // alone makes identity unavailable even without a new getter call
})

it('cache freshness decays: target age grows WITH elapsed receipt time', () => {
  const c = new FrameCache()
  // near-fresh frame: expires mid-window, long BEFORE RECEIPT_MS elapses
  expect(c.update(CTX, FRAME, DIGEST, FRESH_MS - 100, 1000)).toBe('accepted')
  expect(c.current(1099, CTX)).not.toBeNull()       // age FRESH-1 still ok
  expect(c.current(1101, CTX)).toBeNull()           // age >FRESH: gone mid-window
  // healthy neighbor: young frame still usable for the whole receipt window
  const c2 = new FrameCache()
  expect(c2.update(CTX, FRAME, DIGEST, 50, 1000)).toBe('accepted')
  expect(c2.current(1000 + RECEIPT_MS - 1, CTX)).not.toBeNull()
  expect(c2.current(1000 + RECEIPT_MS + 1, CTX)).toBeNull()
})
