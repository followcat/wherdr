// Wiring of coreScreen / coreChoose to the running server (state, transcripts).
import { CoreError } from './core'
import type { Pane } from '../../shared/types'
import { createCoreScreens } from './coreScreen'
import { getPoolRuntime, type CoreEntry } from './corePool'
import { coreInputDeps } from './coreInput'
import type { CoreChooseDeps } from './coreChoose'
import { corePaint, type CoreDraftDeps } from './coreDraft'

const screens = new Map<string, ReturnType<typeof createCoreScreens>>()
// One pending wake at a time: every unconfirmed screen is read by that poll.
let wakeTimer: ReturnType<typeof setTimeout> | null = null

function resolveEntry(target?: CoreEntry | Pane | string): CoreEntry | undefined {
  if (target && typeof target === 'object' && 'endpoint' in target) return target
  const rt = getPoolRuntime()
  if (!rt) return undefined
  if (typeof target === 'string') return rt.forPane(target)
  if (target) return rt.forPane(target.id)
  return rt.primary()
}

export function coreScreens(target?: CoreEntry | Pane | string) {
  const entry = resolveEntry(target)
  const key = entry?.endpoint || ''
  let reader = screens.get(key)
  if (!reader) {
    reader = createCoreScreens({
      call: (method, params, timeout) => entry
        ? entry.call(method, params, timeout)
        : Promise.reject(new CoreError('unavailable', 'Missing core endpoint')),
      viewed: id => getPoolRuntime()?.isViewed(id) ?? false,
      asked: p => getPoolRuntime()?.pendingClaudeQuestions(p) ?? Promise.resolve([]),
      colors: p => corePaint((p.id ? getPoolRuntime()?.forPane(p.id)?.endpoint : undefined) || entry?.endpoint || '', p.coreAddress || ''),
      noted: (p, text) => getPoolRuntime()?.noteModelScreen(p, text),
      wake: (ms) => { wakeTimer ??= setTimeout(() => { wakeTimer = null; getPoolRuntime()?.wakeCorePoll(entry?.localKey || undefined) }, ms) },
    })
    screens.set(key, reader)
  }
  return reader
}

export function coreChooseDeps(paneId?: unknown): CoreChooseDeps {
  const id = typeof paneId === 'string' && paneId ? paneId : undefined
  const s = coreScreens(id)
  const base = coreInputDeps(id)
  return { ...base, refresh: () => { for (const p of base.panes()) s.forget(p.id); base.refresh() }, read: p => s.fresh(p), asked: p => getPoolRuntime()?.pendingClaudeQuestions(p) ?? Promise.resolve([]) }
}

export function coreDraftDeps(paneId?: unknown): CoreDraftDeps {
  const id = typeof paneId === 'string' && paneId ? paneId : undefined
  const entry = resolveEntry(id)
  return { ...coreChooseDeps(id), colors: p => corePaint((p.id ? getPoolRuntime()?.forPane(p.id)?.endpoint : undefined) || entry?.endpoint || '', p.coreAddress || '') }
}
