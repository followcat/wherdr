// On-device ASR model weights (DATA_DIR/models/**) — large blobs fetched by the
// browser once, then held in Cache Storage. Kept out of the app bundle so the
// ~200 MB survives redeploys and never lands in the npm tarball.
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import path from 'node:path'

export default defineEventHandler(async (event) => {
  const rel = getRouterParam(event, 'path') || ''
  const root = path.join(DATA_DIR, 'models')
  const file = path.resolve(root, rel)
  if (!file.startsWith(root + path.sep) || file.endsWith(path.sep)) {
    throw createError({ statusCode: 404 })
  }
  const st = await stat(file).catch(() => null)
  if (!st?.isFile()) throw createError({ statusCode: 404 })

  const MIME: Record<string, string> = {
    '.onnx': 'application/octet-stream',
    '.bin': 'application/octet-stream',
    '.data': 'application/octet-stream',
    '.wasm': 'application/wasm',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  }
  const headers = {
    'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    // Private: the route sits behind the passkey lock — shared caches must
    // not keep model weights the requester was never entitled to.
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  }

  // Single byte ranges only. The ~230 MB model crosses tunnels that drop long
  // transfers, so the browser downloads it in resumable slices.
  const range = /^bytes=(\d+)-(\d*)$/.exec(getRequestHeader(event, 'range') || '')
  if (range) {
    const start = Number(range[1])
    const end = Math.min(range[2] ? Number(range[2]) : st.size - 1, st.size - 1)
    if (start > end || start >= st.size) {
      setResponseHeader(event, 'content-range', `bytes */${st.size}`)
      throw createError({ statusCode: 416 })
    }
    // sendStream drops response headers under this h3 version, so stream via a
    // Web Response instead — the Range slices the model download depends on
    // keep working and script/wasm files get a real MIME for importScripts.
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, {
      status: 206,
      headers: { ...headers,
        'content-range': `bytes ${start}-${end}/${st.size}`,
        'content-length': String(end - start + 1),
      },
    })
  }

  // Script/wasm payloads need an honest MIME (importScripts enforces it under
  // nosniff). send(event, body) drops handler headers on this h3 build —
  // a Web Response is the only return shape whose headers survive.
  if (st.size < 64 * 1024 * 1024) {
    return new Response(await readFile(file), {
      headers: { ...headers, 'content-length': String(st.size) },
    })
  }

  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, {
    headers: { ...headers, 'content-length': String(st.size) },
  })
})
