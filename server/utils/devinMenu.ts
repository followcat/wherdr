// Devin's /model selector and status line (v3000.x), captured live:
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
// wherdr may send to confirm. The menu parsers themselves land in T2.

export const RULE = /^─{5,}/

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
