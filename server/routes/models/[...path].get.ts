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

  setResponseHeaders(event, {
    'content-type': file.endsWith('.onnx') ? 'application/octet-stream' : 'text/plain; charset=utf-8',
    'content-length': st.size,
    'cache-control': 'public, max-age=31536000, immutable',
  })
  return sendStream(event, createReadStream(file))
})
