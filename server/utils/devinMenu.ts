// Devin's /model selector (v3000.x), captured live:
//
//   ─────────────────────────────────────────────────────────
//   / SWE-2                                     ← search field
//   ─────────────────────────────────────────────────────────
//     Adaptive
//     Fusion                    ◼◼◼◼◼    Max    Lead X ▾ Sidekick Y ▾
//     Recently Used
//   ❭ SWE-2               ✱   ← ◼◼◼    → Max    Fast Mode Off
//     Claude Opus 5.5           ◼◼◼◼◼    Medium  Fast Mode Off
//     Recommended
//     Claude Fable 5.1          ◼◼◼◼◼    Medium
//     ↓ more below
//     ●━━━━━━━━━━━━━━━━━━━━━━━  ← cursor price row (Input … $/1M)
//   ↑↓ select · ←→ effort · ↵ confirm · alt+↵ this session only · esc cancel
//
// A row is a model option when it has a name column; "Recently Used",
// "Recommended", "More Models", "Adaptive"… are section labels. The cursor
// "❭" row wraps its quota bar in ← → (the effort slider). ↵ would set the
// global default — only alt+↵ is session-scoped, so that is the ONLY key
// wherdr may send to confirm.
import type { ModelOption } from '../../shared/types'

export interface DevinModelMenu { search: string, options: (ModelOption & { n: number, here?: boolean })[], cursor: number }

const LEGEND = /↑↓ select · .*↵ confirm · alt\+↵ this session only · esc cancel/
const SEARCH = /^\/ ?(.*)$/
const RULE = /^─{5,}/
const SECTION = /^(?:Recently Used|Recommended|More Models|↑ more above|↓ more below)$/
// Adaptive is a bare selectable row (no quota bar/effort) in the live menu.
const BARE = /^(?:Adaptive)$/
const SKIP = /^(?:FREE\b|✱\s|Input\s+Cached|●━|━*●|\$\d)/

// "  SWE-2               ✱   ← ◼◼◼    → Max           Fast Mode Off"
// "❭ GPT-6 Luna          ✱   ← ◼◼◼◼◼◼ → Medium        Fast Mode Off"
// "  Claude Opus 4.6                                  Thinking On      1M Context Off"
const OPTION = /^(❭|  ) *(\S(?:.*?\S)?)(?:\s{2,}((?:✱\s*)?(?:←\s*)?[◼·\s]*(?:→\s*)?(?:Low|Medium|High|Max)?)\s*(.*?))?$/

// The picker is open whenever its key legend is on screen — even when a
// search leaves zero options, so close detection must not rely on parsing.
export const devinMenuOpen = (text: string | null | undefined) => Boolean(text && LEGEND.test(text))

export function parseDevinModelMenu(text: string | null | undefined): DevinModelMenu | null {
  if (!text) return null
  const lines = String(text).split('\n').map(l => l.replace(/\s+$/, ''))
  const legend = lines.findLastIndex(l => LEGEND.test(l))
  if (legend < 0) return null
  const options: DevinModelMenu['options'] = []
  let cursor = -1
  let search = ''
  for (let i = legend - 1; i >= 0; i--) {
    const l = lines[i]!
    const t = l.trim()
    if (!t || RULE.test(l)) {
      if (!options.length) continue
      // A rule ends the option rows; the "/…" search field sits just above it.
      for (let j = i - 1; j >= 0; j--) {
        const sj = lines[j]!.trim()
        if (!sj || RULE.test(lines[j]!)) continue
        const s = SEARCH.exec(sj)
        if (s) search = s[1]!
        break
      }
      break
    }
    // Reached without a rule first (search field directly above options).
    const s = SEARCH.exec(t)
    if (s) { search = s[1]!; break }
    if (SECTION.test(t) || SKIP.test(t)) continue
    const m = OPTION.exec(l)
    if (!m || !m[2]) continue
    // The quota bar or an effort word must follow the name — plain prose is
    // not an option row.
    const rest = [m[3], m[4]].filter(Boolean).join(' ')
    if (!rest && !BARE.test(m[2]!)) continue
    if (rest && !/[◼←→]/.test(rest) && !/\b(Low|Medium|High|Max|Thinking On|Thinking|Off|FREE)\b/.test(rest) && !/✱/.test(rest)) continue
    const hint = [m[3]?.replace(/[◼·←→\s]+/g, ' ').trim(), m[4]?.trim()].filter(Boolean).join(' · ') || null
    const opt = { label: m[2].slice(0, 80), hint, n: 0, here: m[1] === '❭' }
    options.unshift(opt)
  }
  cursor = options.findIndex(o => o.here)
  for (const o of options) delete (o as { here?: boolean }).here
  options.forEach((o, i) => { o.n = i + 1 })
  if (!options.length) return null
  // cursor stays -1 when no ❭ marker parsed — callers must not guess it.
  return { search, options, cursor }
}

// The confirmation Devin echoes after alt+↵:
//   ✓ Model set to Grok 4.7 for this session
export function devinModelSetEcho(text: string | null | undefined): string | null {
  const m = [...String(text || '').matchAll(/✓ Model set to (\S(?:.*?\S)?) for this session/g)].at(-1)
  return m ? m[1]! : null
}

// The session's selected model lives on Devin's status line, the bottom line
// under the composer:
//   SWE-2 Max · bypass                             Context: 145k / 262k tokens (55%)
//   SWE-2 Max · bypass · 3 shells ↓                ctrl+o details · alt+t thinking
//   Fusion · GPT-6.1 Sol ◆ SWE-2 High · bypass     See usage and cost: /session-stats
// "<model> · <mode> [· N shells ↓]": the last "·"-part is the mode (bypass,
// normal, accept edits, smart, ask, autonomous), preceded by the model — and
// for Fusion, "Fusion · <lead> ◆ <sidekick>" before the mode. The label is the
// model field's first part. The right side (a 2+-space gap away) carries the
// context meter or shortcut hints and is ignored.
// The transcript's generation_model only names the model that produced the
// last turn — under Fusion it keeps the lead or sidekick name forever — so
// this line is the only place "Fusion" (or a fresh pick) is reported.
const STATUS_MODE = /^(?:normal|accept edits|smart|ask|bypass|autonomous)$/i
const STATUS_SHELLS = /^\d+ shells? ↓$/

export function devinStatusModel(text: string | null | undefined): string | null {
  if (!text) return null
  const lines = String(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim())
  // Status line only: scan the last few lines, bottom up — a lookalike line in
  // the conversation above must never be read as the session's model. The
  // status line sits directly under the composer's "─" rule.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const l = lines[i]!
    const left = l.split(/\s{2,}/)[0]!
    const segs = left.split(' · ').map(s => s.trim()).filter(Boolean)
    if (segs.length && STATUS_SHELLS.test(segs[segs.length - 1]!)) segs.pop()
    if (segs.length < 2 || !STATUS_MODE.test(segs[segs.length - 1]!)) continue
    const label = segs[0]!
    // A model name starts with a letter or digit — never "❭", "✓" or a rule.
    if (label.length > 60 || !/^[\p{L}\p{N}]/u.test(label)) continue
    if (!RULE.test((lines[i - 1] || '').trimStart())) continue
    return label
  }
  return null
}

// The status line's "◆" pair under Fusion: "Fusion · <lead> ◆ <sidekick> · <mode>".
// The applied pair is only ever shown here — the /model row's fields can be
// truncated ("Sidekick GPT-6 Luna H… ▾"), this line is not.
export function devinStatusPair(text: string | null | undefined): { lead: string, sidekick: string } | null {
  if (!text) return null
  const lines = String(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim())
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i--) {
    const left = lines[i]!.split(/\s{2,}/)[0]!
    const segs = left.split(' · ').map(s => s.trim()).filter(Boolean)
    if (segs.length && STATUS_SHELLS.test(segs[segs.length - 1]!)) segs.pop()
    if (segs.length < 3 || !STATUS_MODE.test(segs[segs.length - 1]!)) continue
    if (segs[0] !== 'Fusion') return null // a real status line, but not Fusion
    const pair = segs[1]!.split(' ◆ ').map(s => s.trim())
    if (pair.length !== 2 || !pair[0] || !pair[1]) return null
    if (!RULE.test((lines[i - 1] || '').trimStart())) continue
    return { lead: pair[0], sidekick: pair[1] }
  }
  return null
}

// ── Fusion row: Lead ▾ / Sidekick ▾ dropdowns ───────────────────────────
// tab on the Fusion row cycles effort → Lead → Sidekick → Fast Mode. The
// open dropdown's legend reads "esc collapse" and "tab <next>" names what
// the next tab reaches ("tab sidekick" while Lead is open…). ↑↓ inside a
// dropdown retargets the row field live; "▸" is the pick cursor, "*" the
// default. Live capture:
//   ❭ Fusion  ◼◼◼◼◼  Max   Lead GPT-6.1 Sol   ▾   Sidekick SWE-2 High    ▾   Fast Mode Off
//                             Claude Opus 5.5
//                           ▸ GPT-6.1 Sol
//   ↑↓ select · tab sidekick · shift+←/→ move cursor · ↵ confirm · alt+↵ this session only · esc collapse
export interface DevinFusionState {
  lead: string | null, sidekick: string | null // the row's fields (may end in "…")
  focus: 'effort' | 'lead' | 'sidekick' | 'fast' | null
  dropdown: { which: 'lead' | 'sidekick', options: { label: string, here: boolean, def: boolean }[], cursor: number } | null
}

const FUSION_ROW = /^(?:❭|  ) *Fusion\s/
const FUSION_PAIR = /Lead\s+(.+?)\s+▾\s+Sidekick\s+(.+?)\s+▾/
const DROPDOWN_ENTRY = /^\s{15,}(▸\s+)?(\S.*?)\s*(\*)?\s*$/
const DROPDOWN_SCROLL = /^[↑↓]/

export function parseDevinFusion(text: string | null | undefined): DevinFusionState | null {
  if (!text) return null
  const lines = String(text).split('\n').map(l => l.replace(/\s+$/, ''))
  const legend = lines.find(l => /↑↓ select/.test(l) && /↵ confirm/.test(l))
  if (!legend) return null
  const rowAt = lines.findIndex(l => FUSION_ROW.test(l))
  if (rowAt < 0) return null
  const pair = FUSION_PAIR.exec(lines[rowAt]!)
  // "esc collapse" = a dropdown is open; "tab <next>" names the next control,
  // so the open one is the control before it in the cycle.
  const collapsed = /esc collapse/.test(legend)
  const next = /tab ([a-z ]+?)(?: ·|$)/.exec(legend)?.[1] || ''
  const arrows = /←→ ([a-z ]+?)(?: ·|$)/.exec(legend)?.[1] || ''
  // "tab sidekick" while Lead is open — the open control is the one before
  // the tab target. A legend we cannot place means no dropdown claim.
  const which: 'lead' | 'sidekick' | null = collapsed
    ? (next === 'sidekick' ? 'lead' : next === 'fast mode' ? 'sidekick' : null)
    : null
  const focus: DevinFusionState['focus'] = which || (arrows === 'fast mode' ? 'fast' : 'effort')
  let dropdown: DevinFusionState['dropdown'] = null
  if (which) {
    const options: NonNullable<DevinFusionState['dropdown']>['options'] = []
    for (let i = rowAt + 1; i < lines.length; i++) {
      const l = lines[i]!
      if (/↑↓ select/.test(l) || RULE.test(l.trimStart())) break
      const e = DROPDOWN_ENTRY.exec(l)
      if (!e || DROPDOWN_SCROLL.test(e[2]!)) {
        if (options.length) break
        continue
      }
      options.push({ label: e[2]!.trim(), here: Boolean(e[1]), def: Boolean(e[3]) })
    }
    if (options.length) {
      const cursor = Math.max(0, options.findIndex(o => o.here))
      dropdown = { which, options, cursor }
    }
  }
  return {
    lead: pair?.[1]?.trim() || null,
    sidekick: pair?.[2]?.trim() || null,
    focus,
    dropdown,
  }
}
