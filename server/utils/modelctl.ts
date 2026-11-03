// Agent models, control side: current model (transcript, choice made
// from the phone, default), list of models read from the /model menu, and
// model change by driving that menu.
//
// ⚠ We always confirm with "s" (this session only), never with
// Enter nor `/model <name>`: those save the model as the user's global
// default (~/.claude/settings.json, ~/.codex/config.toml).
// In Codex, Enter on the first menu only moves on to the effort
// choice ("enter select"), which we then confirm with "s".
import path from 'node:path'
import type { EffortList, ModelInfo, ModelList, ModelOption, ModelPart, Pane } from '../../shared/types'
import { log } from './env'
import { HerdrError, agentPrompt, herdr, sleep } from './herdr'
import { closePanel } from './actions'
import { READY, findPane, poll, transcripts } from './state'
import { machineOfPane } from './machines'
import { resizePane } from './terminal'
import { type ClaudeEffortSlider, type ModelMenu, type OmpCycleKnowledge, type OmpSelector, OMP_EFFORT_ORDER, claudeEffortCommand, claudeEffortLevels, cleanModelName, codexCachedEfforts, codexConfigModel, claudeScreenEffort, claudeScreenModel, codexFooterModel, effortMatches, effortValue, learnOmpCycle, ompEffortLevels, ompModelLabel, ompScreenEffort, ompScreenModel, ompSelectorCaption, parseClaudeEffortScreen, parseModelMenu, parseOmpSelector, sameModel, switchConfirmKeys } from './models'
import { fmt } from '../../shared/message'
import { hasTranscript } from '../../shared/agentKind'
import { type DevinModelMenu, type DevinFusionState, devinMenuOpen, devinModelSetEcho, devinStatusModel, devinStatusPair, parseDevinFusion, parseDevinModelMenu } from './devinMenu'

// ---------------------------------------------------------------- current model
// Choice made from the phone: shown right away, until the
// transcript says something newer (Codex only writes the model on the next turn).
const overrides = new Map<string, ModelInfo & { ms: number }>()
const observedEfforts = new Map<string, { label: string, effort: string }>()

async function fallbackModel(p: Pane): Promise<ModelInfo | null> {
  const m = machineOfPane(p.id)
  if (p.agent === 'codex') {
    // Codex config on the agent's machine.
    if (!m || !m.home) return null
    try { return codexConfigModel(await m.fs.readFile(path.posix.join(m.home, '.codex/config.toml'))) }
    catch { return null }
  }
  // Claude without a reply yet: the default model, as the menu announces it
  // ("Default (recommended)  Sonnet 5 · …"), if it has already been read.
  const def = listCache.get(listKey(p.id, 'claude'))?.options[0]
  if (def && /^default\b/i.test(def.label) && def.hint) {
    const label = cleanModelName(def.hint.split('·')[0]!)
    if (label) return { id: null, label, at: null }
  }
  return null
}

// Codex: model read from its status line (screen re-read by state.ts when not working).
const footers = new Map<string, { info: ModelInfo, ms: number }>()
// Claude: effort announced on screen (banner, /effort output), more reliable
// than the transcript, which keeps the default effort.
const screenEfforts = new Map<string, { effort: string, ms: number }>()
// Claude: model from the header (or from a typed /model), fallback while there is no transcript.
const screenModels = new Map<string, ModelInfo>()
// omp: last screen seen (bottom), for the thinking level on its status line —
// fallback while the transcript has none, read next to the model's name.
const ompScreens = new Map<string, string>()
export function noteScreen(paneId: string, agent: string | null, text: string | null | undefined) {
  if (agent === 'claude') {
    const model = claudeScreenModel(text)
    if (model) screenModels.set(paneId, model)
    const effort = claudeScreenEffort(text)
    if (effort && screenEfforts.get(paneId)?.effort !== effort) screenEfforts.set(paneId, { effort, ms: Date.now() })
    return
  }
  if (agent === 'omp') {
    if (text) ompScreens.set(paneId, text.replace(/\s+$/, '').split('\n').slice(-12).join('\n'))
    return
  }
  if (agent === 'devin') {
    // Devin's status line names the session's selected model, live — including
    // Fusion, whose transcript keeps the lead/sidekick name forever.
    const label = devinStatusModel(text)
    if (label) footers.set(paneId, { info: { id: null, label }, ms: Date.now() })
    return
  }
  if (agent !== 'codex') return
  const info = codexFooterModel(text)
  if (info) footers.set(paneId, { info, ms: Date.now() })
}

export function forgetModel(paneId: string) {
  footers.delete(paneId)
  overrides.delete(paneId)
  observedEfforts.delete(paneId)
  screenEfforts.delete(paneId)
  screenModels.delete(paneId)
  ompScreens.delete(paneId)
}

export async function currentModel(p: Pane): Promise<ModelInfo | null> {
  if (!hasTranscript(p.agent)) return null
  // A failed read throws: the state keeps the model it showed (refreshModel).
  let fromFile = await transcripts.model(p)
  if (p.agent === 'devin') {
    // The status line is authoritative for the session's pick: the transcript
    // only names the model that generated the last turn (under Fusion, a lead
    // or sidekick name — never "Fusion"), so the footer wins whenever seen.
    const f = footers.get(p.id)
    if (f) return { id: fromFile && sameModel(fromFile.label, f.info.label) ? fromFile.id : null, label: f.info.label, at: new Date(f.ms).toISOString() }
    const o = overrides.get(p.id)
    if (o) {
      const { ms: _ms, ...info } = o
      return info
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
    const hit = sm && listCache.get(`omp|${machineOfPane(p.id)?.key || ''}`)?.options.find(o => sameModel(ompModelLabel(o.label), sm.label))
    return sm && hit ? { ...sm, id: hit.label } : sm
  }
  if (!fromFile && p.agent === 'claude') {
    // New agent: Claude Code's header already gives model and effort.
    const sm = screenModels.get(p.id)
    if (sm) return { ...sm, effort: seen ? seen.effort : sm.effort }
  }
  return fromFile || fallbackModel(p)
}

// ---------------------------------------------------------------- menu /model
const LIST_TTL_MS = 12 * 3600 * 1000
// Per machine and agent kind (Claude / Codex versions may differ).
const listCache = new Map<string, ModelList>()
const listKey = (paneId: string, agent: string) => `${machineOfPane(paneId)?.key || ''}|${agent}`
const busy = new Set<string>()
export const modelControlBusy = (paneId: string) => busy.has(paneId)

const SWITCH_AGENTS = new Set(['claude', 'codex', 'omp', 'devin'])
async function withPane<T>(paneId: string, fn: (p: Pane) => Promise<T>): Promise<T> {
  const p = findPane(paneId)
  if (!p) throw new HerdrError('bad_pane', 'Pane not found')
  if (!p.agent || !SWITCH_AGENTS.has(p.agent)) throw new HerdrError('unsupported', 'This agent’s model cannot be changed from wherdr')
  // A dialog or menu owns the terminal even when the status stays "done" —
  // typing /model would answer it (Devin's permission prompt, /resume…).
  if (!READY.has(p.status || '') || p.prompt || p.menu || p.screen || p.interaction === 'terminal') {
    throw new HerdrError('busy', p.status === 'blocked' || p.prompt || p.menu || p.screen || p.interaction === 'terminal' ? 'The agent is waiting for an answer — reply first.' : 'The agent is working — change the model once it’s done.')
  }
  if (busy.has(paneId)) throw new HerdrError('busy', 'Model change already in progress')
  busy.add(paneId)
  try { return await fn(p) }
  finally { busy.delete(paneId) }
}

const screen = async (paneId: string) => {
  const r = await herdr('pane.read', { pane_id: paneId, source: 'detection' }, 4000)
  return String((r.read && r.read.text) || '')
}

async function waitMenu(paneId: string, ok: (m: ModelMenu) => boolean, timeoutMs = 6000): Promise<ModelMenu | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const m = parseModelMenu(await screen(paneId))
    if (m && ok(m)) return m
    if (Date.now() > until) return null
    await sleep(250)
  }
}

// Closes the menu (Escape) while it is on screen. Never Escape without a menu:
// in Codex, Escape Escape when idle opens editing of the previous message.
async function closeMenu(paneId: string) {
  for (let i = 0; i < 3; i++) {
    if (!parseModelMenu(await screen(paneId))) return
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] })
    await sleep(400)
  }
}

async function openMenu(p: Pane): Promise<ModelMenu> {
  await closeMenu(p.id)
  await closePanel(p.id).catch(() => false)
  await agentPrompt(p.id, '/model')
  const m = await waitMenu(p.id, x => x.kind === 'model')
  if (!m) {
    await closeMenu(p.id)
    throw new HerdrError('no_menu', 'The /model menu did not show up')
  }
  return m
}

const moveKeys = (from: number, to: number) => Array.from({ length: Math.abs(to - from) }, () => (to > from ? 'down' : 'up'))

// All options: Claude only shows 10 (↑/↓ before the number), we
// go back to the top then down page by page (the list wraps to the top
// after the last one).
async function readAllOptions(paneId: string, first: ModelMenu) {
  const all = new Map(first.options.map(o => [o.n, o]))
  let m = first
  // Page opened further down (current model at the end of the list): go back up to no. 1 first.
  if (m.options[0]!.n > 1) {
    await herdr('pane.send_input', { pane_id: paneId, keys: moveKeys(m.cursor, 1) })
    const top = await waitMenu(paneId, x => x.kind === 'model' && x.cursor === 1, 3000)
    if (!top) throw new HerdrError('stale', 'The /model menu changed — try again.')
    for (const o of top.options) if (!all.has(o.n)) all.set(o.n, o)
    m = top
  }
  for (let i = 0; i < 8 && m.scrollDown; i++) {
    const last = m.options[m.options.length - 1]!.n
    await herdr('pane.send_input', { pane_id: paneId, keys: moveKeys(m.cursor, last + 1) })
    await sleep(350)
    const next = await waitMenu(paneId, x => x.kind === 'model', 2000)
    if (!next || next.cursor <= last) break // wrapped: end of list
    const before = all.size
    for (const o of next.options) if (!all.has(o.n)) all.set(o.n, o)
    if (all.size === before) break
    m = next
  }
  return [...all.values()].sort((a, b) => a.n - b.n)
}

// "current" is not kept: the list is shared by all agents of the same kind.
const toOption = ({ label, hint, isDefault }: ModelOption): ModelOption => ({ label, hint, isDefault: Boolean(isDefault) })

export async function listModels(paneId: string, refresh = false): Promise<ModelList> {
  const p0 = findPane(paneId)
  if (!p0 || !p0.agent) throw new HerdrError('bad_pane', 'Pane not found')
  if (p0.agent === 'omp') return ompListModels(p0, refresh)
  if (p0.agent === 'devin') return devinListModels(p0, refresh)
  const hit = listCache.get(listKey(p0.id, p0.agent))
  if (hit && !refresh && Date.now() - hit.at < LIST_TTL_MS) return hit
  return withPane(paneId, async (p) => {
    const m = await openMenu(p)
    let options: ModelOption[]
    try { options = (await readAllOptions(p.id, m)).map(toOption) }
    finally { await closeMenu(p.id) }
    const list: ModelList = { agent: p.agent!, options, at: Date.now() }
    listCache.set(listKey(p.id, p.agent!), list)
    log(`models ${p.agent}: ${options.map(o => o.label).join(', ')}`)
    return list
  })
}

// Moves the cursor to option `n` and checks that it is really there.
async function pick(paneId: string, m: ModelMenu, n: number, label: string, kind: ModelMenu['kind']) {
  const keys = moveKeys(m.cursor, n)
  if (keys.length) await herdr('pane.send_input', { pane_id: paneId, keys })
  const at = await waitMenu(paneId, x => x.kind === kind && x.cursor === n, 3000)
  const o = at && at.options.find(x => x.n === n)
  if (!at || !o || o.label !== label) throw new HerdrError('stale', 'The /model menu changed — try again.')
  return at
}

export async function setModel(paneId: string, wanted: string, parts?: Record<string, string>): Promise<ModelInfo> {
  const p0 = findPane(paneId)
  if (p0?.agent === 'omp') return ompSetModel(paneId, String(wanted || '').trim())
  if (p0?.agent === 'devin') return devinSetModel(p0.id, String(wanted || '').trim(), parts)
  if (parts && Object.keys(parts).length) throw new HerdrError('unsupported', 'This model has no selectable parts')
  const label = cleanModelName(wanted)
  if (!label) throw new HerdrError('bad_model', 'Missing model')
  return withPane(paneId, async (p) => {
    const before = await currentModel(p)
    const started = Date.now()
    let m = await openMenu(p)
    try {
      // Option number: in the list read (the menu only shows one page).
      let n = m.options.find(o => o.label === label)?.n
      if (!n) {
        n = (await readAllOptions(p.id, m)).find(o => o.label === label)?.n
        m = (await waitMenu(p.id, x => x.kind === 'model', 2000)) || m // cursor moved
      }
      if (!n) throw new HerdrError('bad_model', fmt('Model not found in /model: {model}', { model: label }))
      m = await pick(p.id, m, n, label, 'model')
      // "Default (recommended)": Claude will confirm with the default model's name.
      const picked = m.options.find(o => o.n === n)
      const confirmAs = /^default\b/i.test(label) && picked && picked.hint ? cleanModelName(picked.hint.split('·')[0]!) : label

      let effort: string | null = null
      if (p.agent === 'claude') {
        if (!m.sessionKey) throw new HerdrError('unsafe', '“This session only” option not found — nothing was changed.')
        effort = m.effort
        await herdr('pane.send_input', { pane_id: p.id, keys: ['s'] })
      } else {
        // Codex: Enter only moves on to the effort choice ("enter select").
        if (!m.enterSelects) throw new HerdrError('unsafe', 'Unexpected /model menu — nothing was changed.')
        await herdr('pane.send_input', { pane_id: p.id, keys: ['enter'] })
        const e = await waitMenu(p.id, x => x.kind === 'effort', 4000)
        if (!e || !e.sessionKey) throw new HerdrError('unsafe', 'Unexpected effort menu — nothing was changed.')
        // Keep the current effort if it exists for this model, otherwise the one offered.
        const keep = e.options.find(o => effortMatches(o.label, before && before.effort))
        const at = keep && keep.n !== e.cursor ? await pick(p.id, e, keep.n, keep.label, 'effort') : e
        effort = (at.options.find(o => o.n === at.cursor)?.label || '').toLowerCase().replace(/\s+/g, '') || null
        if (effort === 'extrahigh') effort = 'xhigh'
        await herdr('pane.send_input', { pane_id: p.id, keys: ['s'] })
      }
      // Menu closed = choice taken. Claude may first ask for confirmation
      // (conversation cached for the old model): we confirm this model.
      // Done when neither menu nor confirmation is seen twice in a row.
      const until = Date.now() + 5000
      let clear = 0
      while (clear < 2 && Date.now() < until) {
        const text = await screen(p.id)
        const confirm = p.agent === 'claude' ? switchConfirmKeys(text, confirmAs) : null
        if (confirm) await herdr('pane.send_input', { pane_id: p.id, keys: confirm })
        clear = confirm || parseModelMenu(text) ? 0 : clear + 1
        await sleep(confirm ? 400 : 250)
      }
      if (clear < 2) throw new HerdrError('stale', 'The /model menu changed — try again.')
      const info: ModelInfo = { id: null, label: confirmAs, effort, at: new Date(started).toISOString() }
      overrides.set(p.id, { ...info, ms: started })
      if (effort) observedEfforts.set(p.id, { label: confirmAs, effort })
      log(`model ${p.id} (${p.agent}) -> ${confirmAs}${effort ? ' ' + effort : ''} (this session)`)
      setTimeout(poll, 100)
      return (await currentModel(p)) || info
    } catch (e) {
      await closeMenu(p.id).catch(() => {})
      throw e
    }
  })
}

// ---------------------------------------------------------------- omp (alt+p selector)
// omp's "Switch Model" selector opens on alt+p (or /switch, /model in the
// input): a boxed list where Enter applies for this session only ("use for
// this session") — never a global default. Rows have no numbers: the cursor
// moves one "down"/"up" per model, re-reading the screen between steps.
const ompSelector = async (paneId: string) => parseOmpSelector(await screen(paneId))

async function waitOmpSelector(paneId: string, ok: (s: OmpSelector) => boolean, timeoutMs = 6000): Promise<OmpSelector | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = await ompSelector(paneId).catch(() => null)
    if (s && ok(s)) return s
    if (Date.now() > until) return null
    await sleep(250)
  }
}

// Escape while the selector is on screen: it must never stay open.
async function closeOmpSelector(paneId: string) {
  for (let i = 0; i < 3; i++) {
    if (!(await ompSelector(paneId).catch(() => null))) return
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] })
    await sleep(400)
  }
}

// Columns given to a narrow pane while the selector is read and driven.
const OMP_SELECTOR_COLS = 160

// A selector that is open and readable, with `restore` to call once it is
// closed (gives a widened pane its width back; no-op otherwise).
interface OpenOmpSelector { s: OmpSelector, restore: () => Promise<void> }

async function openOmpSelector(p: Pane): Promise<OpenOmpSelector> {
  await closeOmpSelector(p.id)
  await closePanel(p.id).catch(() => false)
  await herdr('pane.send_input', { pane_id: p.id, keys: ['alt+p'] })
  let s = await waitOmpSelector(p.id, () => true)
  // omp 18.6: alt+p toggles between the session and the Task subagent
  // selectors; only the session one may be driven.
  if (s && s.task) {
    await herdr('pane.send_input', { pane_id: p.id, keys: ['alt+p'] })
    s = await waitOmpSelector(p.id, x => !x.task)
  }
  if (!s) {
    await closeOmpSelector(p.id)
    throw new HerdrError('no_menu', 'omp’s model selector did not show up')
  }
  if (!s.truncated) return { s, restore: async () => {} }
  // Narrow pane (left at a phone's width by a terminal whose size could not
  // be given back, see paneSizes.ts, or simply a small split). omp then
  // cuts the ids ("anthropic/cla…"): widen the pane for the time of the
  // choice, then give it its width back.
  const cols = s.width
  const rows = Number((await herdr('pane.get', { pane_id: p.id }).catch(() => null))?.pane?.scroll?.viewport_rows) || 40
  const restore = async () => { await resizePane(p.id, cols, rows) }
  const wide = (await resizePane(p.id, OMP_SELECTOR_COLS, rows))
    ? await waitOmpSelector(p.id, x => !x.truncated && !x.task, 4000)
    : null
  if (!wide) {
    await closeOmpSelector(p.id)
    await restore()
    throw new HerdrError('narrow', 'The terminal is too narrow for omp’s model selector — close wherdr’s terminal or widen the pane, then try again.')
  }
  log(`omp selector ${p.id}: pane widened from ${cols} columns`)
  return { s: wide, restore }
}

// omp's own transcript writes the change ("model_change" …, "role":
// "temporary"); wait for it so currentModel() is right away.
async function waitOmpModel(p: Pane, id: string, since: number): Promise<boolean> {
  const until = Date.now() + 4000
  for (;;) {
    const info = await transcripts.model(p).catch(() => null)
    if (info && info.id === id && info.at && Date.parse(info.at) >= since - 1500) return true
    if (Date.now() > until) return false
    await sleep(300)
  }
}

async function ompSetModel(paneId: string, wanted: string): Promise<ModelInfo> {
  const id = String(wanted || '').trim()
  if (!id) throw new HerdrError('bad_model', 'Missing model')
  return withPane(paneId, async (p) => {
    const started = Date.now()
    const open = await openOmpSelector(p)
    let s = open.s
    try {
      const rank = (sel: OmpSelector) => sel.options.findIndex(o => o.label === id)
      let at = rank(s)
      // Search narrows the list ("glm" → …): type enough of the id's last
      // segment to make it visible, one key at a time (the field takes them).
      if (at < 0) {
        const tail = id.split('/').pop()!.toLowerCase()
        const heads = s.options.map(o => o.label.split('/').pop()!.toLowerCase())
        let typed = ''
        for (const ch of tail) {
          typed += ch
          if (heads.some(h => h === typed)) break
        }
        for (const ch of typed) {
          await herdr('pane.send_input', { pane_id: p.id, keys: [ch === ' ' ? 'space' : ch] })
          await sleep(80)
        }
        s = (await waitOmpSelector(p.id, x => x.search.length > 0, 3000)) || s
        at = rank(s)
      }
      if (at < 0) throw new HerdrError('bad_model', fmt('Model not found in omp’s selector: {model}', { model: id }))
      // One "down"/"up" per row; the list can change under the cursor
      // (search, scrollbar), so each step re-reads and recomputes.
      for (let n = 0; n < 80; n++) {
        s = (await ompSelector(p.id)) || s
        const delta = at - s.cursor
        if (delta === 0) break
        await herdr('pane.send_input', { pane_id: p.id, keys: [delta > 0 ? 'down' : 'up'] })
        await sleep(120)
        if (n === 79) throw new HerdrError('stale', 'The model selector did not follow — nothing was changed.')
      }
      s = (await waitOmpSelector(p.id, x => x.cursor === at && x.options[at]!.label === id, 3000))
        ?? (await ompSelector(p.id)) ?? s
      if (s.cursor !== at || s.options[at]!.label !== id) throw new HerdrError('stale', 'The model selector changed — try again.')
      await herdr('pane.send_input', { pane_id: p.id, keys: ['enter'] })
      await waitOmpModel(p, id, started)
    } catch (e) {
      await closeOmpSelector(p.id).catch(() => {})
      throw e
    } finally {
      await open.restore()
    }
    const text = await screen(p.id).catch(() => '')
    const caption = ompSelectorCaption(text, id)
    // The level stays on the status line (no transcript before the first message).
    const effort = ompScreenEffort(text, ompModelLabel(id))
    const info: ModelInfo = { id, label: caption?.name || ompModelLabel(id), effort, at: new Date(started).toISOString() }
    overrides.set(p.id, { ...info, ms: started })
    log(`model ${p.id} (omp) -> ${id} (this session)`)
    setTimeout(poll, 100)
    return (await currentModel(p)) || info
  })
}

// omp models offered by the selector, read live ("Search…" empty). The list
// depends on the machine's providers (~/.omp config), not on the agent kind:
// cached per machine, and re-read on demand (refresh).
async function ompListModels(p: Pane, refresh: boolean): Promise<ModelList> {
  const key = `omp|${machineOfPane(p.id)?.key || ''}`
  const hit = listCache.get(key)
  if (hit && !refresh && Date.now() - hit.at < LIST_TTL_MS) return hit
  const { s, restore } = await openOmpSelector(p)
  try {
    const options = s.options.map(o => ({ label: o.label, hint: o.hint, current: o.current, isDefault: false }))
    const list: ModelList = { agent: 'omp', options, at: Date.now() }
    listCache.set(key, list)
    log(`models omp: ${options.map(o => o.label).join(', ')}`)
    return list
  } finally {
    await closeOmpSelector(p.id).catch(() => {})
    await restore()
  }
}

async function codexEffortMenu(p: Pane, model: ModelInfo): Promise<ModelMenu> {
  const m = await openMenu(p)
  if (!m.enterSelects) throw new HerdrError('unsafe', 'Unexpected /model menu — nothing was changed.')
  const current = m.options.find(o => o.current || sameModel(o.label, model.label))
  if (!current) throw new HerdrError('stale', 'The /model menu changed — try again.')
  await pick(p.id, m, current.n, current.label, 'model')
  await herdr('pane.send_input', { pane_id: p.id, keys: ['enter'] })
  const e = await waitMenu(p.id, x => x.kind === 'effort', 4000)
  if (!e || !e.sessionKey) throw new HerdrError('unsafe', 'Unexpected effort menu — nothing was changed.')
  return e
}

// ---------------------------------------------------------------- curseur /effort (Claude)
async function waitSlider(paneId: string, ok: (s: ClaudeEffortSlider) => boolean, timeoutMs: number): Promise<ClaudeEffortSlider | null> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const s = parseClaudeEffortScreen(await screen(paneId).catch(() => ''))
    if (s && ok(s)) return s
    if (Date.now() > until) return null
    await sleep(250)
  }
}

async function sliderGone(paneId: string, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs
  let clear = 0
  while (clear < 2 && Date.now() < until) {
    clear = parseClaudeEffortScreen(await screen(paneId).catch(() => '')) ? 0 : clear + 1
    if (clear < 2) await sleep(250)
  }
  return clear >= 2
}

// Escape while the slider is on screen: it must never stay open.
async function closeEffortSlider(paneId: string) {
  for (let i = 0; i < 3; i++) {
    if (!parseClaudeEffortScreen(await screen(paneId).catch(() => ''))) return
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] }).catch(() => {})
    await sleep(400)
  }
}

async function openEffortSlider(p: Pane): Promise<ClaudeEffortSlider> {
  await closeEffortSlider(p.id)
  await closePanel(p.id).catch(() => false)
  await agentPrompt(p.id, '/effort')
  const s = await waitSlider(p.id, () => true, 4000)
  if (!s) {
    // Unknown screen: close anyway (single Escape, the slider may no longer be readable).
    await herdr('pane.send_input', { pane_id: p.id, keys: ['esc'] }).catch(() => {})
    throw new HerdrError('no_menu', 'Claude’s effort slider could not be read — closed, nothing was changed.')
  }
  return s
}

// ---------------------------------------------------------------- omp thinking level (⇧⇥)
// Per machine and model: what the ⇧⇥ presses showed of its cycle.
const ompCycles = new Map<string, OmpCycleKnowledge>()
const ompCycleKey = (paneId: string, model: ModelInfo) => `${machineOfPane(paneId)?.key || ''}|${cleanModelName(model.label).toLowerCase()}`

// Level after one ⇧⇥ press from `prev`. With a transcript, its new
// "thinking_level_change" entry (newer than `sinceAt`) gives the configured
// level. Without one (no message yet, session file not found), only the
// status line — and after a turn "auto" shows the glyph of the level it
// resolved to, so the glyph alone cannot tell "auto" from that level. The
// cycle can: a press from "off" always lands on "auto", and a press from a
// resolved "auto" may keep the glyph (it lands on the level auto had picked),
// taken once the status line has had time to redraw.
const OMP_REDRAW_MS = 1000
async function waitOmpEffort(p: Pane, model: string, prev: string, shown: string, sinceAt: string | null, hasTranscript: boolean) {
  const pressed = Date.now()
  for (;;) {
    const tr = await transcripts.model(p).catch(() => null)
    if (tr && tr.effort && tr.at && (!sinceAt || tr.at > sinceAt)) {
      return { level: tr.effort, at: tr.at, shown: ompScreenEffort(await screen(p.id).catch(() => ''), model) || shown }
    }
    if (!hasTranscript) {
      const now = ompScreenEffort(await screen(p.id).catch(() => ''), model)
      if (now && now !== shown) return { level: prev === 'off' ? 'auto' : now, at: sinceAt, shown: now }
      if (now && prev === 'auto' && shown !== 'auto' && Date.now() - pressed > OMP_REDRAW_MS) return { level: now, at: sinceAt, shown: now }
    }
    if (Date.now() - pressed > 3000) return null
    await sleep(200)
  }
}

// Presses ⇧⇥ until omp is on `level`, re-reading after each press. A full
// turn back to the starting level means the model does not offer it.
async function ompCycleTo(p: Pane, before: ModelInfo, level: string) {
  if (!OMP_EFFORT_ORDER.includes(level)) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
  await closePanel(p.id).catch(() => false)
  let shown = ompScreenEffort(await screen(p.id), before.label)
  const tr = await transcripts.model(p).catch(() => null)
  // The transcript's level, else the status line: wherdr's own record
  // (`before`, possibly older than a change made in the terminal) only for
  // "auto", which the glyph no longer shows after a turn.
  const start = tr && tr.effort ? tr.effort
    : shown && before.effort === 'auto' && shown !== 'off' ? 'auto' : shown
  if (!shown || !start) throw new HerdrError('unsafe', 'omp’s thinking level is not on screen — nothing was changed.')
  if (start === level) return
  const key = ompCycleKey(p.id, before)
  const presses = [start]
  let at = tr ? tr.at || null : null
  try {
    for (let n = 0; n < OMP_EFFORT_ORDER.length; n++) {
      await herdr('pane.send_input', { pane_id: p.id, keys: ['shift+tab'] })
      const next = await waitOmpEffort(p, before.label, presses[presses.length - 1]!, shown, at, Boolean(tr))
      if (!next) {
        throw new HerdrError('stale', presses.length === 1
          ? 'omp did not change its thinking level — nothing was changed.'
          : 'omp’s thinking level stopped following — check it in the terminal.')
      }
      presses.push(next.level)
      shown = next.shown
      at = next.at
      if (next.level === level) return
      if (next.level === start) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
    }
    throw new HerdrError('stale', 'omp’s thinking level stopped following — check it in the terminal.')
  } finally {
    ompCycles.set(key, learnOmpCycle(ompCycles.get(key) || null, presses))
    // Stopped on the way: the field shows where omp really is.
    const reached = presses[presses.length - 1]!
    if (presses.length > 1 && reached !== level) {
      overrides.set(p.id, { ...before, effort: reached, at: new Date().toISOString(), ms: Date.now() })
      observedEfforts.set(p.id, { label: before.label, effort: reached })
    }
  }
}

export async function listEfforts(paneId: string): Promise<EffortList> {
  return withPane(paneId, async p => {
    if (!EFFORT_AGENTS.has(p.agent!)) return { levels: [], current: null }
    const model = await currentModel(p)
    if (!model) return { levels: [], current: null }
    // omp: levels of its ⇧⇥ cycle, as far as the presses have shown them.
    if (p.agent === 'omp') {
      const levels = model.effort ? ompEffortLevels(learnOmpCycle(ompCycles.get(ompCycleKey(p.id, model)) || null, [model.effort])) : []
      return { levels, current: model.effort || null }
    }
    if (p.agent === 'claude') {
      const fallback = claudeEffortLevels(model.label)
      // Reading the list must not send /effort: Claude records even a
      // cancelled opening in the transcript. The choice checks the levels
      // actually offered by the slider before changing anything.
      return { levels: fallback, current: model.effort || null }
    }
    const machine = machineOfPane(p.id)
    if (machine?.home) {
      try {
        const levels = codexCachedEfforts(await machine.fs.readFile(path.posix.join(machine.home, '.codex/models_cache.json')), model.id || model.label)
        if (levels.length) return { levels, current: model.effort || null }
      } catch { /* menu live en repli */ }
    }
    try {
      const menu = await codexEffortMenu(p, model)
      const levels = menu.options.map(o => effortValue(o.label)).filter((e): e is string => Boolean(e))
      return { levels, current: model.effort || null }
    } finally { await closeMenu(p.id).catch(() => {}) }
  })
}

export async function setEffort(paneId: string, level: string): Promise<ModelInfo> {
  return withPane(paneId, async p => {
    if (!EFFORT_AGENTS.has(p.agent!)) throw new HerdrError('unsupported', 'This agent’s effort cannot be changed from wherdr')
    const before = await currentModel(p)
    if (!before) throw new HerdrError('bad_model', 'Unknown model')
    const started = Date.now()
    if (p.agent === 'omp') {
      await ompCycleTo(p, before, level)
    } else if (p.agent === 'claude') {
      if (!claudeEffortCommand(level, before.label)) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
      const slider = await openEffortSlider(p)
      try {
        const levels = slider.levels.length ? slider.levels : claudeEffortLevels(before.label)
        if (!levels.includes(slider.current)) throw new HerdrError('unsafe', 'Unexpected effort slider — nothing was changed.')
        if (!levels.includes(level)) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
        const delta = levels.indexOf(level) - levels.indexOf(slider.current)
        if (delta) await herdr('pane.send_input', { pane_id: p.id, keys: Array.from({ length: Math.abs(delta) }, () => delta > 0 ? 'right' : 'left') })
        const at = await waitSlider(p.id, x => x.current === level, 3000)
        if (!at) throw new HerdrError('stale', 'The effort slider did not follow — nothing was changed.')
        // "s" = this session only. Never Enter: it saves the default.
        await herdr('pane.send_input', { pane_id: p.id, keys: ['s'] })
        if (!await sliderGone(p.id)) throw new HerdrError('stale', 'The effort slider stayed open — nothing was changed.')
      } catch (e) {
        await closeEffortSlider(p.id)
        throw e
      }
      screenEfforts.set(p.id, { effort: level, ms: Date.now() })
    } else {
      try {
        let menu = await codexEffortMenu(p, before)
        let option = menu.options.find(o => effortMatches(o.label, level))
        if (!option) {
          const more = menu.options.find(o => /more reasoning/i.test(o.label))
          if (!more) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
          await pick(p.id, menu, more.n, more.label, 'effort')
          await herdr('pane.send_input', { pane_id: p.id, keys: ['enter'] })
          const next = await waitMenu(p.id, x => x.kind === 'effort' && x.options.some(o => effortMatches(o.label, level)), 4000)
          if (!next || !next.sessionKey) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
          menu = next
          option = menu.options.find(o => effortMatches(o.label, level))
        }
        if (!option) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
        await pick(p.id, menu, option.n, option.label, 'effort')
        await herdr('pane.send_input', { pane_id: p.id, keys: ['s'] })
        const until = Date.now() + 5000
        let clear = 0
        while (clear < 2 && Date.now() < until) {
          clear = parseModelMenu(await screen(p.id)) ? 0 : clear + 1
          await sleep(250)
        }
        if (clear < 2) throw new HerdrError('stale', 'The /model menu changed — try again.')
      } catch (e) {
        await closeMenu(p.id).catch(() => {})
        throw e
      }
    }
    const info: ModelInfo = { ...before, effort: level, at: new Date(started).toISOString() }
    overrides.set(p.id, { ...info, ms: started })
    observedEfforts.set(p.id, { label: info.label, effort: level })
    setTimeout(poll, 100)
    return info
  })
}

// ── Devin ───────────────────────────────────────────────────────────────────
// /model opens a searchable picker (Devin v3000.x). Plain ↵ sets the GLOBAL
// default — only alt+↵ is session-scoped, so it is the only confirm key we
// ever send. Effort stays whatever the row carries.

const EFFORT_AGENTS = new Set(['claude', 'codex', 'omp'])

async function devinMenu(paneId: string, timeoutMs = 6000): Promise<DevinModelMenu | null> {
  const end = Date.now() + timeoutMs
  let m: DevinModelMenu | null = null
  do { m = parseDevinModelMenu(await screen(paneId)); if (m) return m; await sleep(300) } while (Date.now() < end)
  return null
}

// The picker counts as open while its legend is up — the model list AND an
// open Fusion Lead/Sidekick dropdown ("esc collapse") alike.
const devinPickerOpen = (text: string) => devinMenuOpen(text) || Boolean(parseDevinFusion(text)?.dropdown)

async function devinCloseMenu(paneId: string) {
  for (let i = 0; i < 3; i++) {
    if (!devinPickerOpen(await screen(paneId))) return
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] })
    await sleep(400)
  }
}

async function devinOpenMenu(paneId: string): Promise<DevinModelMenu> {
  await devinCloseMenu(paneId)
  await closePanel(paneId).catch(() => false)
  await agentPrompt(paneId, '/model')
  const m = await devinMenu(paneId)
  if (!m) { await devinCloseMenu(paneId); throw new HerdrError('no_menu', 'The /model menu did not show up') }
  return m
}

// Reads Fusion's Lead ▾ and Sidekick ▾ option lists: tab cycles the row's
// controls (effort → Lead → Sidekick → Fast Mode); an open dropdown shows its
// entries with "▸" on the current pick. Ends collapsed back on the menu.
async function devinReadFusionParts(paneId: string, m: DevinModelMenu): Promise<ModelPart[] | null> {
  const idx = m.options.findIndex(o => /^fusion$/i.test(o.label))
  if (idx < 0 || m.cursor < 0) return null
  const keys = moveKeys(m.cursor, idx)
  if (keys.length) { await herdr('pane.send_input', { pane_id: paneId, keys }); await sleep(300) }
  // Never drive blindly: the cursor must be on the Fusion row — its "tab lead"
  // legend is what makes the dropdowns reachable at all.
  const at = await devinMenu(paneId, 2000)
  if (!at || at.cursor < 0 || !/^fusion$/i.test(at.options[at.cursor]?.label || '')) return null
  const parts: ModelPart[] = []
  for (const which of ['lead', 'sidekick'] as const) {
    let st: DevinFusionState | null = null
    for (let t = 0; t < 5 && st?.dropdown?.which !== which; t++) {
      if (t) await sleep(250)
      await herdr('pane.send_input', { pane_id: paneId, keys: ['tab'] })
      await sleep(250)
      st = parseDevinFusion(await screen(paneId))
      if (!st) break // menu or Fusion row gone — stop tabbing a dead screen
    }
    if (st?.dropdown?.which !== which || !st.dropdown.options.length) break
    parts.push({
      key: which,
      label: which === 'lead' ? 'Lead' : 'Sidekick',
      options: st.dropdown.options.map(o => o.label),
      current: st.dropdown.options[st.dropdown.cursor]?.label || null,
    })
  }
  // Collapse any open dropdown back to the plain menu (esc: collapse, not cancel).
  for (let i = 0; i < 3 && parseDevinFusion(await screen(paneId))?.dropdown; i++) {
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] })
    await sleep(300)
  }
  return parts.length ? parts : null
}

async function devinListModels(p: Pane, refresh = false): Promise<ModelList> {
  const hit = listCache.get(listKey(p.id, 'devin'))
  if (hit && !refresh && Date.now() - hit.at < LIST_TTL_MS) return hit
  return withPane(p.id, async () => {
    const cur = await currentModel(p).catch(() => null)
    let m = await devinOpenMenu(p.id)
    const seen = new Map<string, ModelOption>()
    const parts = await devinReadFusionParts(p.id, m).catch(() => null)
    try {
      if (parts) m = (await devinMenu(p.id, 2000)) || m
      // Collect across scrolls until "↓ more below" disappears. The status
      // line prints "<model> <effort>" ("SWE-2 Max" for SWE-2 at Max), so a
      // current check also accepts the option's name plus an effort word.
      const isCurrent = (o: { label: string }) => {
        const cl = cur?.label || ''
        if (!cl) return false
        if (sameModel(o.label, cl)) return true
        const rest = cl.startsWith(o.label + ' ') ? cl.slice(o.label.length).trim() : ''
        return /^(?:low|medium|high|xhigh|max)$/i.test(rest)
      }
      for (let pages = 0; pages < 12; pages++) {
        for (const o of m.options) seen.set(o.label, { label: o.label, hint: o.hint, current: isCurrent(o) })
        if (!/↓ more below/.test(await screen(p.id))) break
        if (m.cursor < 0) break // unknown cursor: don't guess a position
        const last = m.options.length - 1
        await herdr('pane.send_input', { pane_id: p.id, keys: moveKeys(m.cursor, last) })
        await sleep(350)
        await herdr('pane.send_input', { pane_id: p.id, keys: ['down'] })
        await sleep(350)
        m = (await devinMenu(p.id, 2000)) || m
      }
    } finally { await devinCloseMenu(p.id) }
    const fusion = parts && seen.get('Fusion')
    if (fusion) fusion.parts = parts!
    const list: ModelList = { agent: 'devin', options: [...seen.values()], at: Date.now() }
    listCache.set(listKey(p.id, 'devin'), list)
    return list
  })
}

// Opens the Fusion row's `which` dropdown ("lead"/"sidekick") by tabbing the
// row's control cycle, then moves the "▸" pick to `name` — verified on screen:
// a name the dropdown does not offer is a bad_model, a cursor that does not
// follow is stale. Returns once the pick is set (dropdown still open).
async function devinPickFusionPart(paneId: string, which: 'lead' | 'sidekick', name: string) {
  let st: DevinFusionState | null = null
  for (let t = 0; t < 5; t++) {
    st = parseDevinFusion(await screen(paneId))
    if (st?.dropdown?.which === which) break
    if (!st) throw new HerdrError('stale', 'The /model menu changed — try again.')
    await herdr('pane.send_input', { pane_id: paneId, keys: ['tab'] })
    await sleep(250)
  }
  if (st?.dropdown?.which !== which) throw new HerdrError('stale', `Fusion’s ${which} picker did not open — try again.`)
  const i = st.dropdown.options.findIndex(o => o.label.toLowerCase() === name.toLowerCase())
  if (i < 0) throw new HerdrError('bad_model', fmt('Fusion {part} not offered: {name}', { part: which, name }))
  if (i !== st.dropdown.cursor) {
    await herdr('pane.send_input', { pane_id: paneId, keys: moveKeys(st.dropdown.cursor, i) })
    await sleep(300)
    const at = parseDevinFusion(await screen(paneId))
    if (at?.dropdown?.which !== which || at.dropdown.cursor !== i) throw new HerdrError('stale', 'The /model menu changed — try again.')
  }
}

// Collapses an open Lead/Sidekick dropdown back onto the plain menu
// ("esc collapse"); the pending pick stays on the row.
async function devinCollapse(paneId: string) {
  for (let i = 0; i < 3; i++) {
    if (!parseDevinFusion(await screen(paneId))?.dropdown) return
    await herdr('pane.send_input', { pane_id: paneId, keys: ['esc'] })
    await sleep(300)
  }
}

async function devinSetModel(paneId: string, wanted: string, parts?: Record<string, string>): Promise<ModelInfo> {
  if (!wanted) throw new HerdrError('bad_model', 'Missing model')
  const label = wanted.toLowerCase()
  return withPane(paneId, async (p) => {
    const started = Date.now()
    await devinOpenMenu(p.id)
    try {
      // Narrow with the search field, then alt+↵ on the matching row.
      for (const ch of wanted.slice(0, 40)) {
        await herdr('pane.send_input', { pane_id: p.id, keys: [ch] })
        await sleep(60)
      }
      const m = await devinMenu(p.id, 3000)
      const n = m?.options.findIndex(o => o.label.toLowerCase() === label) ?? -1
      if (!m || n < 0) throw new HerdrError('bad_model', fmt('Model not found in /model: {model}', { model: wanted }))
      const target = m.options[n]!.label
      // Never guess the cursor: a missing ❭ makes any move land on a wrong row.
      if (m.cursor < 0) throw new HerdrError('stale', 'The /model menu changed — try again.')
      const keys = moveKeys(m.cursor, n)
      if (keys.length) { await herdr('pane.send_input', { pane_id: p.id, keys }); await sleep(300) }
      const selected = await devinMenu(p.id, 3000)
      if (!selected || selected.cursor < 0 || selected.options[selected.cursor]?.label !== target) {
        throw new HerdrError('stale', 'The /model menu changed — try again.')
      }
      // Composite picks (Fusion's Lead ▾ / Sidekick ▾): choose each requested
      // part in its dropdown, collapse, then confirm the row with the pair on it.
      const picks = parts ? (['lead', 'sidekick'] as const).filter(k => parts[k]?.trim()) : []
      if (parts && Object.keys(parts).length && !picks.length) throw new HerdrError('bad_model', 'Unknown model part')
      if (picks.length && !/^fusion$/i.test(target)) throw new HerdrError('bad_model', fmt('Model has no selectable parts: {model}', { model: target }))
      for (const which of picks) await devinPickFusionPart(p.id, which, parts![which]!.trim())
      if (picks.length) await devinCollapse(p.id)
      await herdr('pane.send_input', { pane_id: p.id, keys: ['alt+enter'] })
      // Verify: the menu closes, then the pick counts once any live signal
      // names THIS model — the echo ("Model set to … for this session"), the
      // status line ("Fusion · Lead ◆ Sidekick · bypass") or the transcript.
      const end = Date.now() + 4000
      let echo: string | null = null
      let shown: string | null = null
      let pair: { lead: string, sidekick: string } | null = null
      do {
        const t = await screen(p.id)
        if (!devinPickerOpen(t)) { echo = devinModelSetEcho(t); shown = devinStatusModel(t); pair = devinStatusPair(t); break }
        await sleep(300)
      } while (Date.now() < end)
      const now = await transcripts.model(p).catch(() => null)
      if (!sameModel(echo, target) && !sameModel(shown || '', target) && !sameModel(now?.label || '', target)) {
        throw new HerdrError('stale', echo
          ? fmt('Devin set a different model ({model}) — check the session.', { model: echo })
          : 'The model did not change — try again.')
      }
      // A requested pair is only done when the status line shows it — the row's
      // fields can be truncated, the status line's "Lead ◆ Sidekick" is not.
      if (picks.length) {
        const pairOk = pair && picks.every(k => sameModel(pair![k === 'lead' ? 'lead' : 'sidekick'], parts![k]))
        if (!pairOk) throw new HerdrError('stale', pair
          ? `Fusion applied ${pair.lead} ◆ ${pair.sidekick} — not the requested pair.`
          : 'Could not verify the Fusion pair — check the session.')
      }
      const info: ModelInfo = { id: target, label: target, at: new Date(started).toISOString() }
      overrides.set(p.id, { ...info, ms: started })
      setTimeout(poll, 100)
      return info
    } finally { await devinCloseMenu(p.id) }
  })
}
