// Where each path written in a pane's conversation was found (POST
// /api/files/resolve, server/utils/files.ts findWritten): asked once per path,
// one request (or one per WRITTEN_BATCH paths) for those a render shows that are not known yet.
// Unknown (not asked yet, or the request failed): the chip stays as it was.
import { WRITTEN_BATCH, type PathFound } from '#shared/filePaths'

const known = new Map<string, Map<string, PathFound[] | 'unknown'>>()
const inFlight = new Set<string>()

export const writtenFound = (pane: string, p: string): PathFound[] | undefined => {
  const v = known.get(pane)?.get(p)
  return Array.isArray(v) ? v : undefined
}

export async function resolveWritten(pane: string, paths: string[], ask = (body: unknown) => api<{ found?: Record<string, PathFound[]> }>('/api/files/resolve', body)) {
  const seen = known.get(pane) ?? new Map<string, PathFound[] | 'unknown'>()
  known.set(pane, seen)
  const fresh = [...new Set(paths)].filter(p => !seen.has(p) && !inFlight.has(`${pane}\n${p}`))
  if (!fresh.length) return false
  for (const p of fresh) inFlight.add(`${pane}\n${p}`)
  // At most WRITTEN_BATCH paths a request (the server answers no more).
  await Promise.all(Array.from({ length: Math.ceil(fresh.length / WRITTEN_BATCH) }, async (_, i) => {
    const part = fresh.slice(i * WRITTEN_BATCH, (i + 1) * WRITTEN_BATCH)
    try {
      const r = await ask({ pane, paths: part })
      for (const p of part) seen.set(p, r.found?.[p] ?? 'unknown')
    } catch {
      for (const p of part) seen.set(p, 'unknown')
    } finally {
      for (const p of part) inFlight.delete(`${pane}\n${p}`)
    }
  }))
  return true
}
