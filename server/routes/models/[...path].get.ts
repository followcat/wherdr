// On-device ASR model weights (DATA_DIR/models/**) — large blobs fetched by the
// browser once, then held in Cache Storage. Kept out of the app bundle so the
// ~200 MB survives redeploys and never lands in the npm tarball.
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
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

  const headers = {
    'content-type': file.endsWith('.onnx') ? 'application/octet-stream' : 'text/plain; charset=utf-8',
    'cache-control': 'public, max-age=31536000, immutable',
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
    setResponseStatus(event, 206)
    setResponseHeaders(event, { ...headers,
      'content-range': `bytes ${start}-${end}/${st.size}`,
      'content-length': end - start + 1,
    })
    return sendStream(event, createReadStream(file, { start, end }))
  }

  setResponseHeaders(event, { ...headers, 'content-length': st.size })
  return sendStream(event, createReadStream(file))
})
