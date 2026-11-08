// omp's status line and context gauge, read from its screen (pure, server and client).
//
// omp 18 draws the status line just above the bottom of its input box, the context
// gauge at its end (unicode, Nerd Font or ascii symbols; the window size after it):
//
//    ⠸ 4s > ⬢ Model > 🗑 ~/demo > ⑂ main ?1 ▶────6%──────────╎───┃─────128K─
//   ╰─
//
// Some layouts put both in the box's top border instead:
//
//   ╭── ⠦ 4m > ◒ GPT > 📁 ~/project ▶──27%────┃──500K─◀ ⚙ 1 ──╮
//   │ text being typed                                          │
//   ╰───────────────────────────────────────────────────────────╯
//
// Older omp puts the status line last, below a rule, and the gauges in the field's top rule:
//
//   ──────────────── ◫ 51.7%/1M ⟲ · ⏱ 5h 44% (2h 6m) · 7d 71% ─
//   ❯ text being typed
//   ──────────────────────────────────────────────────────────
//    ◒ Opus 5.5 👁 · 📁 ~/wherdr · ⑂ omp-support *24 ?4
import type { OmpStatus } from './types'

// A rule: box lines, or dashes with the ascii symbol preset.
const RULE = /^\s*(?:[─━╰][─━╯\s]{9,}\S?|-{10,})\s*$/
const METERS = /^\s*[─━]{3,} (.+?) [─━]+\s*$/
// Gauge filler: rules, separators and the Nerd Font marks between the figures.
const SEP = '[─━│┃╎┆┊:|\\s\\u{f055d}\\u{f0068}-]'
const NUM = '\\d+(?:\\.\\d+)?'
// A gauge ending the status line, opened by ▶, the powerline arrow or ">" (ascii).
const TAIL_GAUGE = new RegExp(`[▶>\\u{e0b0}](${SEP}*(?:${NUM}%${SEP}*${NUM}[kKmM]?|${NUM}[kKmM]?${SEP}+${NUM}%)${SEP}*)◀?\\s*$`, 'u')

export function parseOmpStatus(text: string | null | undefined): OmpStatus | null {
  return findOmpStatus(text)?.status ?? null
}

// The welcome screen's version under the logo ("██       v18.6.1") and its tip, whose
// lines run until the next blank one.
const VERSION = /^[\s█▉▊▋▌▍▎▏▐░▒▓▄▀]*v\d+\.\d+\.\d+\s*$/u
const TIP = /^\s*Tip:\s/

// The screen without omp's own chrome (status line, gauge rule, welcome version and tip):
// what a card preview may show. The context has its own place, the card's bar.
export function ompPreviewText(text: string): string {
  const drop = new Set(findOmpStatus(text)?.lines ?? [])
  const lines = text.split('\n')
  let tip = false
  lines.forEach((l, i) => {
    tip = TIP.test(l) || (tip && l.trim() !== '')
    if (tip || VERSION.test(l)) drop.add(i)
  })
  return lines.filter((_, i) => !drop.has(i)).join('\n')
}

// The reading, and the indices (in text.split('\n')) of the screen lines it came from.
function findOmpStatus(text: string | null | undefined): { status: OmpStatus, lines: number[] } | null {
  if (!text) return null
  const all = text.split('\n').map(l => l.trimEnd())
  const at = all.map((l, i) => l ? i : -1).filter(i => i >= 0)
  const lines = at.map(i => all[i]!)
  const n = lines.length
  const status = lines[n - 1]
  const below = lines[n - 2]
  if (status && /^\s*╰[─━]/.test(status)) {
    // Only the box's own border: gauges in older output above it are history.
    const b = lines.findLastIndex((l, i) => i >= n - 16 && i < n - 1 && /^\s*╭[─━]/.test(l) && l.includes('▶'))
    if (b >= 0) {
      const border = lines[b]!
      const meters = /▶[^◀\n]*◀/.exec(border)?.[0] ?? null
      const line = border.replace(/^\s*╭[─━]+\s*/, '').replace(/▶[^◀\n]*◀/, ' ').replace(/\s*[─━]*╮\s*$/, '').trim().slice(0, 300)
      return { status: { line, meters }, lines: [at[b]!] }
    }
    if (below && !/^\s*[─━│╭╰├┌└]/.test(below)) {
      const gauge = TAIL_GAUGE.exec(below)
      // Kept as ▶…◀, the form parseOmpContext reads.
      const meters = gauge ? `▶${gauge[1]!.trim()}◀` : null
      const line = (gauge ? below.slice(0, gauge.index) : below).replace(/[\s─━-]+$/, '').trim().slice(0, 300)
      return { status: { line, meters: meters && meters.slice(0, 200) }, lines: [at[n - 2]!] }
    }
  }
  if (!status || !below || !RULE.test(below) || /^\s*[─━│╭╰├┌└]/.test(status)) return null
  let meters: string | null = null
  const used = [at[n - 1]!]
  for (let i = n - 3; i >= Math.max(0, n - 15) && meters === null; i--) {
    const m = METERS.exec(lines[i]!)
    if (m) { meters = m[1]!.trim(); used.push(at[i]!) }
  }
  return { status: { line: status.trim().slice(0, 300), meters: meters && meters.slice(0, 200) }, lines: used }
}

const CONTEXT = /◫\s*(\d+(?:\.\d+)?)%\s*\/\s*(\d+(?:\.\d+)?)\s*([kKmM])?\b/
const BORDER_CONTEXT = new RegExp(`^▶${SEP}*(\\d+(?:\\.\\d+)?)%${SEP}*(\\d+(?:\\.\\d+)?)([kKmM])?${SEP}*◀$`, 'u')
// Above the window (after switching to a smaller model), omp writes the window first.
const OVERFLOW_CONTEXT = new RegExp(`^▶${SEP}*(\\d+(?:\\.\\d+)?)([kKmM])?${SEP}+(\\d+(?:\\.\\d+)?)%${SEP}*◀$`, 'u')

export interface OmpContext { pct: number, total: number, estimated: number }

// omp's gauge shows a rounded percentage of the window, not a token count.
export function parseOmpContext(text: string | null | undefined): OmpContext | null {
  const trimmed = text?.trim() || ''
  const match = CONTEXT.exec(text || '') || BORDER_CONTEXT.exec(trimmed)
  const overflow = match ? null : OVERFLOW_CONTEXT.exec(trimmed)
  if (!match && !overflow) return null
  const pct = Number(match?.[1] ?? overflow?.[3])
  const unit = (match?.[3] ?? overflow?.[2])?.toUpperCase()
  const total = Number(match?.[2] ?? overflow?.[1]) * (unit === 'M' ? 1_000_000 : unit === 'K' ? 1_000 : 1)
  if (!Number.isFinite(pct) || !Number.isFinite(total) || total <= 0) return null
  return { pct, total, estimated: total * pct / 100 }
}
