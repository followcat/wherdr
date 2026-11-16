import crypto from 'node:crypto'

export const CSP_BASE = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'"

// The on-device dictation and read-aloud workers' own policy (a worker follows the policy of
// its script's response, not the page's): 'wasm-unsafe-eval' lets it compile
// its WebAssembly runtime (sherpa-onnx, onnxruntime-web, served by
// /models/runtime/). It allows compiling WebAssembly, never eval() of
// JavaScript ('unsafe-eval' stays out); the page itself cannot compile any.
export const DICTATION_WORKER_PATH = '/workers/dictation-worker.js'
export const CSP_DICTATION_WORKER = CSP_BASE.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")
export const WEBGPU_WORKER_PATH = '/workers/dictation-webgpu-worker.js'
export const CSP_WEBGPU_WORKER = CSP_DICTATION_WORKER
// The read-aloud worker runs the same sherpa-onnx runtime.
export const TTS_WORKER_PATH = '/workers/tts-worker.js'
export const CSP_TTS_WORKER = CSP_DICTATION_WORKER

// An agent's page (FilesView's Preview iframe, and Open in a tab): `sandbox`
// without allow-same-origin gives it an opaque origin, so it never reads
// wherdr's cookies, storage or API, even opened alone in a tab; no popups,
// forms or top navigation. Its inline scripts and styles run, and https
// scripts, styles, images and fonts (a CDN) load; it fetches nothing
// (connect-src 'none'). wherdr's own CSP would block its inline scripts in a
// srcdoc iframe (inherited), hence its own route (utils/fileDownload.ts,
// inline=1). Framed by the app only.
export const PAGE_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
// A machine of a tailnet: <machine>.<tailnet>.ts.net (MagicDNS), and nothing else.
const TAILNET_MACHINE = new RegExp(`^${LABEL}\\.(${LABEL}\\.ts\\.net)$`)

// Image sources allowed in agent replies besides wherdr itself: every machine
// and port of the tailnets wherdr is reached on, over HTTPS only. `names`:
// host names wherdr already trusts (server/utils/hosts.ts, tailnetDomainHosts);
// a name outside a tailnet adds nothing, so no public host is ever allowed.
export function tailnetImageSources(names: Iterable<string>): string[] {
  const domains = new Set<string>()
  for (const name of names) {
    const domain = TAILNET_MACHINE.exec(name.toLowerCase().replace(/\.$/, ''))?.[1]
    if (domain) domains.add(domain)
  }
  return [...domains].sort().map(domain => `https://*.${domain}:*`)
}

// Nuxt writes an importmap and its configuration into the HTML. Their hashes
// change with the buildId; only these two exact strings are allowed.
export function cspForHtml(html: string, host: string, imgSources: string[] = []): string {
  const hashes = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(([, attrs, content]) => content && !/type=["']application\/json["']/i.test(attrs || ''))
    .map(([, , content]) => `'sha256-${crypto.createHash('sha256').update(content!).digest('base64')}'`)
  return CSP_BASE
    .replace("script-src 'self'", `script-src 'self' ${hashes.join(' ')}`.trim())
    .replace("img-src 'self' data: blob:", ["img-src 'self' data: blob:", ...imgSources].join(' '))
    .replace("connect-src 'self'", `connect-src 'self' ws://${host} wss://${host}`)
}
