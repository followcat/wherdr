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
