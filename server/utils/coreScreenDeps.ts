// Wiring of coreScreen / coreChoose to the running server (state, transcripts).
import { coreCall } from './core'
import { createCoreScreens } from './coreScreen'
import { coreInputDeps } from './coreInput'
import type { CoreChooseDeps } from './coreChoose'
import { corePaint, type CoreDraftDeps } from './coreDraft'
import { coreModelCtlInstance } from './state'

let screens: ReturnType<typeof createCoreScreens> | null = null
export function coreScreens() {
  return screens ||= createCoreScreens({
    call: (method, params, timeout) => coreCall(process.env.HC_SOCKET || '', method, params, timeout),
    viewed: id => isViewed(id),
    asked: p => transcripts.pendingClaudeQuestions(p),
    colors: p => corePaint(process.env.HC_SOCKET || '', p.coreAddress || ''),
    noted: (p, text) => { modelCtl().noteScreen(p.id, p.agent, text); coreModelCtlInstance?.noteRead(p, text) },
  })
}

export function coreChooseDeps(): CoreChooseDeps {
  const s = coreScreens()
  const base = coreInputDeps()
  return { ...base, refresh: () => { for (const p of base.panes()) s.forget(p.id); base.refresh() }, read: p => s.fresh(p), asked: p => transcripts.pendingClaudeQuestions(p) }
}

export function coreDraftDeps(): CoreDraftDeps {
  return { ...coreChooseDeps(), colors: p => corePaint(process.env.HC_SOCKET || '', p.coreAddress || '') }
}
