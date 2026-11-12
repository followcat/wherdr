// Agent models: read from transcripts (Claude: `message.model`
// of replies and local "Set model to …" output of /model; Codex:
// `turn_context`), readable labels, and the model shown on screen (Claude's
// header, Codex's status line, omp's status line). "omp/provider/model" →
// readable label "Model" (ompModelLabel), never Claude's.
import type { ModelInfo } from '../../shared/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

// claude-opus-5-5 → "Opus 5.5", claude-haiku-4-5-20251001 → "Haiku 4.5",
// claude-3-5-sonnet-20241022 → "Sonnet 3.5", claude-fable-5-1[1m] → "Fable 5.1 (1M)".
export function claudeModelLabel(id: string): string {
  const m = String(id || '').trim()
  const oneM = /\[1m\]$/i.test(m)
  const parts = m.replace(/\[[^\]]*\]$/, '').replace(/^claude-/i, '').split('-').filter(Boolean)
  const words = parts.filter(x => !/^\d+$/.test(x))
  const nums = parts.filter(x => /^\d{1,2}$/.test(x)) // dates (20251001) are ignored
  if (!words.length) return m
  const label = `${words.map(cap).join(' ')}${nums.length ? ' ' + nums.join('.') : ''}`
  return oneM ? `${label} (1M)` : label
}

// gpt-6-sol → "GPT-6-Sol", gpt-5.6-terra → "GPT-5.6-Terra", o3 → "o3".
export function codexModelLabel(id: string): string {
  const m = String(id || '').trim()
  if (!/^gpt-/i.test(m)) return m
  return m.split('-').map((x, i) => (i === 0 ? 'GPT' : cap(x))).join('-')
}

// omp id ("provider/model", sometimes "provider/vendor/model") → readable
// label: Claude's own naming for "claude-*" ids ("Opus 5.5"), otherwise
// family from the letters before the first digit then the version
// ("openrouter/z-ai/glm-5.3-flash" → "Glm 5.3 flash", "web/exa" → "exa").
export function ompModelLabel(id: string): string {
  const parts = String(id || '').trim().split('/').filter(Boolean)
  if (!parts.length) return String(id || '')
  const name = parts[parts.length - 1]!
  if (/^claude-/i.test(name)) return claudeModelLabel(name)
  const at = name.search(/\d/)
  if (at <= 0) return name
  const family = cap(name.slice(0, at).replace(/[-_]+$/, '').replace(/-/g, ' '))
  const ver = name.slice(at).replace(/[-_]+/g, ' ').trim()
  return ver ? `${family} ${ver}` : family
}

// Label from a /model menu or output: "Opus 5 (1M context) (default)" → "Opus 5 (1M)".
export function cleanModelName(s: string): string {
  return String(s || '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/✔/g, '')
    .replace(/\s*\((?:default|current)\)/gi, '')
    .replace(/\(1M context\)/i, '(1M)')
    .replace(/\s+/g, ' ')
    .trim()
}

// Same model? ("Opus 5.5" = "opus 5.5 (1M)"; parentheses are variants.)
export const sameModel = (a: string | null | undefined, b: string | null | undefined) => {
  const k = (s: string | null | undefined) => cleanModelName(s || '').replace(/\s*\(.*?\)/g, '').toLowerCase()
  return Boolean(a && b) && k(a) === k(b)
}

// Local /model output: "Set model to `Sonnet 5` for this session only",
// "Set model to `Opus 5 (1M context) (default)` and saved as…", "Kept model as `Opus 5.5`".
const SET_RE = /(?:Set model to|Kept model as)\s+`([^`]+)`/

// omp transcript (~/.omp/agent/sessions/…jsonl): the model in effect comes
// from "model_change" entries ("role": "temporary" = session-only switch,
// "default" = the picker's role choice), else the "model" of the last
// assistant message (with provider, without thinking level). The thinking
// level comes from "thinking_level_change" entries, written on every change
// (⇧⇥ cycle, model switch): "configured" is the level chosen ("auto",
// "off", "high"…), "thinkingLevel" the one in effect ("auto" resolves it per
// turn). A model line leaves `effort` undefined: it says nothing about it.
export function ompModelFromLine(line: string): ModelInfo | null {
  if (!line.includes('"model"') && !line.includes('"thinkingLevel"')) return null
  let d: Json
  try { d = JSON.parse(line) }
  catch { return null }
  if (d.type === 'model_change' && typeof d.model === 'string' && d.model) {
    return { id: d.model, label: ompModelLabel(d.model), at: d.timestamp || null }
  }
  if (d.type === 'thinking_level_change') {
    const level = typeof d.configured === 'string' && d.configured ? d.configured
      : typeof d.thinkingLevel === 'string' && d.thinkingLevel ? d.thinkingLevel : null
    const resolved = level === 'auto' && typeof d.thinkingLevel === 'string' && d.thinkingLevel !== 'auto' ? d.thinkingLevel : null
    return { id: null, label: '', effort: level, ...(resolved ? { effortResolved: resolved } : {}), at: d.timestamp || null }
  }
  if (d.type === 'message' && d.message && d.message.role === 'assistant') {
    const id = d.message.model
    if (typeof id !== 'string' || !id) return null
    return { id, label: ompModelLabel(id), at: d.timestamp || null }
  }
  return null
}

// omp: model and thinking level, merged field by field — the newer one wins
// for each; `at` is the most recent of both. Partial values: `label` '' = no
// model seen yet, `effort` undefined = no level seen yet.
export function mergeOmpModel(newer: ModelInfo | null, older: ModelInfo | null): ModelInfo | null {
  if (!newer || !older) return newer || older
  const model = newer.label ? newer : older
  const level = newer.effort !== undefined ? newer : older
  const [a, b] = [newer.at || null, older.at || null]
  return {
    id: model.id,
    label: model.label,
    effort: level.effort,
    ...(level.effortResolved ? { effortResolved: level.effortResolved } : {}),
    at: !a || (b && b > a) ? b : a,
  }
}

export const ompModelComplete = (m: ModelInfo | null) => Boolean(m && m.label && m.effort !== undefined)

// Latest model and latest thinking level of a block of omp lines (partial).
export function ompLastModel(lines: string[]): ModelInfo | null {
  let acc: ModelInfo | null = null
  for (let i = lines.length - 1; i >= 0 && !ompModelComplete(acc); i--) {
    acc = mergeOmpModel(acc, ompModelFromLine(lines[i]!))
  }
  return acc
}

// Partial omp info → what callers get: no model = nothing, no level = null.
export const ompModelResult = (m: ModelInfo | null): ModelInfo | null => (m && m.label ? { ...m, effort: m.effort ?? null } : null)

// Model carried by a transcript line (null if it says nothing about it).
export function modelFromLine(line: string, kind: string | null): ModelInfo | null {
  if (!line) return null
  if (kind === 'omp') return ompModelFromLine(line)
  if (kind === 'cmd') {
    // Command Code: "model_change" records, else the model stamped on the
    // latest assistant message. Malformed entries say nothing; the most
    // recent valid one wins (see lastModel).
    if (!line.includes('"model"')) return null
    let cd: Json
    try { cd = JSON.parse(line) }
    catch { return null }
    const cid = cd?.type === 'model_change' ? cd.model
      : cd?.type === 'message' && cd.message?.role === 'assistant' ? cd.model : null
    return typeof cid === 'string' && cid.trim()
      ? { id: cid, label: cleanModelName(cid), at: typeof cd.timestamp === 'string' ? cd.timestamp : null } : null
  }
  if (kind === 'codex') {
    if (!line.includes('"turn_context"')) return null
    let d: Json
    try { d = JSON.parse(line) }
    catch { return null }
    if (d.type !== 'turn_context' || !d.payload || !d.payload.model) return null
    const p = d.payload
    const effort = p.effort || (p.collaboration_mode && p.collaboration_mode.settings && p.collaboration_mode.settings.reasoning_effort) || null
    return { id: String(p.model), label: codexModelLabel(String(p.model)), effort, at: d.timestamp || null }
  }
  const setHit = line.includes('Set model to') || line.includes('Kept model as')
  if (!setHit && !line.includes('"model"')) return null
  let d: Json
  try { d = JSON.parse(line) }
  catch { return null }
  if (d.isSidechain) return null
  if (d.type === 'assistant' && d.message && typeof d.message.model === 'string') {
    const id = d.message.model
    if (!id || id.startsWith('<')) return null // "<synthetic>": error, interruption
    return { id, label: claudeModelLabel(id), effort: typeof d.effort === 'string' ? d.effort : null, at: d.timestamp || null }
  }
  if (setHit && (d.type === 'user' || d.type === 'system')) {
    const c = d.type === 'user' ? d.message && d.message.content : d.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: Json) => (x && x.text) || '').join('\n') : ''
    const m = text.match(SET_RE)
    if (!m || !text.includes('local-command-stdout')) return null
    const label = cleanModelName(m[1]!)
    return label ? { id: null, label, at: d.timestamp || null } : null
  }
  return null
}

// Last known model of a block of lines (the most recent wins).
export function lastModel(lines: string[], kind: string | null): ModelInfo | null {
  if (kind === 'omp') return ompModelResult(ompLastModel(lines))
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = modelFromLine(lines[i]!, kind)
    if (r) return r
  }
  return null
}

// Codex: default model and effort (~/.codex/config.toml, top-level keys).
export function codexConfigModel(toml: string): ModelInfo | null {
  const top = String(toml || '').split(/^\s*\[/m)[0]!
  const m = top.match(/^\s*model\s*=\s*"([^"]+)"/m)
  if (!m) return null
  const e = top.match(/^\s*model_reasoning_effort\s*=\s*"([^"]+)"/m)
  return { id: m[1]!, label: codexModelLabel(m[1]!), effort: e ? e[1]! : null, at: null }
}

// Codex: current effort ("medium", "xhigh") → menu option ("Medium (default)", "Extra high").
export function effortMatches(option: string, effort: string | null | undefined): boolean {
  if (!effort) return false
  const o = cleanModelName(option).toLowerCase().replace(/\s+/g, '')
  const e = String(effort).toLowerCase().replace(/[\s_-]+/g, '')
  return o === e || (e === 'xhigh' && o === 'extrahigh')
}

export function effortValue(label: string): string | null {
  const value = cleanModelName(label).toLowerCase().replace(/\s+/g, '')
  return value === 'extrahigh' ? 'xhigh' : /^(low|medium|high|xhigh|max|ultra|ultracode|minimal)$/.test(value) ? value : null
}

export function codexCachedEfforts(json: string, model: string): string[] {
  try {
    const data = JSON.parse(json)
    const entry = data.models?.find((m: { slug?: string, display_name?: string }) =>
      sameModel(m.slug, model) || sameModel(m.display_name, model))
    return Array.isArray(entry?.supported_reasoning_levels)
      ? entry.supported_reasoning_levels.map((x: { effort?: string }) => x.effort).filter((x: string) => Boolean(effortValue(x)))
      : []
  } catch { return [] }
}

// Claude exposes the extended levels on the most powerful reasoning models.
export function claudeEffortLevels(model: string | null | undefined): string[] {
  if (!model) return []
  const name = cleanModelName(model).replace(/\s*\([^)]*\)/g, '').toLowerCase()
  if (/^(?:opus|sonnet) 4\.6$/.test(name)) return ['low', 'medium', 'high', 'max']
  if (name === 'opus 5.5') return ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']
  if (/^(?:fable (?:5|5\.1)|opus (?:4\.7|4\.8|5|5\.5)|sonnet 5)$/.test(name)) return ['low', 'medium', 'high', 'xhigh', 'max']
  return []
}

export function claudeEffortCommand(level: string, model: string | null | undefined): string | null {
  // `/effort <level>` writes the user default; the slider without an argument
  // lets us choose the level then confirm with `s` for this session.
  // The real levels (including "ultracode") are checked on the displayed slider.
  const levels = claudeEffortLevels(model)
  if (!levels.length || effortValue(level) !== level) return null
  return levels.includes(level) || (level === 'ultracode' && levels.includes('xhigh')) ? '/effort' : null
}

export interface ClaudeEffortSlider {
  current: string
  levels: string[] // levels shown by Claude, in arrow order
}

// Slider legend: old ("s to use this session only") or 2.1.283
// ("←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel").
const SLIDER_SESSION = /s (?:to use|for) this session only/i

// Claude Code's /effort slider, read at the bottom of the screen; null if it is not open.
// 2.1.283: "───▲───┊───" ruler above the "low  medium … max  ultracode" labels;
// the current level is the label closest to the ▲ column.
export function parseClaudeEffortScreen(text: string | null | undefined): ClaudeEffortSlider | null {
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-30)
  let legend = -1
  for (let i = lines.length - 1; i >= 0; i--) if (SLIDER_SESSION.test(lines[i]!)) { legend = i; break }
  if (legend < 0) return null
  const body = lines.slice(0, legend)
  for (let r = body.length - 1; r >= 0; r--) {
    const ruler = Array.from(body[r]!)
    const mark = ruler.indexOf('▲')
    if (mark < 0 || !ruler.some(c => c === '─')) continue
    // Label line: the first one below the ruler that contains any.
    for (let k = r + 1; k < body.length; k++) {
      const chars = Array.from(body[k]!)
      const words: { value: string, from: number, to: number }[] = []
      const re = /\S+/g
      const str = chars.join('')
      let m: RegExpExecArray | null
      while ((m = re.exec(str))) {
        const value = effortValue(m[0])
        const from = Array.from(str.slice(0, m.index)).length
        if (value) words.push({ value, from, to: from + Array.from(m[0]).length - 1 })
      }
      if (words.length < 2) continue
      const dist = (w: typeof words[number]) => mark < w.from ? w.from - mark : mark > w.to ? mark - w.to : 0
      const best = words.reduce((a, b) => (dist(b) < dist(a) ? b : a))
      return { current: best.value, levels: words.map(w => w.value) }
    }
    return null
  }
  // Old screen: "◐ Medium effort (default) ←/→ to adjust".
  const m = body.join('\n').match(/[●◐○◑◒◓]\s*(Low|Medium|High|Extra high|xhigh|Max) effort/i)
  const current = m ? effortValue(m[1]!) : null
  return current ? { current, levels: [] } : null
}

export function parseClaudeEffortSlider(text: string | null | undefined): string | null {
  return parseClaudeEffortScreen(text)?.current || null
}

// Claude's current effort announced on screen: banner ("Opus 5.5 with low effort")
// or /effort output ("Set effort level to low (for this session only)"); the lowest wins.
export function claudeScreenEffort(text: string | null | undefined): string | null {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/\bwith (low|medium|high|xhigh|max|ultracode) effort\b|Set effort level to (low|medium|high|xhigh|max|ultracode)\b/i)
    if (m) return (m[1] || m[2])!.toLowerCase()
  }
  return null
}

// Claude: model announced on screen, for an agent that has no
// transcript yet. Claude Code header ("Opus 5.5 with low effort · Claude
// Pro", "Sonnet 5 (1M context) · Claude Max") or output of a typed /model
// ("Set model to Sonnet 5"). The lowest wins.
const HEADER_RE = /([A-Z][A-Za-z]+ \d+(?:\.\d+)*(?: \([^)]*\))?)(?: with (low|medium|high|xhigh|max|ultracode) effort)? · (?:Claude\b|API\b)/
const SET_SCREEN_RE = /(?:Set model to|Kept model as) `?([^`\n]+?)`?(?= for this session| and saved|\s*$)/
export function claudeScreenModel(text: string | null | undefined): ModelInfo | null {
  const lines = String(text || '').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!.replace(/\s+$/, '')
    const s = SET_SCREEN_RE.exec(l)
    if (s) {
      const label = cleanModelName(s[1]!)
      if (label) return { id: null, label, effort: null, at: null }
    }
    const h = HEADER_RE.exec(l)
    if (h) return { id: null, label: cleanModelName(h[1]!), effort: h[2] ? h[2].toLowerCase() : null, at: null }
  }
  return null
}

// Idle Codex: its status line below the input field gives the model and
// effort actually in effect ("GPT-5.6-Terra medium · ~ · …"), including
// after a /model typed elsewhere, which the rollout only records on the next turn.
export function codexFooterModel(text: string | null | undefined): ModelInfo | null {
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-6)
  const input = lines.findIndex(l => /^\s*›\s/.test(l))
  if (input < 0) return null
  for (const l of lines.slice(input + 1)) {
    const m = l.match(/^\s*((?:GPT|gpt)-[\w.-]+|o\d[\w.-]*)(?:\s+(minimal|low|medium|high|xhigh|max|ultra))?\s+·/)
    if (m) return { id: null, label: m[1]!.startsWith('gpt') ? codexModelLabel(m[1]!) : m[1]!, effort: m[2] || null, at: null }
  }
  return null
}

// ---------------------------------------------------------------- omp thinking level
// omp changes its thinking level with ⇧⇥ only (no slash command): one press
// moves to the next level of the cycle off → auto → the model's own levels
// (catalog order) → off, for this session only (never saved as a default).
export const OMP_EFFORT_ORDER = ['off', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
// Offered until a ⇧⇥ cycle has shown the model's real levels: the set of
// current reasoning models (Claude 4.7+, GPT-5.6+).
const OMP_DEFAULT_LEVELS: Record<string, true> = { off: true, auto: true, low: true, medium: true, high: true, xhigh: true, max: true }

// What the presses showed about one model's cycle: levels seen, and levels
// proven absent (skipped between two consecutive presses).
export interface OmpCycleKnowledge { seen: string[], absent: string[] }

export function learnOmpCycle(known: OmpCycleKnowledge | null, presses: string[]): OmpCycleKnowledge {
  const seen = new Set(known ? known.seen : [])
  const absent = new Set(known ? known.absent : [])
  const n = OMP_EFFORT_ORDER.length
  for (let k = 0; k < presses.length; k++) {
    const level = presses[k]!
    seen.add(level)
    absent.delete(level)
    if (k === 0) continue
    const from = OMP_EFFORT_ORDER.indexOf(presses[k - 1]!)
    const to = OMP_EFFORT_ORDER.indexOf(level)
    if (from < 0 || to < 0) continue
    for (let j = (from + 1) % n; j !== to; j = (j + 1) % n) {
      if (!seen.has(OMP_EFFORT_ORDER[j]!)) absent.add(OMP_EFFORT_ORDER[j]!)
    }
  }
  return { seen: [...seen], absent: [...absent] }
}

export function ompEffortLevels(known: OmpCycleKnowledge | null): string[] {
  return OMP_EFFORT_ORDER.filter(l => known?.seen.includes(l) || (!known?.absent.includes(l) && OMP_DEFAULT_LEVELS[l]))
}

// Status line glyphs of the three symbol presets (unicode, nerd font, ascii).
const OMP_EFFORT_GLYPHS: Record<string, string> = {
  '○': 'minimal', '◔': 'low', '◑': 'medium', '◒': 'high', '◕': 'xhigh', '◉': 'max', '⟳': 'auto', '⦸': 'off',
  '\u{F0A9E}': 'minimal', '\u{F0A9F}': 'low', '\u{F0AA1}': 'medium', '\u{F0AA3}': 'high', '\u{F0AA5}': 'xhigh', '\uF06D': 'max', '\uF074': 'auto', '\uF05E': 'off',
  '[min]': 'minimal', '[low]': 'low', '[med]': 'medium', '[high]': 'high', '[xhi]': 'xhigh', '[max]': 'max', '[~]': 'auto',
}
const OMP_EFFORT_WORDS: Record<string, string> = {
  off: 'off', auto: 'auto', min: 'minimal', minimal: 'minimal', low: 'low', med: 'medium', medium: 'medium',
  high: 'high', xhi: 'xhigh', xhigh: 'xhigh', max: 'max',
}

// omp's thinking level on its status line, next to the model name: the top
// border of the input box (" π > ◔ Opus 5.5 > 🗑 repo > … ───") or, in older
// layouts, the line under it (" ◒ Opus 5.5 👁 · 📁 ~/repo"). One glyph before
// the name (compact display, the default), or a " · ◔ low" suffix after it.
// Until its first turn "auto" shows ⟳, then the level it resolved to — the
// transcript, when there is one, keeps "auto". The name anchors the reading:
// the conversation above may hold the same glyphs. null: not on screen, or
// no thinking level.
export function ompScreenEffort(text: string | null | undefined, model: string | null | undefined): string | null {
  const name = cleanModelName(model || '').replace(/\s*\(.*?\)/g, '').toLowerCase()
  if (!name) return null
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-12)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    // Boxed rows (selectors, dialogs) are not the status line.
    if (/^\s*│/.test(line)) continue
    const at = line.toLowerCase().indexOf(name)
    if (at < 0) continue
    const glyph = OMP_EFFORT_GLYPHS[line.slice(0, at).trimEnd().split(/\s+/).pop() || '']
    if (glyph) return glyph
    const suffix = line.slice(at + name.length).match(/^[^·>]*·\s*(?:\S+\s+){0,2}?\[?(off|auto|min|minimal|low|med|medium|high|xhi|xhigh|max)\]?(?=\s|$)/)
    if (suffix) return OMP_EFFORT_WORDS[suffix[1]!]!
  }
  return null
}

// omp's model and thinking level from its status line alone, for a
// conversation with no transcript yet (omp only writes its session file on
// the first message). The level glyph sits among the first segments
// (" π > ⟳ Opus 5.5 > 🗑 ~/demo > ─…", nerd-font separators alike: the glyph
// right after a segment separator), or opens the older layout's line
// (" ◒ Opus 5.5 👁 · 📁 ~/repo", with its " · " segments). The name runs until
// the next segment without letters or digits (separator, icon). A glyph in
// the conversation above has neither. The model's id is unknown.
export function ompScreenModel(text: string | null | undefined): ModelInfo | null {
  const lines = String(text || '').replace(/\s+$/, '').split('\n').slice(-12)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (/^\s*│/.test(line)) continue
    const tokens = line.trim().split(/\s+/)
    for (let k = 0; k < Math.min(tokens.length, 5); k++) {
      const effort = OMP_EFFORT_GLYPHS[tokens[k]!]
      if (!effort) continue
      const name: string[] = []
      let j = k + 1
      for (; j < tokens.length && /[\p{L}\p{N}]/u.test(tokens[j]!) && !tokens[j]!.includes('─'); j++) name.push(tokens[j]!)
      const status = k > 0 ? /^(?:[>›〉»]|[-])$/.test(tokens[k - 1]!) : tokens.slice(j).includes('·')
      const label = name.join(' ')
      if (status && /\p{L}/u.test(label)) return { id: null, label, effort, at: null }
    }
  }
  return null
}
