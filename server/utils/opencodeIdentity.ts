// 6l2 consumer core: strict identity-frame decoder, immutable process
// context and an ordered single-consumer cache. Pure module — no I/O, no
// clock of its own; the caller supplies the TARGET-side frame age and the
// coordinator monotonic receipt time. A frame's own t_ms is producer
// wallclock and is NEVER compared to coordinator time.
export const FRAME_CAP = 4096          // UTF-8 BYTES on the wire
export const FRESH_MS = 15000          // max target-side frame age
export const FUTURE_MS = 5000          // tolerated producer clock skew
export const RECEIPT_MS = 2000         // coordinator trust window post-receipt
const TYPE_CAP = 32
const SESSION_ID = /^ses_[0-9A-Za-z_-]{1,124}$/
const NONCE_OK = /^[0-9a-f]{32}$/
const GEN_OK = /^\d{1,20}$/
const NS_OK = /^[a-z_]+:\[\d+\]$/
const DIGEST_OK = /^[0-9a-f]{64}$/
// err is a FIXED producer code, never reflected arbitrary text
const PRODUCER_ERRS = new Set(['getter_failed', 'frame_over_cap'])

export interface IdentFrame {
  seq: number, nonce: string, pid: number, gen: string, t_ms: number
  pv: number, ver: string, kind: 'route' | 'route_err'
  route?: { type: string, sessionID?: string }
  err?: string
}

export interface IdentContext {
  machine: string, service: string     // association keys, not proof
  pid: number, uid: number, gen: string, ns: string
  nonce: string                        // crypto instance nonce of THIS context
}

// exact field-set combos: optional route/err on the required core fields
const FRAME_KEYS = new Set([
  'seq,nonce,pid,gen,t_ms,pv,ver,kind'.split(',').sort().join(),
  'seq,nonce,pid,gen,t_ms,pv,ver,kind,route'.split(',').sort().join(),
  'seq,nonce,pid,gen,t_ms,pv,ver,kind,err'.split(',').sort().join(),
  'seq,nonce,pid,gen,t_ms,pv,ver,kind,route,err'.split(',').sort().join(),
])
// exact context field set in SORTED key order ('nonce' sorts before 'ns')
const CTX_FIELDS = 'gen,machine,nonce,ns,pid,service,uid'

// strict object schema: exact field set, exact types, exact grammar — an
// unknown field, fractional number, malformed nonce/gen/ID or foreign kind
// rejects the whole frame; nothing is passed through
export function frameSchemaOk(v: unknown): v is IdentFrame {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const f = v as Record<string, unknown>
  if (!FRAME_KEYS.has(Object.keys(f).sort().join())) return false
  if (!(typeof f.seq === 'number' && Number.isSafeInteger(f.seq) && f.seq >= 1)
      || !(typeof f.nonce === 'string' && NONCE_OK.test(f.nonce))
      || !(typeof f.pid === 'number' && Number.isSafeInteger(f.pid)
          && f.pid >= 1 && f.pid <= 4194304)
      || !(typeof f.gen === 'string' && GEN_OK.test(f.gen))
      || !(typeof f.t_ms === 'number' && Number.isSafeInteger(f.t_ms)
          && f.t_ms >= 0)
      || !(f.pv === 1 && f.ver === '2.2.5')) return false
  // tagged sets: 'route' carries a route and NO err; 'route_err' carries a
  // fixed producer code and NO route
  if (f.kind === 'route')
    return f.err === undefined && routeOk(f.route)
  if (f.kind === 'route_err')
    return f.route === undefined && typeof f.err === 'string'
        && PRODUCER_ERRS.has(f.err)
  return false
}
// a session route REQUIRES the exact grammar id; every other type carries
// NO identity at all
function routeOk(v: unknown): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const r = v as Record<string, unknown>
  if (typeof r.type !== 'string' || !r.type.length || r.type.length > TYPE_CAP
      || r.type.includes('\0')) return false
  const keys = Object.keys(r).sort().join()
  if (keys === 'sessionID,type')
    return r.type === 'session' && typeof r.sessionID === 'string'
        && SESSION_ID.test(r.sessionID)
  return keys === 'type' && r.type !== 'session'
}

// bounded decode: BYTE cap before parse, STRICT utf-8 (malformed bytes are
// never replacement-decoded), strict schema after. The reason string is a
// fixed key, never reflected input.
export function decodeFrame(raw: string | Buffer): IdentFrame | string {
  const bytes = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length
  if (bytes > FRAME_CAP) return 'frame_too_large'
  let text: string
  try {
    text = typeof raw === 'string' ? raw
      : new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch { return 'frame_invalid' }
  let v: unknown
  try { v = JSON.parse(text) } catch { return 'frame_invalid' }
  if (!frameSchemaOk(v)) return 'frame_invalid'
  return normalizeFrame(v)
}

// ONE shared bounded normalization applied at EVERY acceptance path —
// decoder, wrapper reply and cache store — so an arbitrary route label can
// never leave a public surface: 'session'+id survives, every other tag
// reduces to the fixed 'non-session'
export function normalizeFrame(f: IdentFrame): IdentFrame {
  return f.route && f.route.type !== 'session'
    ? { ...f, route: { type: 'non-session' } } : f
}

export function contextOk(v: unknown): v is IdentContext {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  const c = v as Record<string, unknown>
  return Object.keys(c).sort().join() === CTX_FIELDS
    && typeof c.machine === 'string' && /^[0-9A-Za-z_~-]{1,64}$/.test(c.machine)
    && typeof c.service === 'string' && /^[0-9a-f]{1,64}$/.test(c.service)
    && typeof c.pid === 'number' && Number.isSafeInteger(c.pid)
    && c.pid >= 1 && c.pid <= 4194304
    && typeof c.uid === 'number' && Number.isSafeInteger(c.uid) && c.uid >= 0
    && typeof c.gen === 'string' && GEN_OK.test(c.gen)
    && typeof c.ns === 'string' && NS_OK.test(c.ns)
    && typeof c.nonce === 'string' && NONCE_OK.test(c.nonce)
}
export function sameContext(a: IdentContext, b: IdentContext): boolean {
  return a.machine === b.machine && a.service === b.service
    && a.pid === b.pid && a.uid === b.uid && a.gen === b.gen
    && a.ns === b.ns && a.nonce === b.nonce
}

export type CacheVerdict = 'accepted' | 'unchanged' | 'regression' | 'conflict'
  | 'stale' | 'future' | 'foreign_context' | 'invalid_context'

const freezeFrame = (f: IdentFrame): IdentFrame => Object.freeze({
  ...f,
  route: f.route === undefined ? undefined : Object.freeze({ ...f.route }),
})

// Ordered single-consumer cache bound to one immutable context FOR ITS
// LIFETIME: a foreign context is refused and revokes retained state, never
// adopted — a genuinely changed context needs an explicit NEW FrameCache.
// EVERY frame must belong to the context it arrives under — pid/gen/nonce
// wire fields never substitute for it — and EVERY refusal revokes any
// retained usable record. update() takes the schema-validated frame plus
// the ONE helper-derived sha256 digest of its exact wire bytes — byte
// identity, never a re-serialization.
export class FrameCache {
  private ctx: Readonly<IdentContext> | null = null
  private last: { seq: number, digest: string, frame: IdentFrame,
    until: number } | null = null
  // small immutable-context watermark: the ACCEPTED seq+digest ordering/byte
  // history. A refusal revokes usable `last` but NEVER erases this — a later
  // regression or repeated conflicting byte variant stays refused; only an
  // explicit new cache rebinds a changed context. No chain/log, one record.
  private mark: { seq: number, digest: string } | null = null
  private at = -Infinity                       // coordinator monotonic receipt
  private revoke() { this.last = null }
  private refuse<T extends CacheVerdict | string>(v: T): T {
    this.revoke()
    return v
  }
  // frame must belong to ctx on EVERY call — a foreign record is refused,
  // the prior record revoked, and NOTHING from the wire is adopted
  private bound(ctx: IdentContext, f: IdentFrame): boolean {
    return f.pid === ctx.pid && f.gen === ctx.gen && f.nonce === ctx.nonce
  }
  // ageMs: producer-frame age measured on the TARGET clock during the
  // exchange; now: coordinator monotonic receipt time; digest: sha256 of
  // the exact bounded wire bytes (the ONLY byte-identity witness).
  update(ctx: IdentContext, frame: unknown, digest: unknown,
      ageMs: number, now: number): CacheVerdict | string {
    if (!contextOk(ctx)) return this.refuse('invalid_context')
    if (!frameSchemaOk(frame)) return this.refuse('frame_invalid')
    if (typeof digest !== 'string' || !DIGEST_OK.test(digest))
      return this.refuse('frame_invalid')
    const norm = normalizeFrame(frame)        // fixed-tag before trust
    if (!this.bound(ctx, norm)) return this.refuse('foreign_context')
    if (this.ctx !== null && !sameContext(this.ctx, ctx))
      return this.refuse('foreign_context')
    if (!Number.isSafeInteger(ageMs)) return this.refuse('stale')
    if (ageMs > FRESH_MS) return this.refuse('stale')
    if (ageMs < -FUTURE_MS) return this.refuse('future')
    if (this.ctx === null) this.ctx = Object.freeze({ ...ctx })
    if (this.mark !== null) {
      if (norm.seq < this.mark.seq) return this.refuse('regression')
      if (norm.seq === this.mark.seq) {
        // same seq, different wire bytes: conflicting with the ACCEPTED
        // bytes stays refused forever under this context
        if (digest !== this.mark.digest) return this.refuse('conflict')
        // identical bytes to the accepted watermark: restore usable
        // identity while fresh — 'unchanged' even if a refusal revoked it
        this.last = { seq: norm.seq, digest, frame: freezeFrame(norm),
          until: now + (FRESH_MS - ageMs) }
        this.at = now
        return 'unchanged'
      }
    }
    // a strictly newer sequence may be accepted — it becomes the watermark.
    // the wire bytes pin t_ms, so target freshness has ONE fixed expiry
    this.mark = { seq: norm.seq, digest }
    this.last = { seq: norm.seq, digest, frame: freezeFrame(norm),
      until: now + (FRESH_MS - ageMs) }
    this.at = now
    return 'accepted'
  }
  // usable only for the EXPECTED context inside the coordinator receipt
  // window, with the retained frame STILL bound to it — a formerly-good
  // record under another context is unavailable, and the cache never
  // replaces a fresh getter exchange
  current(now: number, expected: IdentContext): IdentFrame | null {
    return this.last !== null && this.ctx !== null && contextOk(expected)
        && sameContext(this.ctx, expected)
        && this.bound(expected, this.last.frame)
        && now - this.at <= RECEIPT_MS         // receipt window
        && now <= this.last.until              // TARGET-age still fresh too
      ? this.last.frame : null
  }
}
