// A file of the agent's machine, whole, as an attachment: the same paths and
// checks as its preview (files/read.get.ts), up to DOWNLOAD_BYTES.
// `inline=1`: PDF bytes for the canvas preview and Open's native viewer, or a
// video streamed for the <video> preview and Open, at any size (200 whole,
// 206 for a Range); any other file is still only an attachment.
// GET and HEAD (files/download.get.ts, download.head.ts).
import type { H3Event } from 'h3'
import { getQuery, getRequestHeader, setResponseHeader, setResponseStatus } from 'h3'
import { attachmentHeader, isPdf, readFileBytes, readWrittenBytes, videoType } from './files'
import { HerdrError } from './herdr'
import { coreFilesMachine } from './coreFilesMachine'
import { defineApi } from './http'
import { findPane } from './state'
import { chatFilesPolicy } from './chatFiles'
import { answer, cutOnError, openVideo, openWrittenVideo } from './videoStream'

import type { Pane } from '../../shared/types'

async function serveVideo(event: H3Event, p: Pane, q: Record<string, unknown>, type: string) {
  const m = await coreFilesMachine(p.machine)
  const res = event.node.res
  // The browser drops a request (seek, closed player): the read stops with
  // it, from the start: while the file opens too.
  const closed = new AbortController()
  res.once('close', () => closed.abort())
  if (res.destroyed) closed.abort()
  const v = q.from === 'chat'
    ? await openWrittenVideo(m, p.cwd, q.path, closed.signal, await chatFilesPolicy())
    : await openVideo(m, p.cwd!, q.path, closed.signal)
  if (closed.signal.aborted) {
    v.close()
    return ''
  }
  closed.signal.addEventListener('abort', v.close, { once: true })
  try {
    // Only ever a video type (nosniff): never rendered as a page, whatever the bytes.
    setResponseHeader(event, 'x-content-type-options', 'nosniff')
    setResponseHeader(event, 'accept-ranges', 'bytes')
    setResponseHeader(event, 'content-security-policy', "default-src 'none'; media-src 'self'; frame-ancestors 'self'")
    setResponseHeader(event, 'etag', v.etag)
    setResponseHeader(event, 'last-modified', new Date(v.mtime * 1000).toUTCString())
    const a = answer(v, { method: event.method, range: getRequestHeader(event, 'range'), ifRange: getRequestHeader(event, 'if-range') })
    setResponseStatus(event, a.status)
    if (a.contentRange) setResponseHeader(event, 'content-range', a.contentRange)
    if (a.status === 416) {
      v.close()
      setResponseHeader(event, 'content-type', 'text/plain')
      return ''
    }
    setResponseHeader(event, 'content-type', type)
    setResponseHeader(event, 'content-disposition', attachmentHeader(v.name, 'inline'))
    setResponseHeader(event, 'content-length', a.len)
    if (event.method === 'HEAD' || !a.len) {
      v.close()
      return ''
    }
    return cutOnError(res, v.read(a.start, a.len))
  } catch (e) {
    v.close()
    throw e
  }
}

export const fileDownload = defineApi(async (event) => {
  const q = getQuery(event)
  const p = findPane(String(q.pane || ''))
  if (!p) throw new HerdrError('bad_pane', 'Pane not found')
  if (q.from !== 'chat' && !p.cwd) throw new HerdrError('bad_cwd', 'This agent’s folder is unknown')
  const video = q.inline === '1' ? videoType(String(q.path || '')) : undefined
  if (video) return serveVideo(event, p, q, video)
  const f = q.from === 'chat'
    ? await readWrittenBytes(await coreFilesMachine(p.machine), p.cwd, q.path, await chatFilesPolicy())
    : await readFileBytes(await coreFilesMachine(p.machine), p.cwd!, q.path)
  setResponseHeader(event, 'x-content-type-options', 'nosniff')
  if (q.inline === '1' && isPdf(f.name, f.body)) {
    // Only ever a PDF (nosniff): the browser hands it to its PDF viewer, which
    // runs nothing in this origin. No `sandbox`: Chrome and Safari refuse to
    // show a PDF in a sandboxed document. Framed by the app only.
    setResponseHeader(event, 'content-type', 'application/pdf')
    setResponseHeader(event, 'content-disposition', attachmentHeader(f.name, 'inline'))
    setResponseHeader(event, 'content-security-policy', "default-src 'none'; object-src 'self'; frame-ancestors 'self'")
    setResponseHeader(event, 'cache-control', 'private, no-store')
    return f.body
  }
  // Never shown nor run by the browser, only saved.
  setResponseHeader(event, 'content-type', 'application/octet-stream')
  setResponseHeader(event, 'content-disposition', attachmentHeader(f.name))
  setResponseHeader(event, 'content-security-policy', "default-src 'none'; sandbox")
  return f.body
})
