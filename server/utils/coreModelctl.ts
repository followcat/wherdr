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
import { sleep as defaultSleep } from './herdr'
import { cleanModelName, sameModel } from './models'
import { parseModelMenu, parseOmpSelector, type ModelMenu } from './modelMenus'
import { devinMenuOpen, parseDevinModelMenu, parseDevinFusion, type DevinModelMenu } from './devinMenu'
import { ompSelectorOnScreen } from '../../shared/ompSelector'
import { fmt } from '../../shared/message'
import type { Machine } from './machines'
import type { ExecResult } from './fsx'
import type { ModelInfo, ModelList, ModelOption, ModelPart, Pane } from '../../shared/types'

// Agents whose picker a pane may drive. `cmd` is list-only (its /model rewrites
// the account default — docs/security.md) but listing needs the same gate.
export const SWITCH_AGENTS = new Set(['claude', 'codex', 'omp', 'devin', 'opencode', 'cmd'])
const READY = new Set(['done', 'idle'])

// One /api/model catalog entry (the fields wherdr reads).
type OpenCodeEntry = { id: string, providerID: string, name?: string, modelID?: string, enabled?: boolean, variants?: string[] }

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
  noteList: (p: Pane, agent: string, list: ModelList) => void // modelCtl().noteList
  refresh?: () => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function createCoreModelCtl(deps: CoreModelCtlDeps) {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const busy = new Set<string>()

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
  async function gate(p: Pane) {
    const r = readCoreScreen(await screen(p), p.agent, p.status)
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
    try { await gate(p); return await fn(p) } finally { busy.delete(p.id); deps.refresh?.() }
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

  // -------------------------------------------------------- claude/codex menu
  const modelMenu = (p: Pane) => waitScreen(p, t => parseModelMenu(t)?.kind === 'model' ? parseModelMenu(t) : null, 6000)
  async function openMenu(p: Pane): Promise<ModelMenu> {
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

  // All options: Claude only shows 10 (↑/↓ before the number), we go back to
  // the top then down page by page (the list wraps to the top after the last
  // one). "current" is not kept: the list is shared by all agents of the kind.
  async function readAllOptions(p: Pane, first: ModelMenu): Promise<ModelOption[]> {
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
    return [...all.values()].sort((a, b) => a.n - b.n).map(o => ({ label: o.label, hint: o.hint, isDefault: Boolean(o.isDefault) }))
  }

  // Cursor onto `label` — verified on screen. The menu is left open.
  async function pick(p: Pane, m: ModelMenu, label: string) {
    const o = m.options.find(o => o.label === label || o.hint === label)
    if (!o) throw new HerdrError('bad_model', fmt('Model not offered: {name}', { name: label }))
    if (o.n !== m.cursor) {
      await menuKeys(p, moveKeys(m.cursor, o.n), t => parseModelMenu(t)?.kind === 'model' ? parseModelMenu(t) : null)
      const at = await waitScreen(p, t => { const x = parseModelMenu(t); return x?.kind === 'model' ? x : null }, 3000)
      if (!at || at.cursor !== o.n) throw new HerdrError('stale', 'The /model menu changed — try again.')
    }
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

  // ------------------------------------------------------------------- omp
  const ompSel = (text: string) => { const s = parseOmpSelector(text); return s && !s.task ? s : null }
  async function ompListModels(p: Pane): Promise<ModelList> {
    return withPane(p.id, async () => {
      await sendKeys(p, ['alt+p'])
      const s = await waitScreen(p, ompSel, 4000)
      if (!s) { await ompClose(p); throw new HerdrError('no_menu', 'The model selector did not show up') }
      if (s.truncated) { await ompClose(p); throw new HerdrError('narrow', 'The selector is too narrow to read model ids — widen the pane.') }
      try {
        const options: ModelOption[] = s.options.map(o => ({ label: o.label, hint: o.hint, current: o.current }))
        const list: ModelList = { agent: 'omp', options, at: now() }
        deps.noteList(p, 'omp', list)
        return list
      } finally { await ompClose(p) }
    })
  }
  async function ompClose(p: Pane) {
    for (let i = 0; i < 4; i++) {
      if (!ompSelectorOnScreen(await screen(p))) return
      await deps.call('terminal.keys', { terminal: p.coreAddress, keys: ['esc'] }, 10000)
      await sleep(400)
    }
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
        label: names.get(String(e.name || e.id))! > 1 ? `${e.name || e.id} (${e.providerID})` : String(e.name || e.id),
        hint: `${e.providerID}/${e.modelID || e.id}`,
        current: e.id === cur?.id || undefined,
      }))
      const list: ModelList = { agent: 'opencode', options, at: now() }
      deps.noteList(p, 'opencode', list)
      return list
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
    pick,
    modelControlBusy: (paneId: string) => busy.has(paneId),
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
