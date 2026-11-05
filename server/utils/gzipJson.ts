// Large JSON answers (a page of a conversation, the Board, the state) gzipped
// when the browser takes it: several times smaller over a slow network. Only
// plain objects and arrays, as H3 would send them; small ones as they are.
import { gzipSync } from 'node:zlib'

export const GZIP_MIN = 8 * 1024
// The JSON is built once: a small answer is sent as that text (H3 would
// build it again). null: not plain JSON, or no gzip, left to H3.
export function jsonBody(acceptEncoding: string | undefined, out: unknown): { gzip: boolean, body: Buffer | string } | null {
  const plain = Array.isArray(out) || (out !== null && typeof out === 'object' && Object.getPrototypeOf(out) === Object.prototype)
  if (!plain || !/\bgzip\b/.test(acceptEncoding || '')) return null
  const json = JSON.stringify(out)
  return json.length < GZIP_MIN ? { gzip: false, body: json } : { gzip: true, body: gzipSync(json, { level: 5 }) }
}
