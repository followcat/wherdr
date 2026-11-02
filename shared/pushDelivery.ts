// Outcome of the last Web Push delivery to one device. Only the time, a class
// and the HTTP status are kept: never the push service's response body.
export type PushDeliveryStatus = 'ok' | 'expired' | 'rejected' | 'network' | 'error'
export interface PushDelivery { at: string, status: PushDeliveryStatus, code?: number }

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE'])

// web-push throws a WebPushError (statusCode, body) for an HTTP answer, and a
// plain Node error (code: ECONNRESET…) when the push service cannot be reached.
export function classifyPushError(e: unknown): Omit<PushDelivery, 'at'> {
  const err = (e && typeof e === 'object' ? e : {}) as { statusCode?: unknown, code?: unknown }
  const code = typeof err.statusCode === 'number' && err.statusCode > 0 ? err.statusCode : 0
  if (code === 404 || code === 410) return { status: 'expired', code }
  if (code === 401 || code === 403) return { status: 'rejected', code }
  if (code) return { status: 'error', code }
  if (typeof err.code === 'string' && NETWORK_CODES.has(err.code)) return { status: 'network' }
  return { status: 'error' }
}

// An expired subscription stays listed so the user sees which device stopped,
// then goes away on its own after this delay if nobody removes it.
export const EXPIRED_KEEP_MS = 30 * 24 * 3600 * 1000
export function expiredLongAgo(last: PushDelivery | undefined, now = Date.now()): boolean {
  return last?.status === 'expired' && now - Date.parse(last.at) > EXPIRED_KEEP_MS
}

// Push service of a subscription, as a short name: its endpoint stays on the server.
export function pushProvider(endpoint: string): string {
  let host = ''
  try { host = new URL(endpoint).hostname } catch { return 'unknown' }
  if (host.endsWith('push.apple.com')) return 'apple'
  if (host.endsWith('googleapis.com')) return 'google'
  if (host.endsWith('mozilla.com')) return 'mozilla'
  if (host.endsWith('windows.com')) return 'microsoft'
  return 'other'
}

// What the settings list gets for one device: an opaque id, no endpoint or key.
export interface PushDeviceView { id: string, provider: string, lang: 'en' | 'fr', addedAt: string, last: PushDelivery | null, current: boolean }
