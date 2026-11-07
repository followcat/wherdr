// One bounded canonical piece of a fixed session/page snapshot through the
// OPENCODE_CHUNK helper: the caller's complete expected descriptor is
// validated before exec, the reply envelope's actual bytes before decode, and
// the piece's canonical base64 before allocation. This is one validated piece
// of an already-fingerprinted snapshot, not a complete reader: assembly,
// retries and full-snapshot verification are a later unit. Home, timeout and
// transport-failure validation are shared with discovery/metadata, never
// duplicated; no stderr, traceback, body or unknown field is forwarded.
import type { ShellExec } from './fsx'
import { OPENCODE_CHUNK } from './opencodeChunk'
import { FINGERPRINT_OK, HELPER_ERRORS, READ_LIMIT, SERVER_OK,
  failure, helperTimeout, replyObject, validHome, validReadTarget } from './opencodeTransport'

export type OpencodeReadChunk =
  | { ok: true, server: string, fingerprint: string, size: number, offset: number, piece: Buffer }
  | { ok: false, status: number, server: string }
  | { ok: false, error: string }

const CHUNK_ERRORS = new Set([...Array.from(HELPER_ERRORS), 'invalid_request', 'too_large', 'snapshot_changed'])
// The helper's fixed piece bound, mirrored inside OPENCODE_CHUNK.
const PIECE_LIMIT = 4 * 1024 * 1024
// The fixed envelope fields around the base64 piece.
const ENVELOPE = 256
// Strict alphabet only: no whitespace, padding at most two trailing chars.
const B64_OK = /^[A-Za-z0-9+/]*={0,2}$/
const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

// Canonical base64 for exactly `expected` bytes: the exact encoded length,
// the strict alphabet, exactly the required trailing padding and zero unused
// low bits in the last sextet. Buffer.from('base64') alone is permissive:
// whitespace, missing or surplus padding and nonzero unused bits all decode
// silently, so each property is proven before the bounded piece is allocated.
function decodePiece(piece: unknown, expected: number): Buffer | null {
  if (typeof piece !== 'string' || piece.length !== 4 * Math.ceil(expected / 3) || !B64_OK.test(piece)) return null
  const pad = expected % 3 === 0 ? 0 : 3 - (expected % 3)
  const tail = piece.endsWith('==') ? 2 : piece.endsWith('=') ? 1 : 0
  if (tail !== pad) return null
  if (pad > 0) {
    const v = B64_CHARS.indexOf(piece.charAt(piece.length - 1 - pad))
    if (v < 0 || (v & (pad === 2 ? 15 : 3)) !== 0) return null
  }
  const out = Buffer.from(piece, 'base64')
  return out.length === expected ? out : null
}

export async function opencodeReadChunk(exec: ShellExec, home: string, request: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<OpencodeReadChunk> {
  if (!validHome(home)) {
    return { ok: false, error: 'unavailable' }
  }
  // Fixed descriptor shape only: unknown fields, ops, ids, cursors, snapshot
  // generations and non-integer sizes/offsets are refused before exec.
  const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : null
  if (!keys || keys.some(k => !['op', 'session', 'cursor', 'server', 'fingerprint', 'size', 'offset'].includes(k))
    || !validReadTarget(request)
    || typeof request.server !== 'string' || !SERVER_OK.test(request.server)
    || typeof request.fingerprint !== 'string' || !FINGERPRINT_OK.test(request.fingerprint)
    || typeof request.size !== 'number' || !Number.isSafeInteger(request.size) || request.size < 0 || request.size > READ_LIMIT
    || typeof request.offset !== 'number' || !Number.isSafeInteger(request.offset) || request.offset < 0 || request.offset > request.size) {
    return { ok: false, error: 'invalid_request' }
  }
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body, 'utf8') > 4096) return { ok: false, error: 'invalid_request' }
  // The expected piece is the helper's 4 MiB window truncated to the
  // descriptor's tail; the reply bound is its canonical base64 plus the
  // fixed envelope fields, never an unbounded caller override.
  const expected = Math.min(PIECE_LIMIT, request.size - request.offset)
  const replyLimit = 4 * Math.ceil(expected / 3) + ENVELOPE
  let r
  try {
    r = await exec('exec python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_CHUNK, home, body], { timeoutMs: helperTimeout(opts.timeoutMs), maxBytes: replyLimit })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  const reply = replyObject(r, replyLimit)
  if (reply) {
    const fields = Object.keys(reply).sort()
    // A success envelope must carry exactly this descriptor's context;
    // anything else, including a status 200 without the full envelope, is
    // not this snapshot's piece.
    if (r.code === 0 && fields.join() === 'fingerprint,offset,piece,server,size,status'
      && reply.status === 200
      && reply.server === request.server
      && reply.fingerprint === request.fingerprint
      && reply.size === request.size
      && reply.offset === request.offset) {
      const piece = decodePiece(reply.piece, expected)
      if (piece) {
        return { ok: true, server: request.server, fingerprint: request.fingerprint, size: request.size, offset: request.offset, piece }
      }
    }
    // A status-only reply is an HTTP absence or error; it still has to name
    // the expected server generation, never a different live one.
    if (r.code === 0 && fields.join() === 'server,status'
      && typeof reply.status === 'number' && Number.isSafeInteger(reply.status)
      && reply.status >= 100 && reply.status <= 599 && reply.status !== 200
      && reply.server === request.server) {
      return { ok: false, status: reply.status, server: request.server }
    }
    if (fields.join() === 'error' && typeof reply.error === 'string' && CHUNK_ERRORS.has(reply.error)) {
      return { ok: false, error: reply.error }
    }
  }
  return { ok: false, error: failure(r) }
}
