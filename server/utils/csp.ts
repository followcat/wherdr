import crypto from 'node:crypto'

export const CSP_BASE = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'"

// Nuxt writes an importmap and its configuration into the HTML. Their hashes
// change with the buildId; only these two exact strings are allowed.
export function cspForHtml(html: string, host: string): string {
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, content]) => content && !/type=["']application\/json["']/i.test(attrs || ''))
    .map(([, , content]) => `'sha256-${crypto.createHash('sha256').update(content!).digest('base64')}'`)
  return CSP_BASE
    .replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim())
    .replace("connect-src 'self'", `connect-src 'self' ws://${host} wss://${host}`)
}
