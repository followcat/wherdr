import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { IBufferCell, Terminal } from '@xterm/xterm'
import { captureTerminalScreen } from '../app/utils/terminalCopy'

// The installed xterm, driven through its public write/buffer API only — no
// open(), no DOM. This exercises the same cells the live terminal produces, so
// an ANSI sequence cannot be mis-modeled by a fake buffer.
const { Terminal } = createRequire(import.meta.url)('@xterm/xterm') as typeof import('@xterm/xterm')

const write = (term: Terminal, data: string) => new Promise<void>(done => term.write(data, done))

const text = (term: Terminal) =>
  captureTerminalScreen(term).lines.map(l => l.map(s => s.text).join('')).join('\n')

const cellMeta = (c: IBufferCell | undefined) => c && ({
  chars: c.getChars(), width: c.getWidth(), code: c.getCode(), invisible: c.isInvisible(),
  fgDefault: c.isFgDefault(), bgDefault: c.isBgDefault(), attrDefault: c.isAttributeDefault(),
})

describe('frozen copy from a real xterm buffer', () => {
  it('keeps an erased blank before a wrapped wide glyph', async () => {
    const term = new Terminal({ cols: 4, rows: 3, allowProposedApi: true })
    try {
      await write(term, 'abcd你')
      // Erase the `d` in the last column: the blank cell left behind is real
      // content, so the copy must be `abc 你`, not `abc你`.
      await write(term, '\x1b[1;4H\x1b[X')
      const line = term.buffer.active.getLine(0)!
      expect(line.getCell(3)!.getChars()).toBe('')
      expect(term.buffer.active.getLine(1)!.isWrapped).toBe(true)
      expect(text(term)).toBe('abc 你\n')
    } finally { term.dispose() }
  })

  it('keeps the wide-glyph pad as a space too: the cell data is identical', async () => {
    const pad = new Terminal({ cols: 4, rows: 3, allowProposedApi: true })
    const erased = new Terminal({ cols: 4, rows: 3, allowProposedApi: true })
    try {
      // `abc你` wraps the wide glyph off the last column; the cell it could
      // not start in stays empty — the same empty an erase leaves behind.
      await write(pad, 'abc你')
      await write(erased, 'abcd你')
      await write(erased, '\x1b[1;4H\x1b[X')
      const padCell = cellMeta(pad.buffer.active.getLine(0)!.getCell(3))
      const erasedCell = cellMeta(erased.buffer.active.getLine(0)!.getCell(3))
      expect(padCell?.attrDefault).toBe(true)
      expect(erasedCell).toEqual(padCell)
      // Public buffer data cannot tell wrap padding from an erased blank, so
      // the capture keeps both; a stray space beats losing real content.
      expect(text(pad)).toBe('abc 你\n')
    } finally { pad.dispose(); erased.dispose() }
  })
})
