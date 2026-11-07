// opencode-identity bounded frame codec — shared by the producer (encode)
// and the read-side consumer (validate). Pure module: no I/O.
// A frame is ONE bounded JSON object (<= FRAME_CAP chars) projected from
// ctx.ui.router.current() by the producing TUI process. Provenance (kernel
// peer credentials, process liveness/birth) is a SEPARATE concern of the
// caller's process binding — a parsed JSON pid field never proves it here.
// The context consumer (nonce/pid/gen/ver binding, freshness, ordered
// FrameCache) ships with the read-side helper unit — wire codec only here.

export const FRAME_CAP = 4096          // BYTES on the wire, not chars
export const FRAME_PROTOCOL = 1
const TYPE_CAP = 32
// exact session identity grammar — same contract as the catalog reader;
// anything else is non-session, never a truncated id
const SESSION_ID = /^ses_[0-9A-Za-z_-]{1,124}$/

export interface Frame {
  seq: number, nonce: string, pid: number, gen: string, t_ms: number
  pv?: number, ver?: string, kind: string
  route?: { type: string, sessionID?: string }
  err?: string
}

// bounded route projection: a session route yields its EXACT sessionID —
// an overlong or missing id becomes 'non-session' (unavailable), never a
// truncated id that could collide with another session's identity
export function projectRoute(route: unknown): { type: string, sessionID?: string } {
  if (!route || typeof route !== 'object') return { type: 'unknown' }
  const t = (route as { type?: unknown }).type
  const type = typeof t === 'string' ? t.slice(0, TYPE_CAP) : 'unknown'
  if (type !== 'session') return { type }
  const sid = (route as { sessionID?: unknown }).sessionID
  if (typeof sid !== 'string' || !SESSION_ID.test(sid))
    return { type: 'non-session' }
  return { type: 'session', sessionID: sid }
}

// JSON encode with the BYTE cap enforced BEFORE the caller writes it;
// null when the projection could not stay inside the bound
export function encodeFrame(rec: Frame): string | null {
  const s = JSON.stringify(rec)
  return Buffer.byteLength(s, 'utf8') <= FRAME_CAP ? s : null
}

// The bounded decoder (byte cap -> parse -> schema/context/freshness ->
// ordered single-consumer cache) ships with the read-side helper unit —
// this unit ships the producer and the projected bounded encoder only.
