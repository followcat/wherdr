// Live xterm viewport -> styled span descriptors (same shape as ansiToLines),
// so the copy-mode overlay can render the screen as selectable text
// pixel-faithful to what the renderer paints.
import type { IBufferCell, Terminal } from '@xterm/xterm'
import { PALETTE, type AnsiSpan } from './ansiToHtml'

// Palette indices 0-15 follow the terminal theme, not the stock xterm table.
const THEME_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

function hex(packed: number): string {
  return '#' + packed.toString(16).padStart(6, '0')
}

function color(cell: IBufferCell, fg: boolean, theme: Record<string, string | undefined>): string | undefined {
  const rgb = fg ? cell.isFgRGB() : cell.isBgRGB()
  const palette = fg ? cell.isFgPalette() : cell.isBgPalette()
  if (rgb) return hex(fg ? cell.getFgColor() : cell.getBgColor())
  if (!palette) return undefined
  const i = fg ? cell.getFgColor() : cell.getBgColor()
  if (i < 16) return theme[THEME_KEYS[i]!]
  return '#' + (PALETTE[i] ?? 'ffffff')
}

export function screenSpans(term: Terminal): AnsiSpan[][] {
  const buf = term.buffer.active
  const theme = (term.options.theme ?? {}) as Record<string, string | undefined>
  const lines: AnsiSpan[][] = []
  for (let y = buf.viewportY; y < Math.min(buf.length, buf.viewportY + term.rows); y++) {
    const line = buf.getLine(y)
    // A wrapped row continues the previous logical line: join it so a copied
    // long line stays in one piece, like desktop selection copy.
    const spans: AnsiSpan[] = line?.isWrapped && lines.length ? lines.pop()! : []
    let cur: AnsiSpan | null = spans[spans.length - 1] ?? null
    for (let x = 0; x < term.cols; x++) {
      const cell = line?.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const ch = cell.getChars() || ' '
      const inverse = cell.isInverse()
      const fg = inverse ? color(cell, false, theme) : color(cell, true, theme)
      const bg = inverse ? color(cell, true, theme) : color(cell, false, theme)
      const style = {
        color: fg, background: bg,
        bold: Boolean(cell.isBold()) || undefined, dim: Boolean(cell.isDim()) || undefined,
        italic: Boolean(cell.isItalic()) || undefined, underline: Boolean(cell.isUnderline()) || undefined,
        strike: Boolean(cell.isStrikethrough()) || undefined,
      }
      const same = cur && cur.color === style.color && cur.background === style.background
        && cur.bold === style.bold && cur.dim === style.dim && cur.italic === style.italic
        && cur.underline === style.underline && cur.strike === style.strike
      if (same) cur!.text += ch
      else { cur = { text: ch, ...style }; spans.push(cur) }
    }
    lines.push(spans.length ? spans : [{ text: '' }])
  }
  // Keep indentation and blank rows, but not renderer padding on the right.
  for (const spans of lines) {
    for (let i = spans.length - 1; i >= 0; i--) {
      spans[i]!.text = spans[i]!.text.replace(/[ \t]+$/, '')
      if (spans[i]!.text) break
      if (i > 0) spans.pop()
    }
  }
  return lines
}
