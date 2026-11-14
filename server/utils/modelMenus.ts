// /model menus, read from the screen: Claude's and Codex's numbered lists,
// omp's boxed "Switch Model" selector, and Claude's mid-conversation "Switch
// model?" confirmation. Pure parsers — the controller (coreModelctl.ts) only
// ever sends keys while one of these still parses, so a wrong screen can
// never be driven.
import type { ModelOption } from '../../shared/types'
import { keysFor, parseChoices } from './choices'
import { ompSelectorOnScreen } from '../../shared/ompSelector'
import { OMP_CURRENT, OMP_CURSOR, OMP_SEARCH, ompAlt } from '../../shared/ompSymbols'
import { cleanModelName, ompModelLabel, sameModel } from './models'

// ---------------------------------------------------------------- menu /model
export interface ModelMenu {
  kind: 'model' | 'effort'
  options: (ModelOption & { n: number })[]
  cursor: number // number (1…) of the option under the cursor
  scrollDown: boolean // the list continues further down (↓ or "… +N")
  sessionKey: boolean // "s" = this session only
  enterSelects: boolean // Enter = move to the next step (Codex), not save
  effort: string | null // Claude: "◐ Medium effort"
}

const HEADER = /^\s*Select (?:model\b|Model and Effort|Reasoning Level)/i
const OPTION = /^\s*([❯›↑↓])?\s*(\d{1,2})\.\s+(\S.*?)\s*$/
const FOOTER = /Esc to cancel|esc back/i

export function parseModelMenu(text: string | null | undefined): ModelMenu | null {
  if (!text) return null
  const lines = String(text).replace(/\s+$/, '').split('\n').slice(-60)
  let h = -1
  for (let i = lines.length - 1; i >= 0; i--) if (HEADER.test(lines[i]!)) { h = i; break }
  if (h < 0) return null
  const rest = lines.slice(h + 1)
  const footer = rest.find(l => FOOTER.test(l))
  if (!footer) return null // menu closed: the header is just a leftover of history
  const options: ModelMenu['options'] = []
  let cursor = -1
  let scrollDown = false
  let effort: string | null = null
  for (const line of rest) {
    const m = line.match(OPTION)
    if (m) {
      const [labelPart, ...hint] = m[3]!.split(/\s{2,}/)
      const n = Number(m[2])
      if (m[1] === '❯' || m[1] === '›') cursor = n
      if (m[1] === '↓') scrollDown = true
      options.push({
        n,
        label: cleanModelName(labelPart!),
        hint: hint.join(' ').trim() || null,
        current: /✔|\(current\)/i.test(labelPart!),
        isDefault: /\(default\)/i.test(labelPart!),
      })
      continue
    }
    if (options.length && /^\s*…\s*\+\d+/.test(line)) scrollDown = true
    const e = line.match(/^\s*\S?\s*(\w[\w ]*?) effort\b/i)
    if (e && options.length) effort = e[1]!.toLowerCase()
  }
  if (!options.length || cursor < 0) return null
  // A real list: consecutive numbers.
  for (let i = 1; i < options.length; i++) if (options[i]!.n !== options[i - 1]!.n + 1) return null
  return {
    kind: /Reasoning Level/i.test(lines[h]!) ? 'effort' : 'model',
    options,
    cursor,
    scrollDown,
    sessionKey: /s to use this session only|\bs session\b/i.test(rest.join('\n')),
    enterSelects: /enter select/i.test(footer),
    effort,
  }
}

// ---------------------------------------------------------------- omp selector
// omp's "Switch Model" selector (alt+p, /switch, /model): a boxed list of
// provider/model ids with a search field, parsed from the plain screen.
// Task-model variant ("Switch Task Model"): Enter applies to Task subagents,
// not to the session. "omp/models" panel (typed `/model`): the providers'
// picker, its Enter reads "⏎/→ models" — read-only, entries chosen there go
// through the same session dialog afterwards.
export interface OmpSelector {
  options: ModelOption[] // "provider/model" ids; hint carries ⦸ warnings
  cursor: number // index in options
  search: string // text typed in the search field
  separator: number | null // rank of a "────" row (the matched block separator)
  task: boolean // "Switch Task Model": Enter applies to Task subagents
  // A narrow pane makes omp cut the ids ("anthropic/cla…"): the options
  // are then unreliable (and the list may miss rows).
  truncated: boolean
  width: number // columns of the box (the whole pane width once truncated)
}

// Box: rounded with the unicode and nerd presets, "+-" / "|" with ascii.
const OMP_FRAME_TOP = /^(?:╭─|\+-)\s*Switch (?:Task )?Model\b/
const OMP_FRAME_BOTTOM = /^(?:╰|\+-)/
// Row: left border, content, right border; a scrollbar column adds a second
// one ("…$4/20│ │").
const OMP_ROW = /^[│|](.*?)[│|](?:\s*[│|])?\s*$/
const OMP_MODEL = /^(?:[a-z0-9][\w.-]*(?:\/[\w.-]+)+)/
const OMP_OVERCTX = /⦸\s*(context>[^\s]+|context \d+[kKmM]?[^\s]*|[^\s].{0,60})$/
const OMP_SEARCH_RE = new RegExp(`^${ompAlt(OMP_SEARCH)}\\s*>\\s*(.*)$`)
const OMP_CURSOR_RE = new RegExp(`^${ompAlt(OMP_CURSOR)}\\s*`)
const OMP_CURRENT_RE = new RegExp(`${ompAlt(OMP_CURRENT)}\\s*$`)
// An id cut by omp: "anthropic/cla…", or the provider itself ("anthr…").
const OMP_CUT = /^[\w.\-/]+…/
const OMP_CURRENT_START = new RegExp(`^${ompAlt(OMP_CURRENT)}`)
const OMP_CURRENT_ALL = new RegExp(ompAlt(OMP_CURRENT), 'g')

export function parseOmpSelector(text: string | null | undefined): OmpSelector | null {
  if (!ompSelectorOnScreen(text)) return null
  const lines = String(text).replace(/\s+$/, '').split('\n')
  let top = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (OMP_FRAME_TOP.test(lines[i]!)) { top = i; break }
  }
  if (top < 0) return null
  const body: string[] = []
  for (const line of lines.slice(top + 1)) {
    if (OMP_FRAME_BOTTOM.test(line)) break
    const m = line.match(OMP_ROW)
    if (!m) return null // not the bottom of the box: history above it
    body.push(m[1]!.replace(/\s+$/, ''))
  }
  const task = /Switch Task Model/.test(lines[top]!)
  const options: ModelOption[] = []
  let cursor = 0
  let search = ''
  let separator: number | null = null
  let truncated = false
  for (const row of body) {
    const raw = row.trim()
    const q = raw.match(OMP_SEARCH_RE)
    if (q) { search = q[1]!.trim(); continue }
    // A model row: the dim perf/context/cost columns sit far right, after
    // 3+ spaces from the id and its marks — everything from there is noise.
    const cut = raw.search(/\s{3,}/)
    const t = (cut < 0 ? raw : raw.slice(0, cut)).trim()
    const cur = OMP_CURSOR_RE.exec(t)
    const model = (cur ? t.slice(cur[0].length) : t).trim()
    if (OMP_CUT.test(model)) truncated = true
    if (cur) {
      const hit = model.match(OMP_MODEL)
      if (hit) {
        cursor = options.length
        const warn = model.slice(hit[0].length).trim().match(OMP_OVERCTX)
        options.push({ label: hit[0], hint: warn ? warn[1]!.trim() : null, current: OMP_CURRENT_RE.test(model) })
        continue
      }
    }
    if (OMP_MODEL.test(t)) {
      const hit = t.match(OMP_MODEL)!
      const warn = t.slice(hit[0].length).trim().match(OMP_OVERCTX)
      options.push({ label: hit[0], hint: warn ? warn[1]!.trim() : null })
      continue
    }
    if (/^─{3,}/.test(t) && options.length) separator = options.length
  }
  return { options, cursor, search, separator, task, truncated, width: [...lines[top]!.trimEnd()].length }
}

// Caption of the model under the cursor: "Claude Opus 5.5 · 200k ctx · …" —
// the readable name omp itself gives, and the roles line below ("● current ·
// ● default ◕ …"). The caption is found from the id: the derived label, then
// the id's last segment (omp sometimes writes it differently, "GLM 5.3
// Flash"). null: no caption on screen (list scrolled, short box).
export function ompSelectorCaption(text: string | null | undefined, id: string): { name: string, roles: string[] } | null {
  if (!text || !id) return null
  const lines = String(text).replace(/\s+$/, '').split('\n')
  const name = id.split('/').filter(Boolean).pop()!
  const candidates = [ompModelLabel(id), name.startsWith('claude-') ? `Claude ${ompModelLabel(id)}` : '', name]
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!/^[│|]\s*\S/.test(line)) continue
    const body = line.replace(/^[│|]\s*/, '')
    const hit = candidates.find(c => body.toLowerCase().startsWith(`${c.toLowerCase()} ·`))
    if (!hit) continue
    const roles: string[] = []
    for (let k = i + 1; k < Math.min(i + 3, lines.length); k++) {
      const r = lines[k]!.replace(/^[│|]\s*/, '').replace(/\s*[│|][\s│|]*$/, '').trim()
      if (!OMP_CURRENT_START.test(r)) break
      roles.push(...r.split('·').map(s => s.replace(OMP_CURRENT_ALL, '').replace(/\s*(?:[◕◒◍○]|\[)[\s\S]*$/, '').trim()).filter(Boolean))
    }
    return { name: body.split('·')[0]!.trim(), roles }
  }
  return null
}

// Claude, in the middle of a conversation: after "s", it asks for confirmation
// ("Switch model? … ❯ 1. Yes, switch to Sonnet 4.6 / 2. No, go back") because the
// conversation cache will be re-read. Keys to answer "yes" to this
// specific question, for that model; null otherwise. (Enter here confirms the
// change for the session, without saving it as the default.)
export function switchConfirmKeys(text: string | null | undefined, label: string): string[] | null {
  if (!text || !/^\s*Switch model\?\s*$/m.test(text)) return null
  const c = parseChoices(text, { strict: true })
  if (!c) return null
  const i = c.options.findIndex((o) => {
    const m = o.label.match(/^Yes, switch to (.+)$/)
    return Boolean(m && sameModel(m[1], label))
  })
  return i < 0 ? null : keysFor(c, i)
}

// A "Switch model?" that names a different model than the one just picked is
// declined ("No, go back"), gated the same way — the picker's own move raised
// that dialog, so leaving it unanswered would strand the agent on it.
export function switchDeclineKeys(text: string | null | undefined): string[] | null {
  if (!text || !/^\s*Switch model\?\s*$/m.test(text)) return null
  const c = parseChoices(text, { strict: true })
  if (!c) return null
  const i = c.options.findIndex(o => /^(?:no|cancel|back)\b/i.test(o.label))
  return i < 0 ? null : keysFor(c, i)
}

// Claude's input field in bash mode (a "!" typed first): "!" prompt right
// under the (pink) rule. Not a panel or a menu: Escape there would throw
// away what the field holds.
const bashInput = (line: string, above: string | undefined) => /^!(\s|$)/.test(line) && /^\s*─{3,}/.test(above || '')

// A full-screen panel covers the composer (claude/codex only — other agents
// have no panel recognizer): the last lines show no "❯" input and no bash
// field, so an esc is a safe dismissal before typing. v2:choices.ts:855.
export function panelOpen(text: string | null | undefined, agent: string | null | undefined): boolean {
  if (agent !== 'claude' && agent !== 'codex') return false
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-12)
  return !lines.some((l, i) => /^\s*[❯›](\s|$)/.test(l) || bashInput(l, lines[i - 1]))
}
