// One bounded typed catalog observation of a fixed directory through the
// OPENCODE_CATALOG helper: the request is a single exact directory validated
// before anything is sent to the machine, the reply envelope's actual bytes
// before decode, and every reduced row before any of it is returned. This is
// a bounded observation, NEVER a completeness proof: the consistency marker
// stays 'unproven' end to end. Home, timeout, reply and transport-failure
// validation are shared with discovery/metadata/chunk, never duplicated; no
// stderr, traceback, body, URL or unknown field is forwarded.
import type { ShellExec } from './fsx'
import { OPENCODE_CATALOG } from './opencodeCatalog'
import { FINGERPRINT_OK, HELPER_ERRORS, SERVER_OK,
  failure, helperTimeout, replyObject, validHome } from './opencodeTransport'

export type OpencodeCatalogRow = {
  id: string, parent: string | null, fork: string | null
  title: string | null, directory: string, subpath: string | null
  created: number, updated: number
  viewed: number | null, idle: number | null, archived: number | null
}

export type OpencodeReadCatalog =
  | { ok: true, server: string, fingerprint: string, directory: string, pages: number,
      size: number, rows: OpencodeCatalogRow[], exhausted: true, consistency: 'unproven' }
  | { ok: false, status: number, server: string }
  | { ok: false, error: string }

const CATALOG_ERRORS = new Set([...Array.from(HELPER_ERRORS), 'invalid_request', 'too_large', 'snapshot_changed'])
// The fixed reply budget: 4 MiB of canonical rows plus bounded envelope
// fields fits inside 5 MiB; it is not caller-configurable.
const CATALOG_REPLY = 5 * 1024 * 1024
const CATALOG_LIMIT = 4 * 1024 * 1024
const MAX_TIME = 8640000000000000
const ID_OK = /^ses_[0-9A-Za-z_-]{1,124}$/
const CONTROL = /[\x00-\x1f\x7f]/
// A lone surrogate is a UTF-16 unit without its mate; a valid astral pair is
// well-formed text the Python contract accepts as one code point, so pairs
// must never trip the surrogate check.
const loneSurrogate = (s: string) => {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff) return true
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1)
      if (!(n >= 0xdc00 && n <= 0xdfff)) return true
      i += 1
    }
  }
  return false
}
const ROW_FIELDS = 'archived,created,directory,fork,id,idle,parent,subpath,title,updated,viewed'

// Mirrors of the fixed Python scalar contract in CATALOG_ROW_RULES, never a
// second parser semantics: a cheap character bound before the bounded UTF-8
// byte check so no oversized field is encoded, lone surrogates refused
// explicitly.
const boundedText = (v: unknown) => typeof v === 'string' && !v.includes('\0')
  && v.length <= 1024 && !loneSurrogate(v) && Buffer.byteLength(v, 'utf8') <= 1024
const pathOk = (v: unknown) => typeof v === 'string' && v.startsWith('/')
  && v.length <= 1024 && !loneSurrogate(v) && !CONTROL.test(v)
  && Buffer.byteLength(v, 'utf8') <= 1024
const stamp = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_TIME

const rowOk = (v: unknown): v is OpencodeCatalogRow => {
  const r = v as Record<string, unknown>
  return r !== null && typeof r === 'object' && !Array.isArray(r)
    && Object.keys(r).sort().join() === ROW_FIELDS
    && typeof r.id === 'string' && ID_OK.test(r.id)
    && (r.parent === null || typeof r.parent === 'string' && ID_OK.test(r.parent))
    && (r.fork === null || typeof r.fork === 'string' && ID_OK.test(r.fork))
    && (r.title === null || boundedText(r.title))
    && pathOk(r.directory)
    && (r.subpath === null || boundedText(r.subpath))
    && stamp(r.created) && stamp(r.updated)
    && (r.viewed === null || stamp(r.viewed))
    && (r.idle === null || stamp(r.idle))
    && (r.archived === null || stamp(r.archived))
}

export async function opencodeReadCatalog(exec: ShellExec, home: string, request: Record<string, unknown>): Promise<OpencodeReadCatalog> {
  if (!validHome(home)) {
    return { ok: false, error: 'unavailable' }
  }
  // Fixed request shape only: exactly one exact directory; anything else is
  // refused before anything is sent to the machine.
  const keys = request && typeof request === 'object' && !Array.isArray(request) ? Object.keys(request) : null
  // The exact directory is bound once, before exec: a caller mutating its
  // own object during the walk can never make a forged reply directory
  // match what was submitted.
  const directory = keys ? request.directory : null
  if (!keys || keys.join() !== 'directory' || !pathOk(directory)) {
    return { ok: false, error: 'invalid_request' }
  }
  const body = JSON.stringify(request)
  if (Buffer.byteLength(body, 'utf8') > 4096) return { ok: false, error: 'invalid_request' }
  let r
  try {
    // Fixed bounds for this fixed operation: the helper's inner 20 s
    // deadline inside a clamped 30 s exec budget with cleanup margin, and a
    // 5 MiB reply ceiling over 4 MiB canonical rows plus envelope fields.
    r = await exec('exec python3 -X utf8 -c "$1" "$2" "$3"', [OPENCODE_CATALOG, home, body],
      { timeoutMs: helperTimeout(30000), maxBytes: CATALOG_REPLY })
  } catch {
    return { ok: false, error: 'unavailable' }
  }
  const reply = replyObject(r, CATALOG_REPLY)
  if (reply) {
    const fields = Object.keys(reply).sort()
    // A success carries exactly the fixed observation envelope: this exact
    // directory, the opaque generation and fingerprint, bounded traversal
    // counts, and the unproven marker -- never a completeness flag.
    if (r.code === 0 && fields.join() === 'consistency,directory,exhausted,fingerprint,pages,rows,server,size,status'
      && reply.status === 200
      && reply.consistency === 'unproven'
      && reply.exhausted === true
      && typeof reply.server === 'string' && SERVER_OK.test(reply.server)
      && typeof reply.fingerprint === 'string' && FINGERPRINT_OK.test(reply.fingerprint)
      && typeof reply.directory === 'string' && reply.directory === directory
      && typeof reply.pages === 'number' && Number.isSafeInteger(reply.pages)
      && reply.pages >= 1 && reply.pages <= 8
      && typeof reply.size === 'number' && Number.isSafeInteger(reply.size)
      && reply.size >= 2 && reply.size <= CATALOG_LIMIT
      && Array.isArray(reply.rows) && reply.rows.length <= 512) {
      const ids = new Set<string>()
      const rows: OpencodeCatalogRow[] = []
      let valid = true
      for (const item of reply.rows) {
        if (!rowOk(item) || ids.has(item.id)) { valid = false; break }
        ids.add(item.id)
        rows.push(item)
      }
      if (valid) {
        return { ok: true, server: reply.server, fingerprint: reply.fingerprint,
          directory: reply.directory, pages: reply.pages, size: reply.size,
          rows, exhausted: true, consistency: 'unproven' }
      }
    }
    // A status-only reply is an HTTP absence or error; the opaque server
    // generation is evidence, not a success without the full envelope.
    if (r.code === 0 && fields.join() === 'server,status'
      && typeof reply.status === 'number' && Number.isSafeInteger(reply.status)
      && reply.status >= 100 && reply.status <= 599 && reply.status !== 200
      && typeof reply.server === 'string' && SERVER_OK.test(reply.server)) {
      return { ok: false, status: reply.status, server: reply.server }
    }
    if (fields.join() === 'error' && typeof reply.error === 'string' && CATALOG_ERRORS.has(reply.error)) {
      return { ok: false, error: reply.error }
    }
  }
  return { ok: false, error: failure(r) }
}
