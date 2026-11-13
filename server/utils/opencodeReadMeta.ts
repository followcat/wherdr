// One bounded fixed read returning only metadata: the server generation, a
// fingerprint of the canonical snapshot, its byte length and whether a
// supplied fingerprint still holds. Zero content bytes leave the machine.
// The request is validated before anything is sent to the machine and the
// helper's exact reply envelope before use; home, timeout, reply and
// transport-failure validation are shared with discovery, never duplicated.
import type { ExecResult, ShellExec } from './fsx'
import { FINGERPRINT_OK, HELPER_ERRORS, OPENCODE_META, READ_LIMIT, REPLY_LIMIT, SERVER_OK,
  SESSION_OK, failure, helperTimeout, replyObject, validHome, validPatchModel, validReadTarget } from './opencodeTransport'

export type OpencodeReadMeta =
  | { ok: true, server: string, fingerprint: string, size: number, unchanged: boolean }
  | { ok: false, status: number, server: string }
  | { ok: false, error: string }

const META_ERRORS = new Set([...Array.from(HELPER_ERRORS), 'invalid_request', 'too_large'])

// The fixed reply envelope is identical for reads and the single write: a
// proven snapshot descriptor, an HTTP absence, or a fixed error key.
function metaReply(r: ExecResult): OpencodeReadMeta {
  const reply = replyObject(r)
  if (reply) {
    const fields = Object.keys(reply).sort()
    if (r.code === 0 && fields.join() === 'fingerprint,server,size,status,unchanged'
      && reply.status === 200
      && typeof reply.server === 'string' && SERVER_OK.test(reply.server)
      && typeof reply.fingerprint === 'string' && FINGERPRINT_OK.test(reply.fingerprint)
      && typeof reply.size === 'number' && Number.isSafeInteger(reply.size) && reply.size >= 0 && reply.size <= READ_LIMIT
      && typeof reply.unchanged === 'boolean') {
      return { ok: true, server: reply.server, fingerprint: reply.fingerprint, size: reply.size, unchanged: reply.unchanged }
    }
    // A status-only reply is an HTTP absence or error; status 200 without
    // its metadata fields is a malformed success, not one of those.
    if (r.code === 0 && fields.join() === 'server,status'
      && typeof reply.status === 'number' && Number.isSafeInteger(reply.status)
      && reply.status >= 100 && reply.status <= 599 && reply.status !== 200
      && typeof reply.server === 'string' && SERVER_OK.test(reply.server)) {
      return { ok: false, status: reply.status, server: reply.server }
    }
    if (fields.join() === 'error' && typeof reply.error === 'string' && META_ERRORS.has(reply.error)) {
      return { ok: false, error: reply.error }
    }
  }
  return { ok: false, error: failure(r) }
}

export async function opencodeReadMeta(exec: ShellExec, home: string, request: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<OpencodeReadMeta> {
  if (!validHome(home)) {
    return { ok: false, error: 'unavailable' }
  }
  // Fixed request shape only: unknown fields, ops, ids and cursors are
  // refused before anything is sent to the machine. 'patch' is valid as a
  // read target (post-write chunks flow through it) but a write never
  // enters through the read wrapper — opencodePatchMeta is its only path.
  const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : null
  if (!keys || keys.some(k => !['op', 'session', 'cursor', 'expect'].includes(k))
    || request.op === 'patch' || !validReadTarget(request)
    || (request.expect !== undefined && (typeof request.expect !== 'string' || !FINGERPRINT_OK.test(request.expect)))) {
    return { ok: false, error: 'invalid_request' }
  }
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body, 'utf8') > 4096) return { ok: false, error: 'invalid_request' }
  let r
  try {
    r = await exec('exec python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_META, home, body], { timeoutMs: helperTimeout(opts.timeoutMs), maxBytes: REPLY_LIMIT })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  return metaReply(r)
}

// The whitelisted write half of the same helper: a 'patch' request carries
// only its session and the {id,providerID[,variant]} model body — the helper
// PATCHes the session's fixed path and answers the re-read descriptor.
export async function opencodePatchMeta(exec: ShellExec, home: string, request: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<OpencodeReadMeta> {
  if (!validHome(home)) {
    return { ok: false, error: 'unavailable' }
  }
  const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : null
  if (!keys || keys.some(k => !['op', 'session', 'model'].includes(k))
    || request.op !== 'patch'
    || typeof request.session !== 'string' || !SESSION_OK.test(request.session)
    || !validPatchModel(request.model)) {
    return { ok: false, error: 'invalid_request' }
  }
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body, 'utf8') > 4096) return { ok: false, error: 'invalid_request' }
  let r
  try {
    r = await exec('exec python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_META, home, body], { timeoutMs: helperTimeout(opts.timeoutMs), maxBytes: REPLY_LIMIT })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  return metaReply(r)
}
