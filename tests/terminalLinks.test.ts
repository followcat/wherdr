import { afterEach, describe, expect, it, vi } from 'vitest'
import type { IBufferLine } from '@xterm/xterm'
import { findUrls, linkClickAllowed, openTerminalLink, linksAtRow, rowContinues, rowText, safeLinkUrl } from '../app/utils/terminalLinks'
import { joinWrappedRows, trimSelection } from '../app/utils/terminalSelection'

// Fictional login URL, wrapped by a TUI at 40 columns: each row is written
// on its own, so the terminal knows nothing about the wrap.
const URL = 'https://auth.example.com/oauth/authorize?client_id=demo-client&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fcallback&state=abc123'
const COLS = 40
const pad = (s: string) => s.padEnd(COLS, ' ')
const chunks = (s: string) => s.match(new RegExp(`.{1,${COLS}}`, 'g'))!
const screen = [pad('Browser login: Open login URL'), ...chunks(URL).map(pad), pad('line one'), pad('line two')]
// URL rows: 1..LAST
const LAST = chunks(URL).length

describe('link URLs', () => {
  it('opens only http and https', () => {
    expect(safeLinkUrl('https://example.com/a?b=c')).toBe('https://example.com/a?b=c')
    expect(safeLinkUrl('http://localhost:7683/')).toBe('http://localhost:7683/')
    expect(safeLinkUrl('javascript:alert(1)')).toBeNull()
    expect(safeLinkUrl('JavaScript:alert(1)')).toBeNull()
    expect(safeLinkUrl('file:///etc/passwd')).toBeNull()
    expect(safeLinkUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(safeLinkUrl('vscode://file/x')).toBeNull()
    expect(safeLinkUrl('not a url')).toBeNull()
  })

  it('needs ⌘ (Mac) or Ctrl with a mouse, nothing on a touch screen', () => {
    const e = (metaKey: boolean, ctrlKey: boolean) => ({ metaKey, ctrlKey })
    expect(linkClickAllowed(e(false, false), true, true)).toBe(false)
    expect(linkClickAllowed(e(true, false), true, true)).toBe(true)
    expect(linkClickAllowed(e(false, true), true, true)).toBe(false)
    expect(linkClickAllowed(e(false, true), true, false)).toBe(true)
    expect(linkClickAllowed(e(true, false), true, false)).toBe(false)
    expect(linkClickAllowed(e(false, false), false, true)).toBe(true)
  })

  it('finds URLs in text, without trailing punctuation', () => {
    expect(findUrls('see https://example.com/docs. And (https://example.com/x), done').map(u => u.url))
      .toEqual(['https://example.com/docs', 'https://example.com/x'])
    expect(findUrls('https://en.wikipedia.org/wiki/Tree_(graph_theory)').map(u => u.url))
      .toEqual(['https://en.wikipedia.org/wiki/Tree_(graph_theory)'])
    expect(findUrls('│ https://example.com/a │').map(u => u.url)).toEqual(['https://example.com/a'])
    expect(findUrls('ftp://example.com javascript:alert(1) https://')).toEqual([])
  })
})

describe('wrapped rows', () => {
  it('goes on in the next row only when the row is full', () => {
    expect(rowContinues(screen[1]!, screen[2]!)).toBe(true)
    expect(rowContinues(screen[LAST]!, screen[LAST + 1]!)).toBe(false) // last URL row, padded
    expect(rowContinues(screen[LAST + 1]!, screen[LAST + 2]!)).toBe(false)
    expect(rowContinues('│ text that fills the whole row      │', '│ next')).toBe(false)
    expect(rowContinues('x'.repeat(COLS), ' indented')).toBe(false)
  })

  it('finds a URL wrapped over several rows as one link, from any of its rows', () => {
    for (let y = 1; y <= LAST; y++) {
      const links = linksAtRow(screen, y)
      expect(links).toHaveLength(1)
      expect(links[0]).toEqual({
        url: URL,
        start: { row: 1, col: 0 },
        end: { row: LAST, col: URL.length - (LAST - 1) * COLS },
      })
    }
    expect(linksAtRow(screen, 0)).toEqual([])
    expect(linksAtRow(screen, LAST + 1)).toEqual([])
  })

  it('uses the terminal\'s own wrap flag too', () => {
    // '|' at the start of a row looks like a border: only the flag joins it.
    const rows = [`${'x'.repeat(COLS - 25)} https://example.com/a?b=`, pad('|c rest')]
    expect(linksAtRow(rows, 1)).toEqual([])
    expect(linksAtRow(rows, 1, y => y === 1)[0]!.url).toBe('https://example.com/a?b=|c')
  })

  it('reads one character per cell', () => {
    const cells = ['a', '世', '', 'b', '😀', '']
    const line = { getCell: (x: number) => ({ getChars: () => cells[x] ?? '' }) } as unknown as IBufferLine
    expect(rowText(line, 7)).toBe('a世 b   ')
  })
})

describe('copy of wrapped rows', () => {
  const copy = (top: number, bottom: number) => {
    // xterm's getSelection(): one line per row.
    const text = screen.slice(top, bottom + 1).join('\n')
    return trimSelection(joinWrappedRows(text, screen.slice(top, bottom + 1)))
  }

  it('gives a wrapped URL back in one piece', () => {
    expect(copy(1, LAST)).toBe(URL)
  })

  it('keeps the real line breaks', () => {
    expect(copy(0, LAST)).toBe(`Browser login: Open login URL\n${URL}`)
    expect(copy(LAST, LAST + 2)).toBe(`${chunks(URL)[LAST - 1]}\nline one\nline two`)
  })

  it('joins a partial selection of a wrapped line', () => {
    const rows = screen.slice(1, 3)
    expect(joinWrappedRows(`${rows[0]!.slice(8)}\n${rows[1]!.slice(0, 5)}`, rows)).toBe(URL.slice(8, COLS + 5))
  })

  it('leaves the text alone when it does not match the rows', () => {
    expect(joinWrappedRows('a\nb\nc', [pad('x'), pad('y')])).toBe('a\nb\nc')
  })

  it('follows the terminal\'s wrap flag', () => {
    expect(joinWrappedRows('abc\ndef', [pad('abc'), pad('def')], i => i === 1)).toBe('abcdef')
  })
})


describe('terminal link destinations', () => {
  afterEach(() => vi.unstubAllGlobals())
  function browser(mouse = false) {
    const assign = vi.fn(), open = vi.fn()
    vi.stubGlobal('window', { location: { origin: 'https://app.example.com', pathname: '/', search: '', hash: '#/a/demo', assign }, open })
    vi.stubGlobal('matchMedia', () => ({ matches: mouse }))
    return { assign, open }
  }
  it('keeps a phone link to this app in the current window', () => {
    const b = browser()
    expect(openTerminalLink('https://app.example.com/#/settings')).toBe(true)
    expect(window.location.hash).toBe('#/settings')
    expect(b.assign).not.toHaveBeenCalled()
    expect(b.open).not.toHaveBeenCalled()
  })
  it('handles an app root link without reloading its document', () => {
    const b = browser()
    expect(openTerminalLink('https://app.example.com/')).toBe(true)
    expect(window.location.hash).toBe('#/')
    expect(b.assign).not.toHaveBeenCalled()
    expect(b.open).not.toHaveBeenCalled()
  })
  it('keeps external sites and mouse modifier clicks in a separate tab', () => {
    const b = browser()
    openTerminalLink('https://other.example.com/docs')
    expect(b.open).toHaveBeenCalledWith('https://other.example.com/docs', '_blank', 'noopener,noreferrer')
    expect(b.assign).not.toHaveBeenCalled()
    browser(true)
    expect(openTerminalLink('https://app.example.com/#/settings')).toBe(true)
    expect(window.open).toHaveBeenCalledOnce()
    expect(window.location.assign).not.toHaveBeenCalled()
  })
})
