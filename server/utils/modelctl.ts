// Agent models: the current model of a pane, from its transcript, its
// config file, its screen (Claude's header, Codex's/Devin's/omp's status
// lines), or a choice just made from the phone — whichever says something
// newer. Poll-side screen reads feed `noteScreen` (wired as coreScreen's
// `noted`); the switch records its own pick with `noteOverride`/
// `noteObservedEffort`/`noteScreenEffort` so the pill shows it before the
// transcript catches up. Everything is behind `createModelCtl(deps)`:
// injected reads, no state import — unit tests run it in plain Node.
import { hasTranscript } from '../../shared/agentKind'
import type { ModelInfo, ModelList, Pane } from '../../shared/types'
import { cleanModelName, claudeScreenEffort, claudeScreenModel, codexConfigModel, codexFooterModel, ompModelLabel, ompScreenEffort, ompScreenModel, sameModel } from './models'
import { devinStatusModel } from './devinMenu'

export interface ModelCtlDeps {
  transcript: (p: Pane) => Promise<ModelInfo | null>
  // ~/.codex/config.toml on the agent's machine; null when unreadable.
  codexConfig: (p: Pane) => Promise<string | null>
  machineKey: (p: Pane) => string
  now?: () => number
}

export function createModelCtl(deps: ModelCtlDeps) {
  const now = deps.now ?? Date.now
  // Choice made from the phone: shown right away, until the transcript
  // says something newer (Codex only writes the model on the next turn).
  const overrides = new Map<string, ModelInfo & { ms: number }>()
  const observedEfforts = new Map<string, { label: string, effort: string }>()
  // Codex / Devin: the model read from the status line.
  const footers = new Map<string, { info: ModelInfo, ms: number }>()
  // Claude: effort announced on screen (banner, /effort output), more reliable
  // than the transcript, which keeps the default effort.
  const screenEfforts = new Map<string, { effort: string, ms: number }>()
  // Claude: model from the header (or a typed /model), while there is no transcript.
  const screenModels = new Map<string, ModelInfo>()
  // omp: last screen seen (bottom), for the thinking level on its status
  // line — read next to the model's name while the transcript has none.
  const ompScreens = new Map<string, string>()
  // Last /model list read per machine + agent kind, keyed `${key}|${agent}`
  // (Claude's "Default (recommended)" fallback below, omp's name→id match).
  // v2 keyed omp's entry the other way (`omp|${key}`, v2 modelctl.ts:144);
  // v3 unifies on this order — T3a writes lists only through noteList below.
  const listCache = new Map<string, ModelList>()
  const listKey = (p: Pane, agent: string) => `${deps.machineKey(p)}|${agent}`

  async function fallbackModel(p: Pane): Promise<ModelInfo | null> {
    // Codex config on the agent's machine.
    if (p.agent === 'codex') return codexConfigModel(await deps.codexConfig(p) || '')
    // Claude without a reply yet: the default model, as the menu announces it
    // ("Default (recommended)  Sonnet 5 · …"), if it has already been read.
    const def = listCache.get(listKey(p, 'claude'))?.options[0]
    if (def && /^default\b/i.test(def.label) && def.hint) {
      const label = cleanModelName(def.hint.split('·')[0]!)
      if (label) return { id: null, label, at: null }
    }
    return null
  }

  function noteScreen(paneId: string, agent: string | null, text: string | null | undefined) {
    if (agent === 'claude') {
      const model = claudeScreenModel(text)
      if (model) screenModels.set(paneId, model)
      const effort = claudeScreenEffort(text)
      if (effort && screenEfforts.get(paneId)?.effort !== effort) screenEfforts.set(paneId, { effort, ms: now() })
      return
    }
    if (agent === 'omp') {
      if (text) ompScreens.set(paneId, text.replace(/\s+$/, '').split('\n').slice(-12).join('\n'))
      return
    }
    if (agent === 'devin') {
      // Devin's status line names the session's selected model, live —
      // including Fusion, whose transcript keeps the lead/sidekick name.
      const label = devinStatusModel(text)
      if (label) footers.set(paneId, { info: { id: null, label }, ms: now() })
      return
    }
    if (agent !== 'codex') return
    const info = codexFooterModel(text)
    if (info) footers.set(paneId, { info, ms: now() })
  }

  function forgetModel(paneId: string) {
    footers.delete(paneId)
    overrides.delete(paneId)
    observedEfforts.delete(paneId)
    screenEfforts.delete(paneId)
    screenModels.delete(paneId)
    ompScreens.delete(paneId)
  }

  async function currentModel(p: Pane): Promise<ModelInfo | null> {
    if (p.agent === 'opencode' || p.agent === 'cmd') return deps.transcript(p)
    if (!hasTranscript(p.agent)) return null
    // A failed read throws: the state keeps the model it showed (refreshModel).
    let fromFile = await deps.transcript(p)
    if (p.agent === 'devin') {
      // The status line is authoritative for the session's pick: the
      // transcript only names the model that generated the last turn (under
      // Fusion, a lead or sidekick name — never "Fusion"), so the footer wins
      // whenever seen.
      const f = footers.get(p.id)
      if (f) return { id: fromFile && sameModel(fromFile.label, f.info.label) ? fromFile.id : null, label: f.info.label, at: new Date(f.ms).toISOString() }
      const o = overrides.get(p.id)
      if (o) {
        const { ms: _ms, ...info } = o
        return fromFile && sameModel(fromFile.label, info.label) ? { ...info, id: fromFile.id } : info
      }
      return fromFile
    }
    const f = footers.get(p.id)
    if (f && (!fromFile || !sameModel(fromFile.label, f.info.label) || fromFile.effort !== f.info.effort)) {
      // The status line wins over a lagging rollout (change not yet followed by a turn).
      const fileAt = fromFile && fromFile.at ? Date.parse(fromFile.at) : 0
      if (fileAt < f.ms) fromFile = { ...f.info, id: fromFile && sameModel(fromFile.label, f.info.label) ? fromFile.id : null, at: new Date(f.ms).toISOString() }
    }
    const o = overrides.get(p.id)
    if (o) {
      const fileAt = fromFile && fromFile.at ? Date.parse(fromFile.at) : 0
      if (!fromFile || fileAt < o.ms) {
        const { ms: _ms, ...info } = o
        // Same model as the transcript: we keep its raw identifier.
        return fromFile && sameModel(fromFile.label, info.label) ? { ...info, id: fromFile.id } : info
      }
      overrides.delete(p.id)
    }
    const seen = p.agent === 'claude' ? screenEfforts.get(p.id) : null
    if (fromFile && seen) return { ...fromFile, effort: seen.effort }
    const observed = observedEfforts.get(p.id)
    if (fromFile && !fromFile.effort && observed && sameModel(fromFile.label, observed.label)) {
      return { ...fromFile, effort: observed.effort }
    }
    if (p.agent === 'omp') {
      const text = ompScreens.get(p.id)
      if (fromFile) {
        const shown = ompScreenEffort(text, fromFile.label)
        if (!fromFile.effort && shown) return { ...fromFile, effort: shown }
        // "auto" shows the glyph of the level it resolved to for this turn.
        if (fromFile.effort === 'auto') return { ...fromFile, effortResolved: shown && shown !== 'auto' && shown !== 'off' ? shown : fromFile.effortResolved ?? null }
        return fromFile
      }
      // No transcript before the first message: the status line alone, its
      // name matched to an id of the selector's list when it has been read.
      const sm = ompScreenModel(text)
      const hit = sm && listCache.get(listKey(p, 'omp'))?.options.find(o => sameModel(ompModelLabel(o.label), sm.label))
      return sm && hit ? { ...sm, id: hit.label } : sm
    }
    if (!fromFile && p.agent === 'claude') {
      // New agent: Claude Code's header already gives model and effort.
      const sm = screenModels.get(p.id)
      if (sm) return { ...sm, effort: seen ? seen.effort : sm.effort }
    }
    return fromFile || fallbackModel(p)
  }

  return {
    noteScreen,
    forgetModel,
    currentModel,
    // The switch (T3+) records what it applied.
    noteOverride: (paneId: string, info: ModelInfo) => { overrides.set(paneId, { ...info, ms: now() }) },
    noteObservedEffort: (paneId: string, label: string, effort: string) => { observedEfforts.set(paneId, { label, effort }) },
    noteScreenEffort: (paneId: string, effort: string) => { screenEfforts.set(paneId, { effort, ms: now() }) },
    // The /model lists the controller reads (T3+) — used by the fallbacks above.
    listFor: (p: Pane, agent: string) => listCache.get(listKey(p, agent)),
    noteList: (p: Pane, agent: string, list: ModelList) => { listCache.set(listKey(p, agent), list) },
  }
}

// ---------------------------------------------------------------- poll cache
// What currentModel last said per pane, refreshed when the pane has no entry,
// its status flipped, or the entry is older than staleMs. One in-flight read
// per pane; a *changed* answer asks for a re-broadcast via `changed` (a pick
// from the phone must show right away). Dead panes are pruned with forget —
// together with modelCtl().forgetModel in state.ts.
export function createModelRefresh(deps: {
  currentModel: (p: Pane) => Promise<ModelInfo | null>
  changed?: () => void
  now?: () => number
  staleMs?: number
}) {
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? 5000
  const models = new Map<string, { info: ModelInfo | null, status: string | null, at: number }>()
  const busy = new Set<string>()
  function refresh(p: Pane) {
    if (busy.has(p.id)) return
    busy.add(p.id)
    deps.currentModel(p)
      .then((info) => {
        const old = models.get(p.id)
        models.set(p.id, { info, status: p.status || null, at: now() })
        if (JSON.stringify(old && old.info) !== JSON.stringify(info)) deps.changed?.()
      })
      .catch(() => {})
      .finally(() => busy.delete(p.id))
  }
  return {
    refresh,
    forget: (id: string) => { models.delete(id) },
    ids: () => models.keys(),
    // Poll-side: kick a refresh when due, then put the last known model on the pane.
    apply(p: Pane) {
      const md = models.get(p.id)
      if (!md || md.status !== p.status || now() - md.at > staleMs) refresh(p)
      if (md && md.info) p.model = md.info
    },
  }
}
