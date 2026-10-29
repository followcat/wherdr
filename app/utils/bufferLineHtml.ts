import type { IBufferLine, ITheme } from '@xterm/xterm'

// Render an xterm buffer line to styled HTML for the predicted-scroll edge
// strips. Rows arriving unstyled made the covering frame's real colors pop
// in -- that mismatch read as a flash on every settle.
export const THEME16_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'] as const
const NAMES = THEME16_NAMES
const CUBE = [0, 95, 135, 175, 215, 255]
const hex = (n: number) => n.toString(16).padStart(2, '0')

function paletteCss(idx: number, theme?: ITheme): string | null {
  idx &= 0xff
  if (idx < 16) return theme?.[NAMES[idx]!] ?? null
  if (idx < 232) {
    const n = idx - 16
    return `#${hex(CUBE[Math.floor(n / 36) % 6]!)}${hex(CUBE[Math.floor(n / 6) % 6]!)}${hex(CUBE[n % 6]!)}`
  }
  const g = 8 + (idx - 232) * 10
  return `#${hex(g)}${hex(g)}${hex(g)}`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export function bufferLineToHtml(line: IBufferLine, theme?: ITheme): string {
  let html = '', run = '', key = ''
  const flush = (style: string) => {
    if (run) html += `<span style="white-space:pre;${style}">${esc(run)}</span>`
    run = ''
  }
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    let fg: string | null = cell.isFgRGB() ? `#${(cell.getFgColor() >>> 0).toString(16).padStart(6, '0')}`
      : cell.isFgPalette() ? paletteCss(cell.getFgColor(), theme) : null
    let bg: string | null = cell.isBgRGB() ? `#${(cell.getBgColor() >>> 0).toString(16).padStart(6, '0')}`
      : cell.isBgPalette() ? paletteCss(cell.getBgColor(), theme) : null
    if (cell.isInverse()) { const t = fg ?? theme?.foreground ?? null; fg = bg ?? theme?.background ?? null; bg = t }
    const style = `${fg ? `color:${fg};` : ''}${bg ? `background-color:${bg};` : ''}${cell.isBold() ? 'font-weight:700;' : ''}${cell.isItalic() ? 'font-style:italic;' : ''}${cell.isUnderline() || cell.isStrikethrough() ? `text-decoration:${cell.isUnderline() ? 'underline' : ''}${cell.isStrikethrough() ? ' line-through' : ''};` : ''}${cell.isDim() ? 'opacity:.55;' : ''}`
    if (style !== key) { flush(key); key = style }
    run += cell.isInvisible() ? ' ' : cell.getChars() || ' '
  }
  flush(key)
  return html
}
