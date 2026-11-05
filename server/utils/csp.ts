import crypto from 'node:crypto'

export const CSP_BASE = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'"

// The on-device dictation worker's own policy (a worker follows the policy of
// its script's response, not the page's): 'wasm-unsafe-eval' lets it compile
// its WebAssembly runtime (sherpa-onnx, onnxruntime-web, served by
// /models/runtime/). It allows compiling WebAssembly, never eval() of
// JavaScript ('unsafe-eval' stays out); the page itself cannot compile any.
export const DICTATION_WORKER_PATH = '/workers/dictation-worker.js'
export const CSP_DICTATION_WORKER = CSP_BASE.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")

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
