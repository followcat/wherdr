// Live xterm viewport -> styled span descriptors, so the copy surface can
// render the screen as selectable text faithful to what the renderer paints.
// Pure data, never HTML: the component interpolates every string as text.
import type { IBufferCell, Terminal } from '@xterm/xterm'

export interface ScreenSpan {
  text: string
  color?: string
  background?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

// xterm's stock 256-color palette, for indexes 16-255 (38;5;n / 48;5;n).
// Indexes 0-15 follow the active terminal theme instead of this table.
const PALETTE = (() => {
  const base = [
    '000000', '800000', '008000', '808000', '000080', '800080', '008080', 'c0c0c0',
    '808080', 'ff0000', '00ff00', 'ffff00', '0000ff', 'ff00ff', '00ffff', 'ffffff',
  ]
  const p = [...base]
  const steps = [0, 95, 135, 175, 215, 255]
  for (let r = 0; r < 6; r++)
    for (let g = 0; g < 6; g++)
      for (let b = 0; b < 6; b++)
        p.push([steps[r]!, steps[g]!, steps[b]!].map(v => v.toString(16).padStart(2, '0')).join(''))
  for (let i = 0; i < 24; i++) {
    const v = (8 + i * 10).toString(16).padStart(2, '0')
    p.push(v + v + v)
  }
  return p
})()

// The 16 theme color names, in palette-index order.
const THEME_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const

const hex = (packed: number) => '#' + packed.toString(16).padStart(6, '0')

// The CSS color of a cell's foreground (`fg`) or background, or undefined for
// the terminal default (the copy surface draws it with the theme's own colors).
// `brighten`: like xterm's drawBoldTextInBrightColors, a bold foreground's
// palette index 0-7 renders as its bright variant 8-15.
function cellColor(cell: IBufferCell, fg: boolean, theme: Record<string, string | undefined>, brighten = false): string | undefined {
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return hex(fg ? cell.getFgColor() : cell.getBgColor())
  if (!(fg ? cell.isFgPalette() : cell.isBgPalette())) return undefined
  let i = fg ? cell.getFgColor() : cell.getBgColor()
  if (brighten && i < 8) i += 8
  if (i < 16) return theme[THEME_KEYS[i]!]
  return '#' + (PALETTE[i] ?? 'ffffff')
}

// The visible rows only, at the current history position. A wrapped row
// continues the previous logical line: join it so a copied long line stays in
// one piece, like desktop selection copy. A viewport starting mid-paragraph
// keeps the visible suffix.
export function screenSpans(term: Terminal): ScreenSpan[][] {
  const buf = term.buffer.active
  const theme = (term.options.theme ?? {}) as Record<string, string | undefined>
  const lines: ScreenSpan[][] = []
  for (let y = buf.viewportY; y < Math.min(buf.length, buf.viewportY + term.rows); y++) {
    const line = buf.getLine(y)
    const spans: ScreenSpan[] = line?.isWrapped && lines.length ? lines.pop()! : []
    let cur: ScreenSpan | null = spans[spans.length - 1] ?? null
    for (let x = 0; x < term.cols; x++) {
      const cell = line?.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      // An empty last-column cell can be wrap padding for a wide glyph that
      // could not start there, but it can equally be an erased blank. Public
      // cell data cannot tell them apart, so it stays a space: a stray space
      // beats losing a real one.
      // Concealed (SGR 8) cells paint as blanks on screen but still occupy
      // their columns; conceal them the same way, styles included.
      const ch = cell.isInvisible() ? ' '.repeat(cell.getWidth()) : cell.getChars() || ' '
      // An inverse cell paints its glyph in the background color on the
      // foreground color; resolve the terminal defaults from the theme so the
      // swap is real, not only when both ends are explicit. Bold brightens
      // only the displayed foreground (drawBoldTextInBrightColors, on unless
      // explicitly off), so the swapped background source is what brightens.
      const inverse = cell.isInverse()
      const bold = Boolean(cell.isBold())
      const brighten = bold && term.options.drawBoldTextInBrightColors !== false
      const fg = inverse ? (cellColor(cell, false, theme, brighten) ?? theme.background) : cellColor(cell, true, theme, brighten)
      const bg = inverse ? (cellColor(cell, true, theme) ?? theme.foreground) : cellColor(cell, false, theme)
      const style = {
        color: fg, background: bg,
        bold: bold || undefined, dim: Boolean(cell.isDim()) || undefined,
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
  // Keep indentation and blank rows, not the renderer's padding on the right.
  for (const spans of lines) {
    for (let i = spans.length - 1; i >= 0; i--) {
      spans[i]!.text = spans[i]!.text.replace(/[ \t]+$/, '')
      if (spans[i]!.text) break
      if (i > 0) spans.pop()
    }
  }
  return lines
}
