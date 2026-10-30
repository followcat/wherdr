import { describe, expect, it } from 'vitest'
import type { Terminal } from '@xterm/xterm'
import { captureTerminalScreen } from '../app/utils/terminalCopy'

function grid(rows: { text: string, wrapped?: boolean }[], start: number, height: number, cols = 12) {
  return {
    cols, rows: height, options: {},
    buffer: { active: { viewportY: start, length: rows.length, getLine: (y: number) => ({
      isWrapped: rows[y]?.wrapped,
      getCell: (x: number) => ({
        getWidth: () => 1, getChars: () => rows[y]?.text[x] || '',
        isFgRGB: () => false, isBgRGB: () => false, isFgPalette: () => false, isBgPalette: () => false,
        isInverse: () => false, isBold: () => false, isDim: () => false, isItalic: () => false,
        isUnderline: () => false, isStrikethrough: () => false,
      }),
    }) } },
  } as unknown as Terminal
}
const text = (term: Terminal) => captureTerminalScreen(term).lines.map(l => l.map(s => s.text).join('')).join('\n')
describe('frozen terminal screen', () => {
  it('captures only visible rows, preserving indentation and hard blank lines', () => {
    expect(text(grid([{ text: 'old' }, { text: '  code   ' }, { text: '' }, { text: 'next' }, { text: 'below' }], 1, 3)))
      .toBe('  code\n\nnext')
  })
  it('joins only explicit wrapped rows; a full-width code row stays a hard newline', () => {
    expect(text(grid([{ text: 'abcdefghijkl' }, { text: 'second' }, { text: 'continued', wrapped: true }], 0, 3)))
      .toBe('abcdefghijkl\nsecond      continued')
  })
  it('owns its strings after the live grid is changed', () => {
    const rows = [{ text: 'before' }]
    const snapshot = captureTerminalScreen(grid(rows, 0, 1))
    rows[0]!.text = 'after'
    expect(snapshot.lines[0]![0]!.text).toBe('before')
  })
})
