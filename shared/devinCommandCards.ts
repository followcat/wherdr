// Devin's /usage, /context and /session-stats print their answer into the
// terminal, never into the session store, so wherdr reads the block off the
// screen after the send (server/utils/devinCards.ts) and turns it into a card.
// Pure: no Nuxt, no IO. The screen is plain text: bars are glyph runs, and a
// block is whatever sits under the newest echo of the command ("❭ /usage").
import type { DevinCardCommand, DevinCommandCard, DevinRow, DevinShare, DevinUsageWindow } from './types'

export const DEVIN_CARD_COMMANDS: readonly DevinCardCommand[] = ['/usage', '/context', '/session-stats']

// The three commands, typed exactly (surrounding space aside).
export function devinCardCommand(text: string): DevinCardCommand | null {
  return DEVIN_CARD_COMMANDS.find(c => c === text.trim()) ?? null
}

// Devin echoes each command it runs, after its prompt marker.
const ECHO = /^\s*❭ (\/\S+)\s*$/
const echoOf = (line: string) => ECHO.exec(line)?.[1]

// How many echoes of the command the screen shows: an older one stays on it.
export function devinEchoCount(screen: string, command: DevinCardCommand): number {
  return screen.split('\n').filter(l => echoOf(l) === command).length
}

// What the screen shows of a command before it runs: its echoes, and the content
// above the input frame. A turn's output scrolls the screen, so an older echo can
// leave it while the new one comes in: the content tells what was printed since.
export interface DevinCardBaseline { echoes: number, content: string[] }
// Lines that change while a turn runs (a spinner, the frame and its placeholder and
// status, the cwd line under the frame). An echo of a command is content.
const VOLATILE = /^\s*(?:[\u2801-\u28ff]|❭(?! \/)|─{5,}|●\s+\/)|\besc\b.*\binterrupt\b/
function contentOf(screen: string): string[] {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''))
  const frame = lines.findLastIndex(l => RULE.test(l))
  return (frame < 0 ? lines : lines.slice(0, frame)).filter(l => l.trim() && !VOLATILE.test(l))
}
export function devinCardBaseline(screen: string, command: DevinCardCommand): DevinCardBaseline {
  return { echoes: devinEchoCount(screen, command), content: contentOf(screen) }
}
// The lines printed since the baseline: the screen scrolls, so its last (at least three)
// content lines sit at its top now, and what follows them is new. The last of those
// lines may have grown since (a reply still being written). Null when they do not sit there.
function printedSince(before: string[], now: string[]): string[] | null {
  const min = Math.min(3, before.length)
  if (!min) return null
  for (let s = 0; before.length - s >= min; s++) {
    const kept = before.slice(s)
    const same = kept.every((l, k) => (k === kept.length - 1 ? (now[k] ?? '').startsWith(l) : now[k] === l))
    if (kept.length <= now.length && same) return now.slice(kept.length)
  }
  return null
}
// Whether the screen shows output of the command since the baseline: one more echo,
// or an echo printed after the baseline's content, even when an older echo scrolled off.
export function devinCardNew(screen: string, command: DevinCardCommand, base: DevinCardBaseline): boolean {
  if (devinEchoCount(screen, command) > base.echoes) return true
  const printed = printedSince(base.content, contentOf(screen))
  return printed !== null && printed.some(l => echoOf(l) === command)
}

// A line that starts a new entry ends the block: a prompt or question marker, a
// tool call's or result's line, a braille spinner. A rule ends it too, unless a
// Total row follows (/context and /session-stats end with one).
const ENTRY = /^\s*(?:❭|✓|✗|✱|[\u2801-\u28ff])/
const RULE = /^\s*─{5,}/
const PERCENT = /\d{1,3}%$/
// Two cells, two or more spaces apart: a table row of the block.
const CELL = /\S {2,}\S/

// The lines under the newest echo of the command, up to the line that ends them.
// `complete`: that line ended the block, rather than the bottom of the screen.
// A block still being drawn ends at a row at the very bottom of the screen (its
// cwd line and frame are not drawn yet), and a block with no line yet is not
// written: neither is complete.
export function devinCardBlock(screen: string, command: DevinCardCommand): { lines: string[], complete: boolean } | null {
  const lines = screen.split('\n').map(l => l.replace(/\s+$/, ''))
  const at = lines.findLastIndex(l => echoOf(l) === command)
  if (at < 0) return null
  const block: string[] = []
  let gap: string[] = []
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i]!
    if (!l.trim()) { if (block.length) gap.push(l); continue }
    if (!takes(command, lines, i, !block.length)) {
      // A rule or a cwd line at the very bottom: the frame below it, or a Total row
      // inside the block, is not drawn yet.
      const framing = (RULE.test(l) || l.trim().startsWith('●')) && !lines.slice(i + 1).some(x => x.trim())
      return { lines: block, complete: block.length > 0 && !framing }
    }
    block.push(...gap, l)
    gap = []
    if (command !== '/usage' && /^\s*Total\b/.test(l)) return { lines: block, complete: true }
  }
  return { lines: block, complete: false }
}

// Whether the block goes on at line `i` (not blank). `first`: no line taken yet.
// Prose (an assistant's sentence written right after the block) has no two
// cells, so it ends the block as the entries do.
function takes(command: DevinCardCommand, lines: string[], i: number, first: boolean): boolean {
  const l = lines[i]!
  const t = l.trim()
  if (ENTRY.test(l)) return false
  if (RULE.test(l)) return command !== '/usage' && /^Total\b/.test(lines.slice(i + 1).find(x => x.trim())?.trim() ?? '')
  if (t.startsWith('●')) return command !== '/usage' && PERCENT.test(t) && CELL.test(t)
  if (first || CELL.test(l)) return true
  return command === '/usage'
    ? t === 'This session' || /^No usage yet\b/.test(t)
    : /^Total\b/.test(t) || (command === '/session-stats' && t === 'Tokens by model')
}

// A label and its value, two or more spaces apart.
const ROW = /^(\S.*?)\s{2,}(\S.*)$/
// A category or model row: "● System prompt  ▄▄▄▄....  5.8k   2%"; its bar and
// value are optional, its share is not.
const SHARE = /^●\s+(.+?)\s{2,}(?:[\u2581-\u2588.]+\s*)?(?:([\d.,]+k?)\s+)?(\d{1,3})%$/
const WINDOW = /^(Daily|Weekly)\s+[■\s]*?(\d{1,3})% used\s*·\s*(.+)$/
const CONTEXT_HEAD = /^Context usage(?:\s+(\S.*))?$/
const CONTEXT_TOTAL = /^Total\s+([\d.,]+k?)\/([\d.,]+k?)\s+(\d{1,3})%$/
const STATS_TOTAL = /^Total\s+(\S.*)$/
const STATS_HEAD = /^Session stats\b/
const collapse = (s: string) => s.replace(/\s{2,}/g, ' ')

export function parseDevinCard(command: DevinCardCommand, lines: string[]): DevinCommandCard {
  const card = command === '/usage' ? usageOf(lines) : command === '/context' ? contextOf(lines) : statsOf(lines)
  return card ?? { command, kind: 'text', lines: textOf(lines) }
}

function usageOf(lines: string[]): DevinCommandCard | null {
  const windows: DevinUsageWindow[] = []
  const session: DevinRow[] = []
  let note: string | null = null
  let inSession = false
  for (const line of lines) {
    const t = line.trim()
    const w = WINDOW.exec(t)
    const r = ROW.exec(t)
    if (w) windows.push({ label: w[1]!, percent: Number(w[2]), reset: w[3]!.trim() })
    else if (t === 'This session') inSession = true
    else if (/^No usage yet\b/.test(t)) note = t
    else if (inSession && r) session.push({ label: r[1]!, value: collapse(r[2]!) })
  }
  return windows.length || session.length || note ? { command: '/usage', kind: 'usage', windows, session, note } : null
}

function contextOf(lines: string[]): DevinCommandCard | null {
  let model: string | null = null
  const categories: DevinShare[] = []
  let total: { used: string, limit: string, percent: number } | null = null
  for (const line of lines) {
    const t = line.trim()
    const head = CONTEXT_HEAD.exec(t)
    const share = SHARE.exec(t)
    const sum = CONTEXT_TOTAL.exec(t)
    if (head) model = head[1] ?? null
    else if (share) categories.push({ label: share[1]!, value: share[2] ?? null, percent: Number(share[3]) })
    else if (sum) total = { used: sum[1]!, limit: sum[2]!, percent: Number(sum[3]) }
  }
  return categories.length || total ? { command: '/context', kind: 'context', model, categories, total } : null
}

function statsOf(lines: string[]): DevinCommandCard | null {
  const rows: DevinRow[] = []
  const models: DevinShare[] = []
  let total: string | null = null
  for (const line of lines) {
    const t = line.trim()
    const share = SHARE.exec(t)
    const sum = STATS_TOTAL.exec(t)
    const row = ROW.exec(t)
    if (STATS_HEAD.test(t) || t === 'Tokens by model') continue
    if (share) models.push({ label: share[1]!, value: share[2] ?? null, percent: Number(share[3]) })
    else if (sum) total = collapse(sum[1]!)
    else if (row && !t.startsWith('●')) rows.push({ label: row[1]!, value: collapse(row[2]!) })
  }
  return rows.length || models.length || total ? { command: '/session-stats', kind: 'stats', rows, models, total } : null
}

// What a block shows when its shape is not known: the lines as text, bar glyph
// runs dropped, a session id scrubbed, rules left out, a long block cut short.
const BARS = /[.■▄▁-█]*[■▄▁-█][.■▄▁-█]*|\.{4,}/g
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const TEXT_LINES = 40
function textOf(lines: string[]): string[] {
  return lines
    .map(l => l.replace(UUID, '').replace(BARS, '').replace(/ {3,}/g, '  ').trim())
    .filter(l => l && !/^─+$/.test(l))
    .slice(0, TEXT_LINES)
}

// The card as plain text: the conversation's search and copy read it.
export function devinCardText(card: DevinCommandCard): string {
  const share = (s: DevinShare) => collapse(`${s.label} ${s.value ?? ''} ${s.percent}%`)
  const lines = card.kind === 'usage'
    ? ['Usage', ...card.windows.map(w => `${w.label} ${w.percent}% used · ${w.reset}`), ...card.session.map(r => `${r.label} ${r.value}`), ...(card.note ? [card.note] : [])]
    : card.kind === 'context'
      ? [collapse(`Context usage ${card.model ?? ''}`), ...card.categories.map(share), ...(card.total ? [`Total ${card.total.used}/${card.total.limit} ${card.total.percent}%`] : [])]
      : card.kind === 'stats'
        ? ['Session stats', ...card.rows.map(r => `${r.label} ${r.value}`), ...card.models.map(share), ...(card.total ? [`Total ${card.total}`] : [])]
        : card.lines
  return lines.join('\n')
}
