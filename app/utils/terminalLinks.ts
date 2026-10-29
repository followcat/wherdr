// Links in an xterm terminal: OSC 8 hyperlinks
// (xterm's linkHandler) and plain http(s) URLs (our own link provider).
//
// Herdr paints each row with an absolute cursor move, so xterm never sees a
// soft wrap (`isWrapped` stays false), and TUIs such as omp wrap long URLs
// themselves anyway. A row is therefore taken as continued on the next one
// when it is filled up to the last column and the next one starts with a
// character (box-drawing borders excluded): a URL wrapped over several rows
// is one link, and copying it gives it back in one piece (terminalSelection).
//
// Opening: ⌘+click (Mac) or Ctrl+click with a mouse, as in native terminals,
// since a plain click starts a selection; a plain tap on a touch screen.
// Only http and https open. Phone links within this app stay in its window;
// external links and mouse modifier clicks open a new tab without an opener.
import type { IBufferLine, ILink, ILinkHandler, Terminal } from '@xterm/xterm'

const URL_RE = /https?:\/\/[^\s"'<>`─-▟]+/g
const BORDER_RE = /[─-▟|]/
const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

// Only http(s), normalized; anything else (javascript:, file:, data:…) is refused.
export function safeLinkUrl(uri: string): string | null {
  let u: URL
  try { u = new URL(uri.trim()) }
  catch { return null }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null
}

// Row `row` goes on in `next` (both one character per cell, see rowText).
export function rowContinues(row: string, next: string): boolean {
  const last = row[row.length - 1]
  const first = next[0]
  return !!last && !!first && last !== ' ' && first !== ' ' && !BORDER_RE.test(last) && !BORDER_RE.test(first)
}

// Trailing punctuation belongs to the sentence, not to the URL; a closing
// bracket stays when the URL opened it (Wikipedia-style links).
function trimUrl(url: string): string {
  for (;;) {
    const c = url[url.length - 1]!
    if ('.,;:!?\'"'.includes(c)) url = url.slice(0, -1)
    else if (CLOSERS[c] && url.split(CLOSERS[c]!).length <= url.split(c).length - 1) url = url.slice(0, -1)
    else return url
  }
}

export function findUrls(text: string): { start: number, end: number, url: string }[] {
  const out: { start: number, end: number, url: string }[] = []
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0])
    if (safeLinkUrl(url) && url.length > 'https://'.length) out.push({ start: m.index!, end: m.index! + url.length, url })
  }
  return out
}

// URLs of the logical line through row `y` (0-based): ranges in rows and
// columns, 0-based, end column exclusive.
export interface RowLink { url: string, start: { row: number, col: number }, end: { row: number, col: number } }

export function linksAtRow(rows: string[], y: number, wrapped: (y: number) => boolean = () => false): RowLink[] {
  if (!rows[y]) return []
  const goesOn = (r: number) => wrapped(r + 1) || rowContinues(rows[r]!, rows[r + 1] ?? '')
  let first = y
  while (first > 0 && goesOn(first - 1)) first--
  let last = y
  while (last < rows.length - 1 && goesOn(last)) last++
  const offsets: number[] = []
  let text = ''
  for (let r = first; r <= last; r++) {
    offsets.push(text.length)
    text += rows[r]
  }
  const at = (i: number) => {
    let r = offsets.length - 1
    while (r > 0 && offsets[r]! > i) r--
    return { row: first + r, col: i - offsets[r]! }
  }
  return findUrls(text)
    .map(u => ({ url: u.url, start: at(u.start), end: at(u.end - 1) }))
    .filter(l => l.start.row <= y && l.end.row >= y)
    .map(l => ({ ...l, end: { row: l.end.row, col: l.end.col + 1 } }))
}

// One character per cell, so that an index is a column: the (empty) second
// half of a wide character, and a cell of several UTF-16 units (emoji,
// combining marks), count as a blank (a URL never contains them).
export function rowText(line: IBufferLine | undefined, cols: number): string {
  let s = ''
  for (let x = 0; x < cols; x++) {
    const c = line?.getCell(x)?.getChars() || ' '
    s += c.length === 1 ? c : ' '
  }
  return s
}

export function screenRows(term: Terminal): string[] {
  const buf = term.buffer.active
  const rows: string[] = []
  for (let y = 0; y < buf.length; y++) rows.push(rowText(buf.getLine(y), term.cols))
  return rows
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
const finePointer = () => typeof matchMedia !== 'undefined' && matchMedia('(hover: hover) and (pointer: fine)').matches

// With a mouse, ⌘ (Mac) or Ctrl must be held; a touch screen opens on tap.
export function linkClickAllowed(e: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>, mouse: boolean, mac: boolean): boolean {
  return !mouse || (mac ? e.metaKey : e.ctrlKey)
}

export function openTerminalLink(uri: string): boolean {
  const url = safeLinkUrl(uri)
  if (!url) return false
  const destination = new URL(url)
  if (!finePointer() && destination.origin === window.location.origin) {
    // Hash routes belong to this SPA. A root link also stays in this document
    // instead of opening Chrome again or reloading the terminal's whole app.
    if (destination.pathname === window.location.pathname && destination.search === window.location.search) {
      window.location.hash = destination.hash || '#/'
    } else window.location.assign(url)
  } else window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

export interface TerminalLinks {
  // Tap on a touch screen (layer above xterm): opens the link under the
  // finger, if any. Returns true when a link was opened.
  tap: (clientX: number, clientY: number) => boolean
  dispose: () => void
}

// Link options and provider of a terminal. `tr` translates the tooltip
// shown while hovering a link with a mouse.
export function bindTerminalLinks(term: Terminal, tr: (en: string) => string): TerminalLinks {
  const mac = isMac()
  const mouse = finePointer()
  const hint = (url: string) => `${url}\n${tr(mac ? '⌘+click to open' : 'Ctrl+click to open')}`
  let opened = false
  const activate = (e: MouseEvent, uri: string) => {
    if (linkClickAllowed(e, mouse, mac)) opened = openTerminalLink(uri) || opened
  }
  const screen = () => term.element?.querySelector('.xterm-screen') as HTMLElement | null
  const hover = (_e: MouseEvent, uri: string) => {
    const el = screen()
    if (el && mouse && safeLinkUrl(uri)) el.title = hint(uri)
  }
  const leave = () => {
    const el = screen()
    if (el) el.removeAttribute('title')
  }
  const handler: ILinkHandler = { activate, hover, leave, allowNonHttpProtocols: false }
  term.options.linkHandler = handler
  const provider = term.registerLinkProvider({
    provideLinks(lineNumber, callback) {
      const rows = screenRows(term)
      const buf = term.buffer.active
      const links = linksAtRow(rows, lineNumber - 1, y => !!buf.getLine(y)?.isWrapped)
      callback(links.length
        ? links.map<ILink>(l => ({
            text: l.url,
            range: { start: { x: l.start.col + 1, y: l.start.row + 1 }, end: { x: l.end.col, y: l.end.row + 1 } },
            activate: e => activate(e, l.url),
            hover: e => hover(e, l.url),
            leave,
          }))
        : undefined)
    },
  })
  // xterm finds links from the mouse (OSC 8 and ours alike): the tap is
  // replayed as a move, a press and a release at the same point.
  const tap = (clientX: number, clientY: number) => {
    const el = screen()
    if (!el) return false
    opened = false
    const init: MouseEventInit = { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 }
    for (const type of ['mousemove', 'mousedown', 'mouseup']) el.dispatchEvent(new MouseEvent(type, { ...init, buttons: type === 'mousedown' ? 1 : 0 }))
    term.element?.dispatchEvent(new MouseEvent('mouseleave', init))
    term.clearSelection()
    return opened
  }
  return {
    tap,
    dispose() {
      provider.dispose()
      leave()
    },
  }
}
