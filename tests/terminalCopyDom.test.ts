// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyNativeSelection, selectedCopyText } from '../app/utils/terminalCopy'

// The future copy layer renders each snapshot row as spans inside a <pre>,
// with '\n' text nodes between rows; the fixture mirrors that so ranges keep
// hard newlines. `tools` (before) and `after` (past) stand in for the layer's
// controls and the rest of the page, which must never be copied.
function layer() {
  document.body.innerHTML = ''
  const tools = document.createElement('div')
  tools.textContent = 'Copy Done'
  const pre = document.createElement('pre')
  for (const [i, l] of ['first  line  ', '  indented', '', 'last row   '].entries()) {
    if (i) pre.append('\n')
    const s = document.createElement('span')
    s.textContent = l
    pre.append(s)
  }
  const after = document.createElement('div')
  after.textContent = 'outside chrome'
  document.body.append(tools, pre, after)
  return { root: pre, tools, after }
}

const sel = () => document.getSelection()!
const textOf = (root: HTMLElement, i: number) => root.querySelectorAll('span')[i]!.firstChild as Text

function select(start: { node: Node, offset: number }, end: { node: Node, offset: number }): Range {
  const r = document.createRange()
  r.setStart(start.node, start.offset)
  r.setEnd(end.node, end.offset)
  sel().removeAllRanges()
  sel().addRange(r)
  return r
}

describe('text of the selection inside the frozen snapshot', () => {
  it('is empty with no, a collapsed or an unrelated selection', () => {
    const { root, tools } = layer()
    expect(selectedCopyText(root)).toBe('')
    sel().collapse(textOf(root, 0), 2)
    expect(selectedCopyText(root)).toBe('')
    select({ node: tools.firstChild!, offset: 0 }, { node: tools.firstChild!, offset: 4 })
    expect(selectedCopyText(root)).toBe('')
  })

  it('copies the selected part, trailing blanks trimmed like existing helpers', () => {
    const { root } = layer()
    select({ node: textOf(root, 0), offset: 7 }, { node: textOf(root, 0), offset: 13 })
    expect(selectedCopyText(root)).toBe('line')
  })

  it('keeps hard newlines and blank rows of the snapshot', () => {
    const { root } = layer()
    select({ node: textOf(root, 0), offset: 0 }, { node: textOf(root, 3), offset: 11 })
    expect(selectedCopyText(root)).toBe('first  line\n  indented\n\nlast row')
  })

  it('clips a range crossing the root edges; Select all yields only snapshot text', () => {
    const { root, tools } = layer()
    select({ node: tools.firstChild!, offset: 0 }, { node: textOf(root, 1), offset: 4 })
    expect(selectedCopyText(root)).toBe('first  line\n  in')
    sel().selectAllChildren(document.body)
    expect(selectedCopyText(root)).toBe('first  line\n  indented\n\nlast row')
  })

  it('joins the ranges of one selection with newlines', () => {
    const { root } = layer()
    const r1 = document.createRange()
    r1.setStart(textOf(root, 0), 0); r1.setEnd(textOf(root, 0), 13)
    const r2 = document.createRange()
    r2.setStart(textOf(root, 3), 0); r2.setEnd(textOf(root, 3), 11)
    const multi = {
      rangeCount: 2, isCollapsed: false,
      getRangeAt: (i: number) => [r1, r2][i]!,
    } as unknown as Selection
    expect(selectedCopyText(root, multi)).toBe('first  line\nlast row')
  })

  it('never rewrites the live selection or its ranges', () => {
    const { root } = layer()
    const r = select({ node: textOf(root, 0), offset: 0 }, { node: textOf(root, 1), offset: 4 })
    const before = r.cloneRange()
    const s = sel()
    const add = vi.spyOn(s, 'addRange')
    const clear = vi.spyOn(s, 'removeAllRanges')
    expect(selectedCopyText(root)).toBe('first  line\n  in')
    expect(add).not.toHaveBeenCalled()
    expect(clear).not.toHaveBeenCalled()
    expect(s.rangeCount).toBe(1)
    expect(s.getRangeAt(0)).toBe(r)
    expect(r.compareBoundaryPoints(r.START_TO_START, before)).toBe(0)
    expect(r.compareBoundaryPoints(r.END_TO_END, before)).toBe(0)
  })
})

describe('copy through the native selection', () => {
  let exec: ReturnType<typeof vi.fn>
  beforeEach(() => {
    exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, writable: true, value: exec })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    Reflect.deleteProperty(document, 'execCommand')
    Reflect.deleteProperty(navigator, 'clipboard')
  })

  it('writes through the Clipboard API synchronously, inside the caller\'s gesture', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const still = vi.fn(() => false)
    const done = copyNativeSelection('hello', still)
    // Called before any await: the button press still counts as a gesture.
    expect(writeText).toHaveBeenCalledWith('hello')
    await expect(done).resolves.toBe(true)
    expect(exec).not.toHaveBeenCalled()
    // A resolved write is already copied: no selection-lifetime check.
    expect(still).not.toHaveBeenCalled()
  })

  it('does nothing for empty text', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const still = vi.fn()
    expect(await copyNativeSelection('', still)).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(still).not.toHaveBeenCalled()
  })

  it('falls back to the existing native selection when the API write is refused', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    expect(await copyNativeSelection('hello', () => true)).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('uses the selection fallback when the Clipboard API is absent', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    expect(await copyNativeSelection('hello', () => true)).toBe(true)
    expect(exec).toHaveBeenCalledWith('copy')
  })

  it('runs no stale fallback when the selection changed during a failed write', async () => {
    let selected = true
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async () => {
      selected = false // layer closed or selection replaced while awaiting
      throw new Error('denied')
    })
    expect(await copyNativeSelection('hello', () => selected)).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('reports a refused fallback as false and never throws', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    exec.mockReturnValue(false)
    expect(await copyNativeSelection('hello', () => true)).toBe(false)
    exec.mockImplementation(() => { throw new Error('no copy') })
    expect(await copyNativeSelection('hello', () => true)).toBe(false)
  })
})
