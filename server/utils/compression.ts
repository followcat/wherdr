// Compressed API answers (server/plugins/compress.ts, on Nitro's
// `beforeResponse` hook): the phone reaches the server through a relay capped
// at about 500 KB/s, where a 44 KB state or a 57 KB conversation takes a tenth
// of a second uncompressed.
//
// The hook sees every response, so it decides on the event itself rather than
// in defineApi: /api/health and /api/client-plugins skip defineApi, and an
// answer is encoded once, in one place.
//
// Only `/api/`: static files are compressed at build time
// (`compressPublicAssets`), a streamed body or a route's own bytes (an image, a
// PDF, a downloaded file) are never buffered here.
import type { H3Event } from 'h3'
import { appendResponseHeader, getRequestHeader, getResponseHeader, setResponseHeader } from 'h3'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

export const API_PREFIX = '/api/'
// Below this, the encoding headers cost more than they save.
export const COMPRESS_MIN = 1024
// Brotli quality 4: several times smaller than gzip on JSON for about the same
// CPU; the higher levels cost tens of milliseconds on a 44 KB state.
export const BROTLI_QUALITY = 4

// Statuses whose body a compression would have to invent or invalidate.
const SKIPPED_STATUS = new Set([204, 206, 304])

// JSON and text, the only bodies that shrink: an image, a PDF or a model is
// already compressed (or must stay byte for byte, with its range requests).
const COMPRESSIBLE_TYPE = /^(?:application\/(?:json|javascript|xml|xhtml\+xml)|text\/|image\/svg\+xml)/i

// A body the route streams: a Node Readable, a web ReadableStream, or a file
// handle h3 turns into one. Its bytes are not in hand, and buffering them would
// defeat the stream. (h3 reads `buffer` and `arrayBuffer` off a body the same
// way, so a Buffer or an ArrayBuffer is never stringified by it either.)
function isStream(body: unknown) {
  if (!body || typeof body !== 'object') return false
  const b = body as { pipe?: unknown, getReader?: unknown, arrayBuffer?: unknown, buffer?: unknown }
  return typeof b.pipe === 'function' || typeof b.getReader === 'function'
    || typeof b.buffer === 'function' || typeof b.arrayBuffer === 'function'
}

// Accept-Encoding, honouring q=0 ("br;q=0, gzip") and the wildcard.
export function parseAcceptEncoding(header: string | undefined): { brotli: boolean, gzip: boolean } {
  const seen = new Map<string, number>()
  for (const part of String(header || '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';')
    if (!name) continue
    let q = 1
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p)
      if (m) q = Number(m[1])
    }
    seen.set(name, q)
  }
  const q = (name: string) => seen.get(name) ?? seen.get('*') ?? 0
  return { brotli: q('br') > 0, gzip: q('gzip') > 0 }
}

export interface EncodingRequest {
  path: string
  method: string
  status: number
  acceptEncoding?: string
  // As sent by the route; empty when it set none.
  contentType?: string
  // Already set by the route (its own encoding): never twice.
  contentEncoding?: string
  hasRange: boolean
  // Byte length of the body, or null when it is not in hand.
  bodyLength: number | null
}

// The encoding to answer with, or null to send the body as it is: gzip, or br
// when the client takes it. Every condition of the brief is one line below.
export function encodingFor(req: EncodingRequest): 'br' | 'gzip' | null {
  if (!req.path.startsWith(API_PREFIX)) return null
  // A HEAD carries no body; a range request wants bytes of a file, not an answer.
  if (req.method === 'HEAD' || req.hasRange) return null
  if (SKIPPED_STATUS.has(req.status)) return null
  if (req.contentEncoding) return null
  if (req.bodyLength === null || req.bodyLength < COMPRESS_MIN) return null
  if (!COMPRESSIBLE_TYPE.test(req.contentType || '')) return null
  const accepted = parseAcceptEncoding(req.acceptEncoding)
  if (accepted.brotli) return 'br'
  if (accepted.gzip) return 'gzip'
  return null
}

const utf8Length = (s: string) => Buffer.byteLength(s, 'utf8')

// A response header as a string (h3 may hand back a number or an array).
const header = (event: H3Event, name: string) => {
  const v = getResponseHeader(event, name)
  return v === undefined ? undefined : Array.isArray(v) ? v.join(', ') : String(v)
}

// The request's own path: h3's router rewrites `req.url` to the matched layer's
// remainder before the response hook runs (`event.path` is then unusable), so
// `originalUrl`, set by h3 when the request comes in, is the one to read.
export function requestPath(event: H3Event): string {
  const url = event.node.req.originalUrl || event.path || '/'
  const q = url.indexOf('?')
  return q < 0 ? url : url.slice(0, q)
}

// Compress this response's body in place, or leave it to h3. Runs for every
// response before h3 writes it, so `response.body` is still the returned value:
// a string (sent as it is), an object (h3 stringifies it as JSON), a Buffer
// (bytes a route made: sendImage, a PDF) or a stream.
export function compressResponse(event: H3Event, response: { body?: unknown }) {
  const body = response.body
  // A stream, a Buffer (a route's own bytes: sendImage, a PDF) or anything the
  // hook cannot read as text is left to h3 untouched.
  if (isStream(body) || Buffer.isBuffer(body)) return
  const object = body !== null && typeof body === 'object'
  const text = typeof body === 'string' ? body : object ? JSON.stringify(body) : null
  if (text === null) return
  const headerType = header(event, 'content-type') || ''
  // h3 sends an object as JSON and a string as HTML: the default type it will
  // use, so the decision and the Vary match what actually goes out.
  const contentType = headerType || (object ? 'application/json' : 'text/html')
  const size = utf8Length(text)
  const enc = encodingFor({
    path: requestPath(event),
    method: event.method,
    status: event.node.res.statusCode,
    acceptEncoding: getRequestHeader(event, 'accept-encoding'),
    contentType,
    contentEncoding: header(event, 'content-encoding'),
    hasRange: getRequestHeader(event, 'range') !== undefined,
    bodyLength: size,
  })
  // An answer the decision covers varies with Accept-Encoding, compressed or
  // not: a cache must never hand the gzip bytes to a client without it.
  if (contentType && COMPRESSIBLE_TYPE.test(contentType) && size >= COMPRESS_MIN) appendVary(event)
  if (!enc) return
  const raw = Buffer.from(text, 'utf8')
  const out = enc === 'br'
    ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } })
    : gzipSync(raw)
  response.body = out
  setResponseHeader(event, 'content-encoding', enc)
  // The length of the bytes sent, not of the JSON: a route's own
  // Content-Length would truncate the answer.
  setResponseHeader(event, 'content-length', out.length)
  // The type h3 would have sent, so the encoded body keeps its own.
  setResponseHeader(event, 'content-type', contentType)
}

function appendVary(event: H3Event) {
  const vary = header(event, 'vary') || ''
  if (!/\baccept-encoding\b/i.test(vary)) appendResponseHeader(event, 'vary', 'accept-encoding')
}
