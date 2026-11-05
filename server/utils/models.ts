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
