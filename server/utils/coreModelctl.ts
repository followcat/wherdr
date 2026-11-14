// Model lists and switches on herdr-core (port of v2 modelctl's drive side).
// Everything that types or sends keys is security-sensitive: every
// terminal.send and every non-menu terminal.keys re-runs the withPane gate on
// a fresh terminal.read (TOCTOU — the menu can turn into a native prompt while
// a list or a pick is in flight). Menu-internal keys are only sent while the
// picker's own parser still matches the same-step fresh screen. Lists that
// touch the terminal hold `busy`; the zero-IO lists (opencode service read,
// cmd machine.exec) hold `busy` only — never both operations at once on a pane.
import { readCoreScreen } from './coreScreen'
import { HerdrError } from './herdr'
import { log } from './env'
import { sleep as defaultSleep } from './herdr'
import { cleanModelName, sameModel, effortMatches, effortValue, claudeEffortCommand, claudeEffortLevels, codexCachedEfforts, learnOmpCycle, ompEffortLevels, ompModelLabel, ompScreenEffort, parseClaudeEffortScreen, OMP_EFFORT_ORDER, type ClaudeEffortSlider, type OmpCycleKnowledge } from './models'
import { parseModelMenu, parseOmpSelector, switchConfirmKeys, switchDeclineKeys, ompSelectorCaption, panelOpen, type ModelMenu, type OmpSelector } from './modelMenus'
import { devinMenuOpen, parseDevinModelMenu, parseDevinFusion, devinModelSetEcho, devinStatusModel, devinStatusPair, type DevinModelMenu, type DevinFusionState } from './devinMenu'
import { ompSelectorOnScreen } from '../../shared/ompSelector'
import { fmt } from '../../shared/message'
import type { Machine } from './machines'
import type { ExecResult } from './fsx'
import type { EffortList, ModelInfo, ModelList, ModelOption, ModelPart, Pane } from '../../shared/types'

// Agents whose picker a pane may drive. `cmd` is list-only (its /model rewrites
// the account default — docs/security.md) but listing needs the same gate.
export const SWITCH_AGENTS = new Set(['claude', 'codex', 'omp', 'devin', 'opencode', 'cmd'])
const READY = new Set(['done', 'idle'])

// One /api/model catalog entry (the fields wherdr reads).
type OpenCodeEntry = { id: string, providerID: string, name?: string, modelID?: string, enabled?: boolean, variants?: string[] }
// An option label must identify one catalog entry: providers can offer the
// same display name, so duplicates carry their provider.
const opencodeEntryLabel = (e: OpenCodeEntry, dup: boolean) => dup ? `${e.name || e.id} (${e.providerID})` : String(e.name || e.id)

const moveKeys = (from: number, to: number) => Array.from({ length: Math.abs(to - from) }, () => (to > from ? 'down' : 'up'))

type Call = <T>(method: string, params: object, timeout: number) => Promise<T>
export interface CoreModelCtlDeps {
  call: Call // coreCall-shaped: 'terminal.read' | 'terminal.keys' | 'terminal.send'
  pane: (id: string) => Pane | undefined
  machine: (p: Pane) => Promise<Machine> // coreFilesMachine(p.machine)
  execLocal: (script: string, home: string, timeoutMs: number) => Promise<ExecResult> // runLocal
  transcript: (p: Pane) => Promise<ModelInfo | null> // transcripts.model
  currentModel: (p: Pane) => Promise<ModelInfo | null> // modelCtl().currentModel
  opencodeModels?: (p: Pane) => Promise<Record<string, any>[] | null> // transcripts.opencodeModels (service read)
  opencodePatchModel?: (p: Pane, model: { id: string, providerID: string, variant?: string }) => Promise<Record<string, any> | null> // transcripts.opencodePatchModel (whitelisted PATCH + re-GET)
  noteList: (p: Pane, agent: string, list: ModelList) => void // modelCtl().noteList
  noteOverride: (paneId: string, info: ModelInfo) => void // modelCtl().noteOverride — pill update before the next poll
  noteObservedEffort: (paneId: string, label: string, effort: string) => void // modelCtl().noteObservedEffort
  noteScreenEffort: (paneId: string, effort: string) => void // modelCtl().noteScreenEffort
  refresh?: () => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function createCoreModelCtl(deps: CoreModelCtlDeps) {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const busy = new Set<string>()
  // Panes whose screen our own menu IO may still be covering: marked while a
  // withPane op runs, until any read — the gate's below or the poll's
  // `noteRead` — sees the input field again. The poll parses our /model menu
  // as a native "blocked" prompt; the mark is broadcast as `menuLeftOpen` so
  // the phone knows the covered input is the picker's own doing.
  const menuMarks = new Set<string>()

  const pane = (id: unknown): Pane => {
    const p = typeof id === 'string' ? deps.pane(id) : undefined
    if (!p?.coreAddress || !p.agent || !SWITCH_AGENTS.has(p.agent)) throw new HerdrError('bad_pane', 'Pane not found')
    return p
  }
  const screen = async (p: Pane) =>
    String(((await deps.call<{ text?: string }>('terminal.read', { terminal: p.coreAddress, lines: 0 }, 4000)).text) || '')

  // The gate: a fresh screen must classify as the agent's own input — no
  // native prompt or menu, idle/done, nothing drafted. Called before every
  // terminal.send and before every non-menu terminal.keys. `r.status` is the
  // fresh read's proof ('blocked' when a prompt sits on an idle pane); it is
  // null on a clean input, where the pane's polled status carries READY.
  // A marked pane's stale 'blocked' is our menu's echo: classify its fresh
  // screen as 'idle' — under 'blocked' the loose prompt parse flags even a
  // clean input as choices.
  const markedRead = (p: Pane, text: string) =>
    readCoreScreen(text, p.agent, menuMarks.has(p.id) && p.status === 'blocked' ? 'idle' : p.status)

  async function gate(p: Pane) {
    const r = markedRead(p, await screen(p))
    // A marked pane read clean: the prompt/blocked flags the poll derived were
    // our menu's echo — repair them instead of refusing on stale state. The
    // mark itself stays while this op still runs (busy): every later read in
    // the same call may show our menu again. It lifts on the first clean read
    // seen without an op — here, or the poll's `noteRead`.
    if (menuMarks.has(p.id) && r.interaction === 'input' && !r.choices) {
      if (!busy.has(p.id)) menuMarks.delete(p.id)
      delete p.prompt
      p.interaction = 'input'
      if (p.status === 'blocked') p.status = 'idle'
    }
    if (r.interaction !== 'input' || r.choices || !READY.has(r.status || p.status || '') || p.prompt || p.draft || p.codexField)
      throw new HerdrError('blocked', 'The agent is waiting for an answer: reply in the terminal')
  }
  // Menu-internal keys: the screen must still parse as `check` (the picker we
  // believe is open) on the same-step fresh screen. The model menu itself is a
  // numbered Choices screen, so the parser match — not `interaction` — is the
  // proof; a native prompt that replaced it fails the parser and refuses.
  async function menuKeys<T>(p: Pane, keys: string[], check: (text: string) => T | null): Promise<T> {
    const m = check(await screen(p))
    if (!m) throw new HerdrError('stale', 'The picker changed — try again.')
    await deps.call('terminal.keys', { terminal: p.coreAddress, keys }, 10000)
    return m
  }
  const sendInput = async (p: Pane, text: string) => {
    await gate(p)
    await deps.call('terminal.send', { terminal: p.coreAddress, text }, 30000)
  }
  const sendKeys = async (p: Pane, keys: string[]) => {
    await gate(p)
    await deps.call('terminal.keys', { terminal: p.coreAddress, keys }, 10000)
  }

  async function withPane<T>(paneId: string, fn: (p: Pane) => Promise<T>): Promise<T> {
    const p = pane(paneId)
    // busy.add before the first await: the gate's read yields, and without it a
    // second call could slip through busy.has while the first is still reading.
    if (busy.has(p.id)) throw new HerdrError('busy', 'A model operation is already running on this pane')
    busy.add(p.id)
    try { await gate(p); menuMarks.add(p.id); return await fn(p) } finally { busy.delete(p.id); deps.refresh?.() }
  }
  // Zero-IO operations (opencode service read, cmd machine.exec): busy only,
  // no terminal gate — nothing reaches the terminal.
  async function withBusy<T>(paneId: string, fn: (p: Pane) => Promise<T>): Promise<T> {
    const p = pane(paneId)
    if (busy.has(p.id)) throw new HerdrError('busy', 'A model operation is already running on this pane')
    busy.add(p.id)
    try { return await fn(p) } finally { busy.delete(p.id) }
  }

  const waitScreen = async <T>(p: Pane, check: (text: string) => T | null, timeoutMs: number): Promise<T | null> => {
    const end = now() + timeoutMs
    for (;;) {
      const m = check(await screen(p))
      if (m) return m
      if (now() >= end) return null
      await sleep(300)
    }
  }
  // Claude/Codex numbered menus of one kind (model or effort) — the
  // menu-internal key gate and the waits share this check.
  const menuCheck = (kind: ModelMenu['kind']) => (t: string) => {
    const x = parseModelMenu(t)
    return x?.kind === kind ? x : null
  }

  // -------------------------------------------------------- claude/codex menu
  const modelMenu = (p: Pane) => waitScreen(p, t => parseModelMenu(t)?.kind === 'model' ? parseModelMenu(t) : null, 6000)
  // A full-screen panel (claude/codex) swallowing the input is esc'd before
  // typing — the recovery nicety, not a gate: each esc re-checks panelOpen on
  // a fresh screen, so a real prompt is never touched.
  async function closePanel(p: Pane) {
    if (p.agent !== 'claude' && p.agent !== 'codex') return false
    let sent = false
    for (let i = 0; i < 2; i++) {
      if (!panelOpen(await screen(p), p.agent)) return sent
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      sent = true
      await sleep(400)
    }
    return sent
  }
  async function openMenu(p: Pane): Promise<ModelMenu> {
    // A leftover /model menu is closed first — esc only while the model menu
    // itself still parses; a foreign prompt on screen makes the send gate
    // below refuse instead of being answered.
    for (let i = 0; i < 3; i++) {
      if (!parseModelMenu(await screen(p))) break
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(400)
    }
    await closePanel(p)
    await sendInput(p, '/model')
    const m = await modelMenu(p)
    if (!m) { await closeMenu(p); throw new HerdrError('no_menu', 'The /model menu did not show up') }
    return m
  }
  async function closeMenu(p: Pane) {
    for (let i = 0; i < 4; i++) {
      const text = await screen(p)
      if (!parseModelMenu(text) && !readCoreScreen(text, p.agent, p.status).choices) return
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(400)
    }
  }

  // All option rows (numbered): Claude only shows 10 (↑/↓ before the number),
  // we go back to the top then down page by page (the list wraps to the top
  // after the last one).
  async function readAllOptionRows(p: Pane, first: ModelMenu): Promise<ModelMenu['options']> {
    const all = new Map(first.options.map(o => [o.n, o]))
    let m = first
    // Page opened further down (current model at the end of the list): go back up to no. 1 first.
    if (m.options[0]!.n > 1) {
      await menuKeys(p, moveKeys(m.cursor, 1), t => parseModelMenu(t)?.kind === 'model' ? parseModelMenu(t) : null)
      const top = await waitScreen(p, t => { const x = parseModelMenu(t); return x?.kind === 'model' && x.cursor === 1 ? x : null }, 3000)
      if (!top) throw new HerdrError('stale', 'The /model menu changed — try again.')
      for (const o of top.options) if (!all.has(o.n)) all.set(o.n, o)
      m = top
    }
    for (let i = 0; i < 8 && m.scrollDown; i++) {
      const last = m.options[m.options.length - 1]!.n
      await menuKeys(p, moveKeys(m.cursor, last + 1), t => parseModelMenu(t)?.kind === 'model' ? parseModelMenu(t) : null)
      await sleep(350)
      const next = await waitScreen(p, t => { const x = parseModelMenu(t); return x?.kind === 'model' ? x : null }, 2000)
      if (!next || next.cursor <= last) break // wrapped: end of list
      const before = all.size
      for (const o of next.options) if (!all.has(o.n)) all.set(o.n, o)
      if (all.size === before) break
      m = next
    }
    return [...all.values()].sort((a, b) => a.n - b.n)
  }
  // "current" is not kept: the list is shared by all agents of the kind.
  const readAllOptions = async (p: Pane, first: ModelMenu): Promise<ModelOption[]> =>
    (await readAllOptionRows(p, first)).map(o => ({ label: o.label, hint: o.hint, isDefault: Boolean(o.isDefault) }))

  // Cursor onto option `n` — verified on screen (option still `label`, cursor
  // really there). The menu is left open; the returned state is post-move.
  async function pick(p: Pane, m: ModelMenu, n: number, label: string, kind: ModelMenu['kind']): Promise<ModelMenu> {
    const keys = moveKeys(m.cursor, n)
    if (keys.length) await menuKeys(p, keys, menuCheck(kind))
    const at = await waitScreen(p, t => { const x = parseModelMenu(t); return x?.kind === kind && x.cursor === n ? x : null }, 3000)
    const o = at && at.options.find(x => x.n === n)
    if (!at || !o || o.label !== label) throw new HerdrError('stale', 'The /model menu changed — try again.')
    return at
  }

  async function menuList(p: Pane): Promise<ModelList> {
    return withPane(p.id, async () => {
      const first = await openMenu(p)
      try {
        const options = await readAllOptions(p, first)
        const list: ModelList = { agent: p.agent!, options, at: now() }
        deps.noteList(p, p.agent!, list)
        return list
      } finally { await closeMenu(p) }
    })
  }

  // A session-only model switch: "s to use this session only" (Claude, or
  // Codex's effort page), never a global default. A wrong-model "Switch
  // model?" confirm is refused — its keys go out only when the screen names
  // the requested model.
  async function setModel(paneId: unknown, wanted: unknown, parts?: unknown): Promise<ModelInfo> {
    const p0 = pane(paneId)
    if (p0.agent === 'omp') return ompSetModel(p0, wanted)
    if (p0.agent === 'devin') return devinSetModel(p0, wanted, parts)
    if (p0.agent === 'opencode') return opencodeSetModel(p0, wanted, parts)
    if (p0.agent === 'cmd')
      throw new HerdrError('unsupported', 'Switching this agent’s model is not supported yet')
    if (parts && typeof parts === 'object' && Object.keys(parts as object).length)
      throw new HerdrError('unsupported', 'This model has no selectable parts')
    const label = cleanModelName(String(wanted || ''))
    if (!label) throw new HerdrError('bad_model', 'Missing model')
    return withPane(p0.id, async (p) => {
      const before = await deps.currentModel(p).catch(() => null)
      const started = now()
      let m = await openMenu(p)
      try {
        // Option number: in the list read (the menu only shows one page).
        let n = m.options.find(o => o.label === label)?.n
        if (!n) {
          n = (await readAllOptionRows(p, m)).find(o => o.label === label)?.n
          m = (await waitScreen(p, menuCheck('model'), 2000)) || m // cursor moved
        }
        if (!n) throw new HerdrError('bad_model', fmt('Model not found in /model: {model}', { model: label }))
        m = await pick(p, m, n, label, 'model')
        // "Default (recommended)": Claude confirms with the default model's name.
        const picked = m.options.find(o => o.n === n)
        const confirmAs = /^default\b/i.test(label) && picked && picked.hint ? cleanModelName(picked.hint.split('·')[0]!) : label

        let effort: string | null = null
        if (p.agent === 'claude') {
          if (!m.sessionKey) throw new HerdrError('unsafe', '“This session only” option not found — nothing was changed.')
          effort = m.effort
          await menuKeys(p, ['s'], menuCheck('model'))
        } else {
          // Codex: Enter only moves on to the effort choice ("enter select").
          if (!m.enterSelects) throw new HerdrError('unsafe', 'Unexpected /model menu — nothing was changed.')
          await menuKeys(p, ['enter'], menuCheck('model'))
          const e = await waitScreen(p, menuCheck('effort'), 4000)
          if (!e || !e.sessionKey) throw new HerdrError('unsafe', 'Unexpected effort menu — nothing was changed.')
          // Keep the current effort if it exists for this model, otherwise the one offered.
          const keep = e.options.find(o => effortMatches(o.label, before && before.effort))
          const at = keep && keep.n !== e.cursor ? await pick(p, e, keep.n, keep.label, 'effort') : e
          effort = (at.options.find(o => o.n === at.cursor)?.label || '').toLowerCase().replace(/\s+/g, '') || null
          if (effort === 'extrahigh') effort = 'xhigh'
          await menuKeys(p, ['s'], menuCheck('effort'))
        }
        // Menu closed = choice taken. Claude may first ask for confirmation
        // (conversation cached for the old model): we confirm this model.
        // Done when neither menu nor confirmation is seen twice in a row.
        const until = now() + 5000
        let clear = 0
        while (clear < 2 && now() < until) {
          const text = await screen(p)
          const confirm = p.agent === 'claude' ? switchConfirmKeys(text, confirmAs) : null
          if (confirm) {
            await menuKeys(p, confirm, t => switchConfirmKeys(t, confirmAs))
            clear = 0
            await sleep(400)
            continue
          }
          // A "Switch model?" for another model is declined — the alternative
          // is an agent left stuck on a dialog our pick caused.
          const decline = p.agent === 'claude' ? switchDeclineKeys(text) : null
          if (decline) {
            await menuKeys(p, decline, t => switchDeclineKeys(t))
            throw new HerdrError('stale', 'The confirmation offered a different model — nothing was changed.')
          }
          clear = parseModelMenu(text) ? 0 : clear + 1
          await sleep(250)
        }
        if (clear < 2) throw new HerdrError('stale', 'The /model menu changed — try again.')
        const info: ModelInfo = { id: null, label: confirmAs, effort, at: new Date(started).toISOString() }
        deps.noteOverride(p.id, info)
        if (effort) deps.noteObservedEffort(p.id, confirmAs, effort)
        log(`model ${p.id} (${p.agent}) -> ${confirmAs}${effort ? ' ' + effort : ''} (this session)`)
        return (await deps.currentModel(p).catch(() => null)) || info
      } catch (e) {
        await closeMenu(p).catch(() => {})
        throw e
      }
    })
  }

  // ------------------------------------------------------------------- omp
  const ompSel = (text: string) => { const s = parseOmpSelector(text); return s && !s.task ? s : null }
  async function ompClose(p: Pane) {
    for (let i = 0; i < 4; i++) {
      if (!ompSelectorOnScreen(await screen(p))) return
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(400)
    }
  }
  // Selector open and readable. omp 18.6: alt+p toggles between the session
  // and the Task subagent selectors; only the session one may be driven.
  async function openOmpSelector(p: Pane): Promise<OmpSelector> {
    await ompClose(p)
    await sendKeys(p, ['alt+p'])
    let s = await waitScreen(p, parseOmpSelector, 4000)
    if (s?.task) {
      await menuKeys(p, ['alt+p'], parseOmpSelector)
      s = await waitScreen(p, ompSel, 4000)
    }
    if (!s) { await ompClose(p); throw new HerdrError('no_menu', 'The model selector did not show up') }
    if (s.truncated) { await ompClose(p); throw new HerdrError('narrow', 'The selector is too narrow to read model ids — widen the pane.') }
    return s
  }
  async function ompListModels(p: Pane): Promise<ModelList> {
    return withPane(p.id, async () => {
      const s = await openOmpSelector(p)
      try {
        const options: ModelOption[] = s.options.map(o => ({ label: o.label, hint: o.hint, current: o.current }))
        const list: ModelList = { agent: 'omp', options, at: now() }
        deps.noteList(p, 'omp', list)
        return list
      } finally { await ompClose(p) }
    })
  }

  // omp's own transcript writes the change ("model_change" …, "role":
  // "temporary"); wait for it so currentModel() is right away.
  async function waitOmpModel(p: Pane, id: string, since: number): Promise<boolean> {
    const until = now() + 4000
    for (;;) {
      const info = await deps.transcript(p).catch(() => null)
      if (info && info.id === id && info.at && Date.parse(info.at) >= since - 1500) return true
      if (now() > until) return false
      await sleep(300)
    }
  }

  // The selector's Enter applies to this session only ("use for this
  // session") — never a global default. Rows have no numbers: the cursor
  // moves one down/up per model, re-reading the screen between steps; search
  // narrows the list when the id isn't visible.
  async function ompSetModel(p: Pane, wanted: unknown): Promise<ModelInfo> {
    const id = String(wanted || '').trim()
    if (!id) throw new HerdrError('bad_model', 'Missing model')
    return withPane(p.id, async (p) => {
      const started = now()
      let s = await openOmpSelector(p)
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
            await menuKeys(p, [ch === ' ' ? 'space' : ch], ompSel)
            await sleep(80)
          }
          s = (await waitScreen(p, x => { const o = ompSel(x); return o && o.search.length > 0 ? o : null }, 3000)) || s
          at = rank(s)
        }
        if (at < 0) throw new HerdrError('bad_model', fmt('Model not found in omp’s selector: {model}', { model: id }))
        // One "down"/"up" per row; the list can change under the cursor
        // (search, scrollbar), so each step re-reads and recomputes.
        for (let n = 0; n < 80; n++) {
          s = (await waitScreen(p, ompSel, 1500)) || s
          const delta = at - s.cursor
          if (delta === 0) break
          await menuKeys(p, [delta > 0 ? 'down' : 'up'], ompSel)
          await sleep(120)
          if (n === 79) throw new HerdrError('stale', 'The model selector did not follow — nothing was changed.')
        }
        s = (await waitScreen(p, x => { const o = ompSel(x); return o && o.cursor === at && o.options[at]?.label === id ? o : null }, 3000))
          ?? (await waitScreen(p, ompSel, 1000)) ?? s
        if (s.cursor !== at || s.options[at]!.label !== id) throw new HerdrError('stale', 'The model selector changed — try again.')
        await menuKeys(p, ['enter'], ompSel)
        await waitOmpModel(p, id, started)
      } catch (e) {
        await ompClose(p).catch(() => {})
        throw e
      }
      const text = await screen(p).catch(() => '')
      const caption = ompSelectorCaption(text, id)
      // The level stays on the status line (no transcript before the first message).
      const effort = ompScreenEffort(text, ompModelLabel(id))
      const info: ModelInfo = { id, label: caption?.name || ompModelLabel(id), effort, at: new Date(started).toISOString() }
      deps.noteOverride(p.id, info)
      log(`model ${p.id} (omp) -> ${id} (this session)`)
      return (await deps.currentModel(p).catch(() => null)) || info
    })
  }

  // ------------------------------------------------------------ omp ⇧⇥ cycle
  // Per machine and model: what the ⇧⇥ presses showed of its cycle.
  const ompCycles = new Map<string, OmpCycleKnowledge>()
  const ompCycleKey = (p: Pane, model: ModelInfo) => `${p.machine || ''}|${cleanModelName(model.label).toLowerCase()}`

  // Level after one ⇧⇥ press from `prev`. With a transcript, its new
  // "thinking_level_change" entry (newer than `sinceAt`) gives the configured
  // level. Without one, only the status line — and after a turn "auto" shows
  // the glyph of the level it resolved to, so the glyph alone cannot tell
  // "auto" from that level. The cycle can: a press from "off" always lands on
  // "auto", and a press from a resolved "auto" may keep the glyph (it lands
  // on the level auto had picked), taken once the line has redrawn.
  const OMP_REDRAW_MS = 1000
  async function waitOmpEffort(p: Pane, model: string, prev: string, shown: string, sinceAt: string | null, hasTranscript: boolean) {
    const pressed = now()
    for (;;) {
      const tr = await deps.transcript(p).catch(() => null)
      if (tr && tr.effort && tr.at && (!sinceAt || tr.at > sinceAt)) {
        return { level: tr.effort, at: tr.at, shown: ompScreenEffort(await screen(p).catch(() => ''), model) || shown }
      }
      if (!hasTranscript) {
        const cur = ompScreenEffort(await screen(p).catch(() => ''), model)
        if (cur && cur !== shown) return { level: prev === 'off' ? 'auto' : cur, at: sinceAt, shown: cur }
        if (cur && prev === 'auto' && shown !== 'auto' && now() - pressed > OMP_REDRAW_MS) return { level: cur, at: sinceAt, shown: cur }
      }
      if (now() - pressed > 3000) return null
      await sleep(200)
    }
  }

  // Presses ⇧⇥ until omp is on `level`, re-reading after each press. A full
  // turn back to the starting level means the model does not offer it.
  async function ompCycleTo(p: Pane, before: ModelInfo, level: string) {
    if (!OMP_EFFORT_ORDER.includes(level)) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
    let shown = ompScreenEffort(await screen(p), before.label)
    const tr = await deps.transcript(p).catch(() => null)
    // The transcript's level, else the status line: wherdr's own record
    // (`before`, possibly older than a change made in the terminal) only for
    // "auto", which the glyph no longer shows after a turn.
    const start = tr && tr.effort ? tr.effort
      : shown && before.effort === 'auto' && shown !== 'off' ? 'auto' : shown
    if (!shown || !start) throw new HerdrError('unsafe', 'omp’s thinking level is not on screen — nothing was changed.')
    if (start === level) return
    const key = ompCycleKey(p, before)
    const presses = [start]
    let at = tr ? tr.at || null : null
    try {
      for (let n = 0; n < OMP_EFFORT_ORDER.length; n++) {
        await sendKeys(p, ['shift+tab'])
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
        deps.noteOverride(p.id, { ...before, effort: reached, at: new Date(now()).toISOString() })
        deps.noteObservedEffort(p.id, before.label, reached)
      }
    }
  }

  // ------------------------------------------------------ claude effort slider
  const sliderOn = (text: string) => parseClaudeEffortScreen(text)
  const waitSlider = (p: Pane, ok: (s: ClaudeEffortSlider) => boolean, timeoutMs: number) =>
    waitScreen(p, x => { const s = sliderOn(x); return s && ok(s) ? s : null }, timeoutMs)
  async function sliderGone(p: Pane, timeoutMs = 3000) {
    const until = now() + timeoutMs
    let clear = 0
    while (clear < 2 && now() < until) {
      clear = sliderOn(await screen(p).catch(() => '')) ? 0 : clear + 1
      if (clear < 2) await sleep(250)
    }
    return clear >= 2
  }
  // Escape while the slider is on screen: it must never stay open.
  async function closeEffortSlider(p: Pane) {
    for (let i = 0; i < 3; i++) {
      if (!sliderOn(await screen(p).catch(() => ''))) return
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000).catch(() => {})
      await sleep(400)
    }
  }
  async function openEffortSlider(p: Pane): Promise<ClaudeEffortSlider> {
    await closeEffortSlider(p)
    await closePanel(p)
    await sendInput(p, '/effort')
    const s = await waitSlider(p, () => true, 4000)
    if (!s) {
      // Unknown screen: one Escape unless it is a native prompt — a prompt
      // must never be answered by accident (the slider may just be unreadable).
      const text = await screen(p).catch(() => '')
      if (!readCoreScreen(text, p.agent, p.status).choices) {
        await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000).catch(() => {})
      }
      throw new HerdrError('no_menu', 'Claude’s effort slider could not be read — closed, nothing was changed.')
    }
    return s
  }

  // ------------------------------------------------------- codex effort menu
  async function codexEffortMenu(p: Pane, model: ModelInfo): Promise<ModelMenu> {
    const m = await openMenu(p)
    if (!m.enterSelects) throw new HerdrError('unsafe', 'Unexpected /model menu — nothing was changed.')
    const current = m.options.find(o => o.current || sameModel(o.label, model.label))
    if (!current) throw new HerdrError('stale', 'The /model menu changed — try again.')
    await pick(p, m, current.n, current.label, 'model')
    await menuKeys(p, ['enter'], menuCheck('model'))
    const e = await waitScreen(p, menuCheck('effort'), 4000)
    if (!e || !e.sessionKey) throw new HerdrError('unsafe', 'Unexpected effort menu — nothing was changed.')
    return e
  }

  // Devin/OpenCode have a model picker but no wherdr effort control yet.
  const EFFORT_AGENTS = new Set(['claude', 'codex', 'omp'])

  async function listEfforts(paneId: unknown): Promise<EffortList> {
    const p0 = pane(paneId)
    return withPane(p0.id, async (p) => {
      if (!EFFORT_AGENTS.has(p.agent!)) return { levels: [], current: null }
      const model = await deps.currentModel(p).catch(() => null)
      if (!model) return { levels: [], current: null }
      // omp: levels of its ⇧⇥ cycle, as far as the presses have shown them.
      if (p.agent === 'omp') {
        const levels = model.effort ? ompEffortLevels(learnOmpCycle(ompCycles.get(ompCycleKey(p, model)) || null, [model.effort])) : []
        return { levels, current: model.effort || null }
      }
      if (p.agent === 'claude') {
        // Reading the list must not send /effort: Claude records even a
        // cancelled opening in the transcript. The choice checks the levels
        // actually offered by the slider before changing anything.
        return { levels: claudeEffortLevels(model.label), current: model.effort || null }
      }
      const machine = await deps.machine(p).catch(() => null)
      if (machine?.home) {
        try {
          const levels = codexCachedEfforts(await machine.fs.readFile(`${machine.home}/.codex/models_cache.json`), model.id || model.label)
          if (levels.length) return { levels, current: model.effort || null }
        } catch { /* live menu as a fallback */ }
      }
      try {
        const menu = await codexEffortMenu(p, model)
        const levels = menu.options.map(o => effortValue(o.label)).filter((e): e is string => Boolean(e))
        return { levels, current: model.effort || null }
      } finally { await closeMenu(p).catch(() => {}) }
    })
  }

  async function setEffort(paneId: unknown, level: unknown): Promise<ModelInfo> {
    const p0 = pane(paneId)
    return withPane(p0.id, async (p) => {
      if (!EFFORT_AGENTS.has(p.agent!)) throw new HerdrError('unsupported', 'This agent’s effort cannot be changed from wherdr')
      const before = await deps.currentModel(p).catch(() => null)
      if (!before) throw new HerdrError('bad_model', 'Unknown model')
      const started = now()
      if (p.agent === 'omp') {
        await ompCycleTo(p, before, String(level || ''))
      } else if (p.agent === 'claude') {
        if (!claudeEffortCommand(String(level || ''), before.label)) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
        const slider = await openEffortSlider(p)
        try {
          const levels = slider.levels.length ? slider.levels : claudeEffortLevels(before.label)
          if (!levels.includes(slider.current)) throw new HerdrError('unsafe', 'Unexpected effort slider — nothing was changed.')
          if (!levels.includes(String(level || ''))) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
          const delta = levels.indexOf(String(level || '')) - levels.indexOf(slider.current)
          if (delta) await menuKeys(p, Array.from({ length: Math.abs(delta) }, () => delta > 0 ? 'right' : 'left'), sliderOn)
          const at = await waitSlider(p, x => x.current === level, 3000)
          if (!at) throw new HerdrError('stale', 'The effort slider did not follow — nothing was changed.')
          // "s" = this session only. Never Enter: it saves the default.
          await menuKeys(p, ['s'], sliderOn)
          if (!await sliderGone(p)) throw new HerdrError('stale', 'The effort slider stayed open — nothing was changed.')
        } catch (e) {
          await closeEffortSlider(p)
          throw e
        }
        deps.noteScreenEffort(p.id, String(level))
      } else {
        try {
          let menu = await codexEffortMenu(p, before)
          let option = menu.options.find(o => effortMatches(o.label, String(level || '')))
          if (!option) {
            const more = menu.options.find(o => /more reasoning/i.test(o.label))
            if (!more) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
            await pick(p, menu, more.n, more.label, 'effort')
            await menuKeys(p, ['enter'], menuCheck('effort'))
            const next = await waitScreen(p, x => {
              const m = parseModelMenu(x)
              return m?.kind === 'effort' && m.options.some(o => effortMatches(o.label, String(level || ''))) ? m : null
            }, 4000)
            if (!next || !next.sessionKey) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
            menu = next
            option = menu.options.find(o => effortMatches(o.label, String(level || '')))
          }
          if (!option) throw new HerdrError('bad_effort', 'Effort level unavailable for this model')
          await pick(p, menu, option.n, option.label, 'effort')
          await menuKeys(p, ['s'], menuCheck('effort'))
          const until = now() + 5000
          let clear = 0
          while (clear < 2 && now() < until) {
            clear = parseModelMenu(await screen(p)) ? 0 : clear + 1
            await sleep(250)
          }
          if (clear < 2) throw new HerdrError('stale', 'The /model menu changed — try again.')
        } catch (e) {
          await closeMenu(p).catch(() => {})
          throw e
        }
      }
      const info: ModelInfo = { ...before, effort: String(level || ''), at: new Date(started).toISOString() }
      deps.noteOverride(p.id, info)
      deps.noteObservedEffort(p.id, info.label, String(level || ''))
      return info
    })
  }

  // ----------------------------------------------------------------- devin
  const devinPickerOpen = (text: string) => devinMenuOpen(text) || Boolean(parseDevinFusion(text)?.dropdown)
  async function devinClose(p: Pane) {
    for (let i = 0; i < 3; i++) {
      if (!devinPickerOpen(await screen(p))) return
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(400)
    }
  }
  async function devinMenu(p: Pane, timeoutMs = 6000) {
    return waitScreen(p, t => parseDevinModelMenu(t), timeoutMs)
  }
  async function devinListModels(p: Pane): Promise<ModelList> {
    return withPane(p.id, async () => {
      const cur = await deps.currentModel(p).catch(() => null)
      await devinClose(p)
      await sendInput(p, '/model')
      const m0 = await devinMenu(p)
      if (!m0) { await devinClose(p); throw new HerdrError('no_menu', 'The /model menu did not show up') }
      let m: DevinModelMenu = m0
      const seen = new Map<string, ModelOption>()
      let parts: ModelPart[] | null = null
      try {
        parts = await devinReadFusionParts(p, m)
        if (parts) m = (await devinMenu(p, 2000)) || m
        // Collect across scrolls until "↓ more below" disappears. The status
        // line prints "<model> <effort>" so a current check also accepts the
        // option's name plus an effort word.
        const isCurrent = (o: { label: string }) => {
          const cl = cur?.label || ''
          if (!cl) return false
          if (sameModel(o.label, cl)) return true
          const rest = cl.startsWith(o.label + ' ') ? cl.slice(o.label.length).trim() : ''
          return /^(?:low|medium|high|xhigh|max)$/i.test(rest)
        }
        for (let pages = 0; pages < 12; pages++) {
          for (const o of m.options) seen.set(o.label, { label: o.label, hint: o.hint, current: isCurrent(o) })
          const text = await screen(p)
          if (!/↓ more below/.test(text)) break
          const cur2: DevinModelMenu = parseDevinModelMenu(text) || m
          if (cur2.cursor < 0) break // unknown cursor: don't guess a position
          const last = cur2.options.length - 1
          await menuKeys(p, moveKeys(cur2.cursor, last), t => parseDevinModelMenu(t) ?? parseDevinFusion(t))
          await sleep(350)
          await menuKeys(p, ['down'], t => parseDevinModelMenu(t) ?? parseDevinFusion(t))
          await sleep(350)
          m = (await devinMenu(p, 2000)) || cur2
        }
      } finally { await devinClose(p) }
      const fusion = parts && seen.get('Fusion')
      if (fusion) fusion.parts = parts!
      const list: ModelList = { agent: 'devin', options: [...seen.values()], at: now() }
      deps.noteList(p, 'devin', list)
      return list
    })
  }

  // Reads Fusion's Lead ▾ and Sidekick ▾ option lists: tab cycles the row's
  // controls; an open dropdown shows its entries with "▸" on the current pick.
  async function devinReadFusionParts(p: Pane, m: DevinModelMenu): Promise<ModelPart[] | null> {
    const idx = m.options.findIndex(o => /^fusion$/i.test(o.label))
    if (idx < 0 || m.cursor < 0) return null
    const keys = moveKeys(m.cursor, idx)
    if (keys.length) await menuKeys(p, keys, t => parseDevinModelMenu(t) ?? parseDevinFusion(t))
    const at = await devinMenu(p, 2000)
    if (!at || at.cursor < 0 || !/^fusion$/i.test(at.options[at.cursor]?.label || '')) return null
    const parts: ModelPart[] = []
    for (const which of ['lead', 'sidekick'] as const) {
      let st = parseDevinFusion(await screen(p))
      for (let t = 0; t < 5 && st?.dropdown?.which !== which; t++) {
        await menuKeys(p, ['tab'], x => parseDevinModelMenu(x) ?? parseDevinFusion(x))
        await sleep(250)
        st = parseDevinFusion(await screen(p))
        if (!st) break
      }
      if (st?.dropdown?.which !== which || !st.dropdown.options.length) break
      parts.push({
        key: which,
        label: which === 'lead' ? 'Lead' : 'Sidekick',
        options: st.dropdown.options.map(o => o.label),
        current: st.dropdown.options[st.dropdown.cursor]?.label || null,
      })
    }
    for (let i = 0; i < 3 && parseDevinFusion(await screen(p))?.dropdown; i++) {
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(300)
    }
    return parts.length ? parts : null
  }

  async function devinOpenMenu(p: Pane): Promise<DevinModelMenu> {
    await devinClose(p)
    await closePanel(p)
    await sendInput(p, '/model')
    const m = await devinMenu(p)
    if (!m) { await devinClose(p); throw new HerdrError('no_menu', 'The /model menu did not show up') }
    return m
  }

  // The picker's own check for menu-internal keys: the full menu parses, an
  // open Lead/Sidekick dropdown is a Fusion state, and a dead search still
  // shows the legend (devinPickerOpen covers all three).
  const devinMenuState = (t: string) => parseDevinModelMenu(t) ?? parseDevinFusion(t)

  // Opens the Fusion row's `which` dropdown by tabbing the row's controls,
  // then moves the "▸" pick to `name` — verified on screen: a name the
  // dropdown does not offer is bad_model, a cursor that does not follow is
  // stale. Returns once the pick is set (dropdown still open).
  async function devinPickFusionPart(p: Pane, which: 'lead' | 'sidekick', name: string) {
    let st: DevinFusionState | null = null
    for (let t = 0; t < 5; t++) {
      st = parseDevinFusion(await screen(p))
      if (st?.dropdown?.which === which) break
      if (!st) throw new HerdrError('stale', 'The /model menu changed — try again.')
      await menuKeys(p, ['tab'], devinMenuState)
      await sleep(250)
    }
    if (st?.dropdown?.which !== which) throw new HerdrError('stale', fmt('Fusion’s {which} picker did not open — try again.', { which }))
    const i = st.dropdown.options.findIndex(o => o.label.toLowerCase() === name.toLowerCase())
    if (i < 0) throw new HerdrError('bad_model', fmt('Fusion {part} not offered: {name}', { part: which, name }))
    if (i !== st.dropdown.cursor) {
      await menuKeys(p, moveKeys(st.dropdown.cursor, i), devinMenuState)
      await sleep(300)
      const at = parseDevinFusion(await screen(p))
      if (at?.dropdown?.which !== which || at.dropdown.cursor !== i) throw new HerdrError('stale', 'The /model menu changed — try again.')
    }
  }

  // Collapses an open Lead/Sidekick dropdown back onto the plain menu
  // ("esc collapse"); the pending pick stays on the row.
  async function devinCollapse(p: Pane) {
    for (let i = 0; i < 3; i++) {
      if (!parseDevinFusion(await screen(p))?.dropdown) return
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(300)
    }
  }

  // Devin's /model picker: search narrows the list, the matching row is
  // reached by cursor keys, and only `alt+enter` confirms — plain Enter
  // writes the GLOBAL default, it is never sent. Verify waits for the menu
  // to close, then accepts the echo ("Model set to … for this session"),
  // the status line, or the transcript; a requested Lead/Sidekick pair is
  // only done when the status line names it.
  async function devinSetModel(p: Pane, wanted: unknown, parts?: unknown): Promise<ModelInfo> {
    const wantedStr = String(wanted || '').trim()
    if (!wantedStr) throw new HerdrError('bad_model', 'Missing model')
    const label = wantedStr.toLowerCase()
    const wantedParts = parts && typeof parts === 'object' && !Array.isArray(parts) ? parts as Record<string, unknown> : {}
    return withPane(p.id, async (p) => {
      const started = now()
      await devinOpenMenu(p)
      try {
        // Narrow with the search field, then alt+↵ on the matching row.
        for (const ch of wantedStr.slice(0, 40)) {
          await menuKeys(p, [ch === ' ' ? 'space' : ch], devinPickerOpen)
          await sleep(60)
        }
        const m = await devinMenu(p, 3000)
        const n = m?.options.findIndex(o => o.label.toLowerCase() === label) ?? -1
        if (!m || n < 0) throw new HerdrError('bad_model', fmt('Model not found in /model: {model}', { model: wantedStr }))
        const target = m.options[n]!.label
        // Never guess the cursor: a missing ❭ makes any move land on a wrong row.
        if (m.cursor < 0) throw new HerdrError('stale', 'The /model menu changed — try again.')
        const keys = moveKeys(m.cursor, n)
        if (keys.length) {
          await menuKeys(p, keys, devinMenuState)
          await sleep(300)
        }
        const selected = await devinMenu(p, 3000)
        if (!selected || selected.cursor < 0 || selected.options[selected.cursor]?.label !== target) {
          throw new HerdrError('stale', 'The /model menu changed — try again.')
        }
        // Composite picks (Fusion's Lead ▾ / Sidekick ▾): choose each
        // requested part in its dropdown, collapse, then confirm the row
        // with the pair on it.
        const picks = (['lead', 'sidekick'] as const)
          .filter(k => typeof wantedParts[k] === 'string' && String(wantedParts[k]).trim())
        if (Object.keys(wantedParts).length && !picks.length) throw new HerdrError('bad_model', 'Unknown model part')
        if (picks.length && !/^fusion$/i.test(target)) throw new HerdrError('bad_model', fmt('Model has no selectable parts: {model}', { model: target }))
        for (const which of picks) await devinPickFusionPart(p, which, String(wantedParts[which]).trim())
        if (picks.length) await devinCollapse(p)
        await menuKeys(p, ['alt+enter'], devinPickerOpen)
        const end = now() + 4000
        let echo: string | null = null
        let shown: string | null = null
        let pair: { lead: string, sidekick: string } | null = null
        const pairOk = () => Boolean(pair) && picks.every(k => sameModel(pair![k === 'lead' ? 'lead' : 'sidekick'], String(wantedParts[k])))
        do {
          const t = await screen(p)
          if (devinPickerOpen(t)) { await sleep(300); continue }
          echo = devinModelSetEcho(t) || echo
          shown = devinStatusModel(t) || shown
          pair = devinStatusPair(t) || pair
          // The status line redraws a beat behind the menu closing — with
          // parts requested, keep polling until it names the pair (or time
          // runs out).
          if (!picks.length || pairOk()) break
          await sleep(300)
        } while (now() < end)
        const tr = await deps.transcript(p).catch(() => null)
        if (!sameModel(echo || '', target) && !sameModel(shown || '', target) && !sameModel(tr?.label || '', target)) {
          throw new HerdrError('stale', echo
            ? fmt('Devin set a different model ({model}) — check the session.', { model: echo })
            : 'The model did not change — try again.')
        }
        // A requested pair is only done when the status line shows it — the
        // row's fields can be truncated, the status line's pair is not.
        if (picks.length && !pairOk()) {
          throw new HerdrError('stale', pair
            ? `Fusion applied ${pair.lead} ◆ ${pair.sidekick} — not the requested pair.`
            : 'Could not verify the Fusion pair — check the session.')
        }
        const info: ModelInfo = { id: target, label: target, effort: null, at: new Date(started).toISOString() }
        deps.noteOverride(p.id, info)
        log(`model ${p.id} (devin) -> ${target}${picks.length ? ` (${picks.map(k => String(wantedParts[k]).trim()).join(' ◆ ')})` : ''} (this session)`)
        return (await deps.currentModel(p).catch(() => null)) || info
      } finally { await devinClose(p) }
    })
  }

  // -------------------------------------------------------------- opencode
  // The service's /api/model catalog: zero terminal IO, busy only.
  // (v2 modelctl.ts:739-760 — the PATCH switch stays out until T6.)
  async function opencodeListModels(p: Pane): Promise<ModelList> {
    return withBusy(p.id, async () => {
      if (!deps.opencodeModels) throw new HerdrError('unavailable', 'The model catalog cannot be read on this pane')
      // An option label must identify one catalog entry: providers can offer
      // the same display name, so duplicates carry their provider.
      const entries = (((await deps.opencodeModels(p)) || []) as OpenCodeEntry[])
        .filter(e => e && e.enabled !== false && typeof e.id === 'string' && typeof e.providerID === 'string')
      const names = new Map<string, number>()
      for (const e of entries) names.set(String(e.name || e.id), (names.get(String(e.name || e.id)) || 0) + 1)
      const cur = await deps.transcript(p).catch(() => null)
      const options: ModelOption[] = entries.map(e => ({
        label: opencodeEntryLabel(e, names.get(String(e.name || e.id))! > 1),
        hint: `${e.providerID}/${e.modelID || e.id}`,
        current: e.id === cur?.id || undefined,
      }))
      const list: ModelList = { agent: 'opencode', options, at: now() }
      deps.noteList(p, 'opencode', list)
      return list
    })
  }

  // The port's first write helper — a session-scoped PATCH through the
  // OpenCode service API, not the terminal. Zero terminal IO → no fresh-read
  // gate, but the busy lock and the pane's READY status still apply: the
  // request names one catalog entry exactly (label / id / providerID/modelID
  // / unique name), the variant keeps the current effort when the same model
  // stays selected else the entry's first, and the PATCH's own re-GET must
  // prove id/providerID/variant — a mismatch is stale, never success.
  async function opencodeSetModel(p: Pane, wanted: unknown, parts?: unknown): Promise<ModelInfo> {
    const wantedStr = String(wanted || '').trim()
    if (!wantedStr) throw new HerdrError('bad_model', 'Missing model')
    const keys = parts && typeof parts === 'object' && !Array.isArray(parts) ? Object.keys(parts) : []
    if (keys.length) throw new HerdrError('bad_model', 'Unknown model part')
    if (!READY.has(p.status || ''))
      throw new HerdrError('busy', p.status === 'blocked'
        ? 'The agent is waiting for an answer — reply first.'
        : 'The agent is working — change the model once it’s done.')
    if (!deps.opencodeModels || !deps.opencodePatchModel)
      throw new HerdrError('unavailable', 'The model catalog cannot be read on this pane')
    return withBusy(p.id, async () => {
      const entries = (((await deps.opencodeModels!(p)) || []) as OpenCodeEntry[])
        .filter(e => e && e.enabled !== false && typeof e.id === 'string' && typeof e.providerID === 'string')
      const names = new Map<string, number>()
      for (const e of entries) names.set(String(e.name || e.id), (names.get(String(e.name || e.id)) || 0) + 1)
      const wantedL = wantedStr.toLowerCase()
      const matches = (e: OpenCodeEntry) => opencodeEntryLabel(e, (names.get(String(e.name || e.id)) || 0) > 1) === wantedStr
        || e.id === wantedStr || `${e.providerID}/${e.modelID || e.id}` === wantedStr
        || (names.get(String(e.name || e.id)) === 1 && String(e.name || '').toLowerCase() === wantedL)
      const hits = entries.filter(matches)
      const e = hits[0]
      if (!e || hits.length > 1) throw new HerdrError('bad_model', fmt('Model not found in /models: {model}', { model: wantedStr }))
      const cur = await deps.transcript(p).catch(() => null)
      const variant = cur?.id === e.id && cur.effort ? cur.effort : (Array.isArray(e.variants) ? String(e.variants[0] || '') : '') || undefined
      const patched = await deps.opencodePatchModel!(p, { id: e.id, providerID: e.providerID, ...(variant ? { variant } : {}) })
      const patchedModel = patched?.model as { id?: string, providerID?: string, variant?: string } | undefined
      if (!patched || patchedModel?.id !== e.id || patchedModel?.providerID !== e.providerID || (variant && patchedModel?.variant !== variant))
        throw new HerdrError('stale', 'The model did not change — try again.')
      const info: ModelInfo = { id: String(patchedModel.id), label: String(e.name || patchedModel.id), effort: patchedModel.variant ?? null, at: new Date(now()).toISOString() }
      deps.refresh?.()
      return info
    })
  }

  // ------------------------------------------------------------------- cmd
  // List-only: `cmd /model <id>` would rewrite the account default.
  async function cmdListModels(p: Pane): Promise<ModelList> {
    return withBusy(p.id, async () => {
      const m = await deps.machine(p)
      const cur = await deps.transcript(p).catch(() => null)
      const r = m.local || !m.exec
        ? await deps.execLocal(CMD_LIST_SCRIPT, m.home || '', 15000)
        : await m.exec('exec sh -s', [], { input: Buffer.from(CMD_LIST_SCRIPT), timeoutMs: 15000 })
      const out = r.stdout.toString('utf8')
      if (r.code !== 0 || !out.trim()) {
        throw new HerdrError('no_cli', r.code === 127 || /not found/i.test(r.stderr)
          ? fmt('The Command Code CLI (cmd) was not found on {machine}', { machine: m.label || 'this machine' })
          : fmt('The model list could not be read (exit {code})', { code: r.code }))
      }
      const options = parseCmdModels(out, cur?.id || null)
      if (!options.length) throw new HerdrError('no_menu', 'The model list came back empty')
      const list: ModelList = { agent: 'cmd', options, at: now() }
      deps.noteList(p, 'cmd', list)
      return list
    })
  }

  async function listModels(paneId: unknown): Promise<ModelList> {
    const p = pane(paneId)
    if (p.agent === 'opencode') return opencodeListModels(p)
    if (p.agent === 'devin') return devinListModels(p)
    if (p.agent === 'omp') return ompListModels(p)
    if (p.agent === 'cmd') return cmdListModels(p)
    return menuList(p)
  }

  return {
    listModels,
    setModel,
    listEfforts,
    setEffort,
    pick,
    modelControlBusy: (paneId: string) => busy.has(paneId),
    // `menuLeftOpen` on the broadcast pane: our menu may still be the screen.
    menuLeftOpen: (paneId: string) => menuMarks.has(paneId),
    // The poll's own read saw the input field again: the mark is done.
    noteRead: (p: Pane, text: string) => {
      if (!menuMarks.has(p.id)) return
      const r = markedRead(p, text)
      if (r.interaction === 'input' && !r.choices) menuMarks.delete(p.id)
    },
    prunePanes: (alive: Set<string>) => { for (const id of menuMarks) if (!alive.has(id)) menuMarks.delete(id) },
  }
}
export type CoreModelCtl = ReturnType<typeof createCoreModelCtl>

// ---------------------------------------------------------------- cmd list
const CMD_LIST_SCRIPT = `C=$(command -v cmd 2>/dev/null) || true
[ -n "$C" ] || C=$(ls -1 "$HOME"/.nvm/versions/node/*/bin/cmd 2>/dev/null | tail -1)
[ -n "$C" ] || C=$(command -v command-code 2>/dev/null) || true
[ -n "$C" ] || C=$(ls -1 "$HOME"/.nvm/versions/node/*/bin/command-code 2>/dev/null | tail -1)
[ -n "$C" ] || C=$(ls -1 "$HOME"/.local/bin/cmd /usr/local/bin/cmd /usr/bin/cmd /opt/homebrew/bin/cmd 2>/dev/null | head -1)
if [ -z "$C" ]; then echo "cmd CLI not found" >&2; exit 127; fi
# The CLI is a node script and the agent machine's non-interactive PATH often
# lacks node: its own bin dir is prepended so the shebang resolves.
exec env PATH="$(dirname "$C"):$PATH" "$C" --list-models`

export function parseCmdModels(text: string, currentId: string | null): ModelOption[] {
  const options: ModelOption[] = []
  for (const raw of String(text || '').split('\n')) {
    if (/^Decision models/i.test(raw)) break
    const m = /^(\S+)\s{2,}(.+?)\s*$/.exec(raw)
    if (!m || !m[1]!.includes('/')) continue
    const id = m[1]!
    const isDefault = /\(default\)\s*$/i.test(m[2]!)
    options.push({ label: id, hint: cleanModelName(m[2]!) || null, current: id === currentId, isDefault })
  }
  return options
}
