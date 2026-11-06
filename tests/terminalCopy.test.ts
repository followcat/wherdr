import { describe, expect, it } from 'vitest'
import type { IBufferCell, Terminal } from '@xterm/xterm'
import { captureTerminalScreen } from '../app/utils/terminalCopy'

// Fake xterm buffer: enough of Terminal/IBufferLine/IBufferCell for the
// capture helpers. `cells` gives per-cell content and styles; `text` fills
// width-1 cells. Missing cells read as empty, like xterm's padding.
interface FakeCell {
  ch?: string
  width?: number
  fgRgb?: number
  bgRgb?: number
  fgPalette?: number
  bgPalette?: number
  inverse?: boolean
  invisible?: boolean
  bold?: boolean
  dim?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
}
interface FakeRow {
  text?: string
  cells?: FakeCell[]
  wrapped?: boolean
}

const cell = (c: FakeCell = {}) => ({
  getWidth: () => c.width ?? 1,
  getChars: () => c.ch ?? '',
  isFgRGB: () => c.fgRgb !== undefined,
  isBgRGB: () => c.bgRgb !== undefined,
  isFgPalette: () => c.fgPalette !== undefined,
  isBgPalette: () => c.bgPalette !== undefined,
  getFgColor: () => c.fgRgb ?? c.fgPalette ?? 0,
  getBgColor: () => c.bgRgb ?? c.bgPalette ?? 0,
  isInverse: () => c.inverse ? 1 : 0,
  isInvisible: () => c.invisible ? 1 : 0,
  isBold: () => c.bold ? 1 : 0,
  isDim: () => c.dim ? 1 : 0,
  isItalic: () => c.italic ? 1 : 0,
  isUnderline: () => c.underline ? 1 : 0,
  isStrikethrough: () => c.strike ? 1 : 0,
}) as IBufferCell

function grid(rows: FakeRow[], viewportY: number, height: number, cols = 12, options: Record<string, unknown> = {}) {
  return {
    cols, rows: height, options,
    buffer: {
      active: {
        viewportY,
        length: rows.length,
        getLine: (y: number) => {
          const r = rows[y]
          if (!r) return undefined
          const cells = r.cells ?? [...(r.text ?? '')].map(ch => ({ ch }))
          return { isWrapped: !!r.wrapped, getCell: (x: number) => cell(cells[x]) }
        },
      },
    },
  } as unknown as Terminal
}

const text = (term: Terminal) =>
  captureTerminalScreen(term).lines.map(l => l.map(s => s.text).join('')).join('\n')

describe('frozen terminal snapshot', () => {
  it('captures only the visible viewport, bounded by the buffer', () => {
    const rows = [{ text: 'older' }, { text: 'one' }, { text: 'two' }, { text: 'three' }]
    expect(text(grid(rows, 1, 2))).toBe('one\ntwo')
    // Viewport taller than the buffer: stops at the buffer's length.
    expect(text(grid(rows, 2, 8))).toBe('two\nthree')
  })

  it('reads no cell beyond the terminal columns', () => {
    const t = grid([{ cells: [...'abcdefghijklmnop'].map(ch => ({ ch })) }], 0, 1)
    expect(text(t)).toBe('abcdefghijkl')
  })

  it('keeps indentation and hard blank lines', () => {
    expect(text(grid([{ text: 'old' }, { text: '  code   ' }, { text: '' }, { text: 'next' }, { text: 'below' }], 1, 3)))
      .toBe('  code\n\nnext')
  })

  it('joins only explicit wrapped rows; a full-width code row stays a hard newline', () => {
    expect(text(grid([{ text: 'abcdefghijkl' }, { text: 'second' }, { text: 'continued', wrapped: true }], 0, 3)))
      .toBe('abcdefghijkl\nsecond      continued')
  })

  it('keeps the visible suffix when the viewport starts mid-paragraph', () => {
    // The first visible row is wrapped (it continues a row offscreen): there
    // is nothing to join it to, so it stays its own line.
    expect(text(grid([{ text: 'suffix', wrapped: true }, { text: 'next' }], 0, 2))).toBe('suffix\nnext')
  })

  it('keeps the ambiguous final-cell blank a wrapped wide glyph can leave', () => {
    // 4 columns, `abc你`: the wide glyph cannot start in the last column, so
    // xterm leaves that cell empty and wraps it. An erased cell (ESC[X) looks
    // identical in the buffer, so the capture keeps it as a space — a stray
    // space beats losing a real one. See screenSpansBuffer.test.ts, which
    // proves the two cells indistinguishable on the real xterm.
    expect(text(grid([
      { text: 'abc' },
      { cells: [{ ch: '你', width: 2 }, { width: 0 }], wrapped: true },
    ], 0, 2, 4))).toBe('abc 你')
    // `ab  你`: intentional spaces before it are real cells and stay.
    expect(text(grid([
      { text: 'ab  ' },
      { cells: [{ ch: '你', width: 2 }, { width: 0 }], wrapped: true },
    ], 0, 2, 4))).toBe('ab  你')
  })

  it('keeps interior blanks, hard newlines and wide cells once through the join', () => {
    expect(text(grid([{ cells: [{ ch: 'a' }, {}, { ch: 'b' }] }], 0, 1, 4))).toBe('a b')
    // A full-width row that continues normally still joins without padding.
    expect(text(grid([
      { text: 'abcd' },
      { cells: [{ ch: '你', width: 2 }, { width: 0 }, { ch: 'f' }], wrapped: true },
    ], 0, 2, 4))).toBe('abcd你f')
    // Three wide glyphs in 4 columns: two fill the row, the third wraps —
    // each appears exactly once, continuation cells still skipped.
    expect(text(grid([
      { cells: [{ ch: '你', width: 2 }, { width: 0 }, { ch: '你', width: 2 }, { width: 0 }] },
      { cells: [{ ch: '你', width: 2 }, { width: 0 }], wrapped: true },
    ], 0, 2, 4))).toBe('你你你')
  })

  it('skips continuation cells, keeps wide and combined characters once, keeps empty cells', () => {
    const t = grid([{ cells: [
      { ch: '你', width: 2 }, { width: 0 },
      { ch: '🙂', width: 2 }, { width: 0 },
      { ch: 'é' }, { ch: '' }, { ch: 'x' },
    ] }], 0, 1)
    expect(text(t)).toBe('你🙂é x')
  })

  it('groups adjacent cells of one style into one span', () => {
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'a', bold: true }, { ch: 'b', bold: true }, { ch: 'c' }, { ch: 'd', underline: true },
    ] }], 0, 1))
    expect(snap.lines[0]).toEqual([
      { text: 'ab', bold: true },
      { text: 'c' },
      { text: 'd', underline: true },
    ])
  })

  it('keeps bold, dim, italic, underline and strike', () => {
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'x', bold: true, dim: true, italic: true, underline: true, strike: true },
    ] }], 0, 1))
    expect(snap.lines[0]![0]).toMatchObject({
      text: 'x', bold: true, dim: true, italic: true, underline: true, strike: true,
    })
  })

  it('resolves RGB and indexed colors, indices 0-15 from the active theme', () => {
    const theme = { foreground: '#e0e0e0', background: '#101018', red: '#aa1111', brightGreen: '#33bb33' }
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'a', fgRgb: 0x3366ff }, { ch: 'b', bgRgb: 0x112233 },
      { ch: 'c', fgPalette: 1 }, { ch: 'd', bgPalette: 10 },
      { ch: 'e', fgPalette: 196 }, { ch: 'f', bgPalette: 240 },
    ] }], 0, 1, 12, { theme }))
    expect(snap.lines[0]).toEqual([
      { text: 'a', color: '#3366ff' },
      { text: 'b', background: '#112233' },
      { text: 'c', color: '#aa1111' },
      { text: 'd', background: '#33bb33' }, // index 10: brightGreen
      { text: 'e', color: '#ff0000' }, // index 196: 6x6x6 cube red
      { text: 'f', background: '#585858' }, // index 240: grayscale ramp
    ])
  })

  it('conceals invisible cells like the renderer, keeping their column width and style', () => {
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'a' },
      { ch: '秘', width: 2, invisible: true, bgPalette: 2 }, { width: 0 }, // concealed wide cell: two columns
      { ch: 'x', invisible: true, bgPalette: 2 },
      { ch: 'b' },
    ] }], 0, 1, 12, { theme: { green: '#229922' } }))
    expect(snap.lines[0]).toEqual([
      { text: 'a' },
      { text: '   ', background: '#229922' }, // two columns for 秘 plus one for x
      { text: 'b' },
    ])
  })

  it('swaps inverse cell colors, resolving default sides from the theme', () => {
    const theme = { foreground: '#e0e0e0', background: '#101018', red: '#aa1111', green: '#229922' }
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'a', inverse: true }, // default on default: a block of the text color
      { ch: 'b', inverse: true, bgPalette: 1 }, // red block on the text color
      { ch: 'c', inverse: true, fgPalette: 1 }, // background glyph on red
      { ch: 'd', inverse: true, fgPalette: 1, bgPalette: 2 }, // red on green -> green on red
    ] }], 0, 1, 12, { theme }))
    expect(snap.lines[0]).toEqual([
      { text: 'a', color: '#101018', background: '#e0e0e0' },
      { text: 'b', color: '#aa1111', background: '#e0e0e0' },
      { text: 'c', color: '#101018', background: '#aa1111' },
      { text: 'd', color: '#229922', background: '#aa1111' },
    ])
  })

  it('brightens a bold indexed foreground 0-7 like the renderer, never the background', () => {
    const theme = {
      foreground: '#e0e0e0', background: '#101018',
      red: '#aa1111', brightRed: '#ff6666', green: '#229922', brightGreen: '#44cc44',
    }
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'a', bold: true, fgPalette: 1 }, // bold red -> brightRed
      { ch: 'b', fgPalette: 1 }, // not bold -> red
      { ch: 'c', bold: true, fgPalette: 10 }, // already bright: index >= 8 unchanged
      { ch: 'd', bold: true, fgRgb: 0x112233 }, // RGB foregrounds never brighten
      { ch: 'e', bold: true, bgPalette: 1 }, // backgrounds never brighten
    ] }], 0, 1, 12, { theme })) // drawBoldTextInBrightColors unset: xterm default is true
    expect(snap.lines[0]).toEqual([
      { text: 'a', color: '#ff6666', bold: true },
      { text: 'b', color: '#aa1111' },
      { text: 'c', color: '#44cc44', bold: true },
      { text: 'd', color: '#112233', bold: true },
      { text: 'e', background: '#aa1111', bold: true },
    ])
  })

  it('leaves indexed colors alone when drawBoldTextInBrightColors is off', () => {
    const theme = { foreground: '#e0e0e0', background: '#101018', red: '#aa1111', brightRed: '#ff6666' }
    const snap = captureTerminalScreen(grid([{ cells: [
      { ch: 'a', bold: true, fgPalette: 1 },
    ] }], 0, 1, 12, { theme, drawBoldTextInBrightColors: false }))
    expect(snap.lines[0]).toEqual([{ text: 'a', color: '#aa1111', bold: true }])
  })

  it('brightens an inverse cell\'s displayed foreground from its background source', () => {
    const theme = {
      foreground: '#e0e0e0', background: '#101018',
      red: '#aa1111', brightGreen: '#44cc44', green: '#229922',
    }
    const snap = captureTerminalScreen(grid([{ cells: [
      // Inverse swaps first: the background source (green, index 2) becomes
      // the displayed foreground and is brightened; the displayed background
      // (red) is not.
      { ch: 'a', inverse: true, bold: true, fgPalette: 1, bgPalette: 2 },
      // Default background source: displayed foreground is the theme background.
      { ch: 'b', inverse: true, bold: true, fgPalette: 1 },
    ] }], 0, 1, 12, { theme }))
    expect(snap.lines[0]).toEqual([
      { text: 'a', color: '#44cc44', background: '#aa1111', bold: true },
      { text: 'b', color: '#101018', background: '#aa1111', bold: true },
    ])
  })

  it('records columns and font metrics for the copy surface', () => {
    const snap = captureTerminalScreen(grid([{ text: 'x' }], 0, 1, 40, { fontFamily: '"JetBrains Mono Variable"', fontSize: 15 }))
    expect({ columns: snap.columns, fontFamily: snap.fontFamily, fontSize: snap.fontSize })
      .toEqual({ columns: 40, fontFamily: '"JetBrains Mono Variable"', fontSize: 15 })
  })

  it('owns its strings after the live grid is changed', () => {
    const rows = [{ text: 'before' }]
    const snapshot = captureTerminalScreen(grid(rows, 0, 1))
    rows[0]!.text = 'after'
    expect(snapshot.lines[0]![0]!.text).toBe('before')
  })

  it('keeps markup and escape-like text as plain snapshot data', () => {
    const hostile = '<img src=x onerror="alert(1)">\u001b[31m'
    const snap = captureTerminalScreen(grid([{ text: hostile }], 0, 1, 60))
    expect(snap.lines[0]).toEqual([{ text: hostile }])
  })
})
