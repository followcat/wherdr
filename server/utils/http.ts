// HTTP helpers shared by the routes: anti-CSRF guard, body reading, error
// format identical to the old server.js ({ error, code } + 400/401/403/503).
import type { H3Event, EventHandlerRequest } from 'h3'
import type { IncomingMessage } from 'node:http'
import { defineEventHandler, getRequestHeader, getRequestHeaders, setResponseHeader, setResponseStatus, getRequestURL } from 'h3'
import { jsonBody } from './gzipJson'
import { createAuth, type ReqLike } from './auth'
import { DATA_DIR, PASSKEY_USER, log } from './env'
import { HerdrError } from './herdr'

export const auth = createAuth({ dataDir: DATA_DIR, log, passkeyUser: PASSKEY_USER })

export const reqOf = (event: H3Event): ReqLike => ({ headers: getRequestHeaders(event) as Record<string, string | undefined> })

// Who is asking, for a per-client limit: the TCP peer, or, from this machine
// (tailscale serve, a local proxy), the address the proxy appended last to
// X-Forwarded-For. A forged header only moves the caller to another bucket;
// the global caps still hold.
export function clientKey(event: H3Event): string {
  const peer = event.node.req.socket?.remoteAddress || ''
  const local = /^(127\.|::1$|::ffff:127\.)/.test(peer)
  const fwd = String(getRequestHeader(event, 'x-forwarded-for') || '').split(',').map(s => s.trim()).filter(Boolean)
  return local && fwd.length ? fwd[fwd.length - 1]! : peer
}

// Anti-CSRF: writes require JSON (hence a CORS preflight we never
// satisfy) and an Origin identical to the host.
export function sameOrigin(headers: { origin?: string | null, host?: string | null }) {
  const o = headers.origin
  if (!o) return false
  try { return new URL(o).host === headers.host }
  catch { return false }
}

const BODY_MAX = 256 * 1024

// Request body, read as it arrives: past `max` bytes (declared or received,
// chunked included) nothing more is kept, the rest is discarded and the
// connection closes once the error is sent. Resolves null when too large.
export function readBodyLimited(req: IncomingMessage, max: number): Promise<Buffer | null> {
  if (Number(req.headers['content-length'] || 0) > max) {
    req.resume()
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const stop = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
    }
    const onData = (c: Buffer) => {
      size += c.length
      if (size <= max) return void chunks.push(c)
      stop()
      req.resume()
      resolve(null)
    }
    const onEnd = () => { stop(); resolve(Buffer.concat(chunks)) }
    const onError = (e: Error) => { stop(); reject(e) }
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

// Error response, in the old server's format.
export function sendError(event: H3Event, status: number, body: Record<string, unknown>) {
  setResponseStatus(event, status)
  setResponseHeader(event, 'cache-control', 'no-store')
  return body
}

interface ApiOptions {
  // Binary body accepted (photos): MIME type checked by the expression.
  raw?: RegExp
  // Largest binary body (default 20 MB) and the error given beyond it.
  max?: number
  tooLarge?: string
  // Written to by an agent with its task's key, not by the app: no Origin to
  // check (the route checks the key; server/api/pm/shot.post.ts).
  agentKey?: boolean
}

// An API route: write checks, JSON body, known errors -> { error, code }.
export function defineApi<T>(
  fn: (event: H3Event<EventHandlerRequest>, body: Json) => Promise<T> | T,
  opts: ApiOptions = {},
) {
  return defineEventHandler(async (event) => {
    const url = getRequestURL(event)
    try {
      let body: Json = {}
      // Every write (POST, DELETE…) comes from the app's own origin; reads
      // (GET, HEAD) change nothing.
      const write = event.method !== 'GET' && event.method !== 'HEAD'
      if (write && !opts.agentKey && !sameOrigin(getRequestHeaders(event))) return sendError(event, 403, { error: 'Origin refused' })
      if (event.method === 'POST') {
        const headers = getRequestHeaders(event)
        const ctype = String(headers['content-type'] || '')
        // Non-"simple" types (JSON, image/*): another site cannot send them
        // without a CORS preflight, which we never satisfy.
        const typeOk = opts.raw ? opts.raw.test(ctype) : ctype.startsWith('application/json')
        if (!typeOk) return sendError(event, 403, { error: 'Origin refused' })
        const max = opts.raw ? opts.max || 20 * 1024 * 1024 : BODY_MAX
        const tooLarge = opts.raw ? opts.tooLarge || 'Image too large (20 MB max)' : 'Request too large'
        const raw = await readBodyLimited(event.node.req, max)
        if (!raw) {
          setResponseHeader(event, 'connection', 'close')
          throw new HerdrError('too_large', tooLarge)
        }
        if (opts.raw) body = { data: raw, ctype }
        else {
          try { body = raw.length ? JSON.parse(raw.toString('utf8')) : {} }
          catch { throw new HerdrError('bad_json', 'Invalid JSON') }
        }
      }
      const out = await fn(event, body)
      setResponseHeader(event, 'cache-control', 'no-store')
      // The lock routes set or clear the session cookie.
      if (out && typeof out === 'object' && '__cookie' in out) {
        const o = out as Record<string, unknown>
        setResponseHeader(event, 'set-cookie', String(o.__cookie))
        delete o.__cookie
      }
      return gzipJson(event, out)
    } catch (e) {
      const err = e as Error & { code?: string }
      const known = e instanceof HerdrError || (url.pathname.startsWith('/api/auth/') && Boolean(err.code))
      const code = known ? err.code : 'internal'
      if (!known) log('error', event.method, url.pathname, e)
      const status = err.code === 'unreachable' ? 503 : err.code === 'locked' ? 401 : err.code === 'rate_limited' ? 429 : 400
      return sendError(event, status, { error: err.message, code })
    }
  })
}

// Large JSON answers gzipped when the browser takes it (gzipJson.ts).
function gzipJson<T>(event: H3Event, out: T): T | Buffer | string {
  const r = jsonBody(getRequestHeader(event, 'accept-encoding'), out)
  setResponseHeader(event, 'vary', 'accept-encoding')
  if (!r) return out
  setResponseHeader(event, 'content-type', 'application/json')
  if (r.gzip) setResponseHeader(event, 'content-encoding', 'gzip')
  return r.body
}

// Binary image (conversation or sent photo).
export function sendImage(event: H3Event, img: { type: string, body: Buffer }) {
  setResponseHeader(event, 'content-type', img.type)
  setResponseHeader(event, 'cache-control', 'private, max-age=86400')
  setResponseHeader(event, 'x-content-type-options', 'nosniff')
  // Opened alone in a tab, the image runs nothing.
  setResponseHeader(event, 'content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
  return img.body
}
