// Rendered-ANSI scrollback -> styled span descriptors for the local history
// overlay. Pure data (no DOM): the component builds the elements, tests run
// in plain Node, and no markup from pane output is ever injected.

// xterm's 256-palette for the 38;5;n / 48;5;n escapes.
export const PALETTE = (() => {
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

export interface AnsiSpan {
  text: string
  color?: string
  background?: string
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

interface Style {
  fg: string | null
  bg: string | null
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  inverse: boolean
  strike: boolean
}

const plain = (): Style => ({ fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false, strike: false })

const ANSI_RE = /\x1b\[([0-9;:]*)m/g

function applySgr(params: string, s: Style) {
  const codes = params.split(';').map(x => parseInt(x, 10))
  if (!codes.length || codes.every(Number.isNaN)) codes.splice(0, codes.length, 0)
  for (let i = 0; i < codes.length; i++) {
    const c = Number.isNaN(codes[i]!) ? 0 : codes[i]!
    if (c === 0) Object.assign(s, plain())
    else if (c === 1) s.bold = true
    else if (c === 2) s.dim = true
    else if (c === 3) s.italic = true
    else if (c === 4) s.underline = true
    else if (c === 7) s.inverse = true
    else if (c === 9) s.strike = true
    else if (c === 22) { s.bold = false; s.dim = false }
    else if (c === 23) s.italic = false
    else if (c === 24) s.underline = false
    else if (c === 27) s.inverse = false
    else if (c === 29) s.strike = false
    else if (c === 39) s.fg = null
    else if (c === 49) s.bg = null
    else if (c >= 30 && c <= 37) s.fg = '#' + PALETTE[c - 30]
    else if (c >= 40 && c <= 47) s.bg = '#' + PALETTE[c - 40]
    else if (c >= 90 && c <= 97) s.fg = '#' + PALETTE[c - 90 + 8]
    else if (c >= 100 && c <= 107) s.bg = '#' + PALETTE[c - 100 + 8]
    else if (c === 38 || c === 48) {
      const fg = c === 38
      const mode = codes[i + 1]
      if (mode === 5 && codes[i + 2] !== undefined) {
        const hex = '#' + PALETTE[Math.max(0, Math.min(255, codes[i + 2]!))]
        if (fg) s.fg = hex; else s.bg = hex
        i += 2
      } else if (mode === 2 && codes[i + 2] !== undefined) {
        const rgb = `rgb(${codes[i + 2]!},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`
        if (fg) s.fg = rgb; else s.bg = rgb
        i += 4
      }
    }
  }
}

const toSpan = (text: string, s: Style): AnsiSpan => ({
  text,
  color: s.inverse ? (s.bg ?? undefined) : (s.fg ?? undefined),
  background: s.inverse ? (s.fg ?? undefined) : (s.bg ?? undefined),
  bold: s.bold || undefined,
  dim: s.dim || undefined,
  italic: s.italic || undefined,
  underline: s.underline || undefined,
  strike: s.strike || undefined,
})

// One rendered-ANSI dump -> an array of lines, each a list of styled spans.
// SGR state carries across lines: a color opened on one line often closes
// several later. Carriage returns and every non-SGR escape (OSC titles,
// private CSI, charset shifts) are stripped so they can't leak as glyphs.
export function ansiToLines(text: string): AnsiSpan[][] {
  const style = plain()
  const clean = text
    .replace(/\r/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;:?>! ]*([A-Za-z])/g, (m, end) => (end === 'm' ? m : ''))
    .replace(/\x1b[()#][0-9A-Za-z]|\x1b[=>McDEHNZ78]/g, '')
  return clean.split('\n').map((line) => {
    const spans: AnsiSpan[] = []
    let last = 0
    ANSI_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = ANSI_RE.exec(line))) {
      if (m.index > last) spans.push(toSpan(line.slice(last, m.index), style))
      applySgr(m[1] || '0', style)
      last = m.index + m[0].length
    }
    if (line.length > last) spans.push(toSpan(line.slice(last), style))
    return spans.length ? spans : [{ text: '' }]
  })
}
