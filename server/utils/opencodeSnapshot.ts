// Bounded verified assembly of one fixed OpenCode snapshot: fresh metadata,
// ordered <=4 MiB pieces through the accepted wrappers, and the full
// canonical fingerprint re-proven before any body is returned. A single
// monotonic deadline covers metadata, every piece and the one allowed
// restart; identical concurrent requests coalesce per machine so a burst or
// a string of caller timeouts can never spawn unbounded machine work.
// Still an inactive transport foundation: no cache, parser, session
// selection or UI here.
import { createHash } from 'node:crypto'
import type { ShellExec } from './fsx'
import { FINGERPRINT_OK, READ_LIMIT, validHome, validReadTarget } from './opencodeTransport'
import { opencodeReadMeta } from './opencodeReadMeta'
import { opencodeReadChunk } from './opencodeReadChunk'

export type OpencodeSnapshot =
  | { ok: true, server: string, fingerprint: string, size: number, unchanged: true }
  | { ok: true, server: string, fingerprint: string, size: number, unchanged: false, body: Buffer }
  | { ok: false, status: number, server: string }
  | { ok: false, error: string }

const MAX_INFLIGHT = 16
// A call is never started without enough budget for the helper's largest
// bounded cleanup unit: the 4s owned-CLI probe deadline plus its group kill.
const MIN_CALL_MS = 5000
const MAX_BUDGET_MS = 120000
const DEFAULT_BUDGET_MS = 60000

interface Ctx { home: string, op: string, session: string, cursor: string, expect: string }

// The helper fingerprints sha256 of a Python json.dumps list; its default
// separators put ", " between elements. Rebuilt element by element so an
// opaque cursor's comma, quote or backslash stays escaped inside its own
// string, never globally rewritten.
const snapshotFingerprint = (server: string, session: string, op: string, cursor: string, digest: string) =>
  createHash('sha256')
    .update('[' + [server, session, op, cursor, digest].map(s => JSON.stringify(s)).join(', ') + ']')
    .digest('hex')

const LATE = Symbol('late')
// One wrapper call inside the aggregate deadline: the call gets the bounded
// remaining budget; if the deadline wins, the call drains in the background
// and nothing it produces can publish or start further reads. The clock is
// re-read after synchronous work inside call() and again after the await:
// a resolved continuation can beat an overdue timer but never publishes late.
async function bounded<T>(deadline: number, pending: Promise<unknown>[], call: (remaining: number) => Promise<T>): Promise<T | typeof LATE> {
  const remaining = deadline - performance.now()
  if (remaining < MIN_CALL_MS) return LATE
  const p = call(remaining)
  const left = deadline - performance.now()
  if (left <= 0) { pending.push(p); return LATE }
  let timer: NodeJS.Timeout | undefined
  try {
    const winner = await Promise.race([p, new Promise<typeof LATE>(resolve => {
      timer = setTimeout(() => resolve(LATE), left)
      timer.unref?.()
    })])
    if (winner === LATE || performance.now() >= deadline) { pending.push(p); return LATE }
    return winner as T
  } finally {
    clearTimeout(timer)
  }
}

// One attempt: fresh metadata, ordered pieces into a bounded buffer, then
// the full assembled fingerprint. 'retry' marks a retryable snapshot change.
async function attempt(exec: ShellExec, ctx: Ctx, deadline: number, pending: Promise<unknown>[]): Promise<OpencodeSnapshot | 'retry'> {
  const metaReq: Record<string, unknown> = { op: ctx.op, session: ctx.session }
  if (ctx.cursor) metaReq.cursor = ctx.cursor
  if (ctx.expect) metaReq.expect = ctx.expect
  const m = await bounded(deadline, pending, r => opencodeReadMeta(exec, ctx.home, metaReq, { timeoutMs: r }))
  if (m === LATE) return { ok: false, error: 'unreachable' }
  if (!m.ok) return m
  if (m.unchanged) {
    // The helper emits unchanged:true only when expect equals the returned
    // fingerprint; anything else is malformed, never silent retention.
    return m.fingerprint === ctx.expect
      ? { ok: true, server: m.server, fingerprint: m.fingerprint, size: m.size, unchanged: true }
      : { ok: false, error: 'unavailable' }
  }
  if (m.size > READ_LIMIT) return { ok: false, error: 'unavailable' }
  const body = Buffer.alloc(m.size)
  let got = 0
  // At most six pieces: the wrapper's exact-length contract makes every
  // iteration advance min(4 MiB, remaining) inside the 24 MiB total.
  while (got < m.size) {
    const desc: Record<string, unknown> = { op: ctx.op, session: ctx.session, server: m.server, fingerprint: m.fingerprint, size: m.size, offset: got }
    if (ctx.cursor) desc.cursor = ctx.cursor
    const c = await bounded(deadline, pending, r => opencodeReadChunk(exec, ctx.home, desc, { timeoutMs: r }))
    if (c === LATE) return { ok: false, error: 'unreachable' }
    if (!c.ok) return 'error' in c && c.error === 'snapshot_changed' ? 'retry' : c
    if (!c.piece.length) return { ok: false, error: 'unavailable' }
    c.piece.copy(body, got)
    got += c.piece.length
  }
  const digest = createHash('sha256').update(body).digest('hex')
  const assembled = snapshotFingerprint(m.server, ctx.session, ctx.op, ctx.cursor, digest)
  // All hashing precedes the publication decision: hashing the assembled
  // buffer is real work after the last bounded call, and the body or a
  // retry may only be returned while the deadline still holds.
  if (performance.now() >= deadline) return { ok: false, error: 'unreachable' }
  return assembled === m.fingerprint
    ? { ok: true, server: m.server, fingerprint: m.fingerprint, size: m.size, unchanged: false, body }
    : 'retry'
}

async function run(exec: ShellExec, ctx: Ctx, deadline: number, pending: Promise<unknown>[]): Promise<OpencodeSnapshot> {
  for (let tries = 0; tries < 2; tries++) {
    const r = await attempt(exec, ctx, deadline, pending)
    if (r !== 'retry') return r
  }
  return { ok: false, error: 'snapshot_changed' }
}

// A machine-owned reader: concurrent work is bound to this exec; identical
// requests (home, read target, expected fingerprint and budget) coalesce,
// different ones never mix. The map entry outlives settlement until every
// spawned call has drained, so a string of caller timeouts cannot spawn
// unbounded machine work underneath a stuck call.
export function opencodeSnapshots(exec: ShellExec) {
  const inflight = new Map<string, Promise<OpencodeSnapshot>>()

  function read(home: string, request: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<OpencodeSnapshot> {
    if (!validHome(home)) return Promise.resolve({ ok: false, error: 'unavailable' })
    const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : null
    if (!keys || keys.some(k => !['op', 'session', 'cursor', 'expect'].includes(k))
      || !validReadTarget(request)
      || (request.expect !== undefined && (typeof request.expect !== 'string' || !FINGERPRINT_OK.test(request.expect)))) {
      return Promise.resolve({ ok: false, error: 'invalid_request' })
    }
    // The request is snapshotted into owned primitives before any await:
    // retries and coalescing never observe a mutated caller object.
    const op = request.op as string
    const session = request.session as string
    const cursor = typeof request.cursor === 'string' ? request.cursor : ''
    const expect = typeof request.expect === 'string' ? request.expect : ''
    const budget = opts.timeoutMs === undefined ? DEFAULT_BUDGET_MS
      : Number.isFinite(opts.timeoutMs) ? Math.min(Math.max(opts.timeoutMs, 1), MAX_BUDGET_MS) : DEFAULT_BUDGET_MS
    const key = JSON.stringify([home, op, session, cursor, expect, budget])
    const existing = inflight.get(key)
    if (existing) return existing
    if (inflight.size >= MAX_INFLIGHT) return Promise.resolve({ ok: false, error: 'busy' })
    const ctx: Ctx = { home, op, session, cursor, expect }
    const deadline = performance.now() + budget
    const pending: Promise<unknown>[] = []
    const p = run(exec, ctx, deadline, pending).catch(() => ({ ok: false, error: 'unavailable' }) as OpencodeSnapshot)
    inflight.set(key, p)
    p.finally(() => void Promise.allSettled(pending).then(() => { if (inflight.get(key) === p) inflight.delete(key) }))
    return p
  }
  return { read }
}
