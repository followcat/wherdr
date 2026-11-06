import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import TerminalCopyLayer from '~/components/TerminalCopyLayer.vue'
import type { TerminalCopySnapshot } from '~/utils/terminalCopy'

// The frozen snapshot surface: literal styled text, a scoped Copy, Done, and
// native selection preserved when the clipboard refuses.
beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

const snapshot: TerminalCopySnapshot = {
  lines: [
    [{ text: 'hello ' }, { text: '<b>world</b>', color: '#ff0000', bold: true }],
    [{ text: '  indented', italic: true, underline: true }],
    [{ text: '' }],
    [{ text: 'last', dim: true, strike: true }],
  ],
  columns: 12,
  fontFamily: 'JetBrains Mono',
  fontSize: 13,
}
const metrics = { fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', lineHeight: '16px', letterSpacing: '0px', color: 'rgb(238, 238, 238)', width: '120px' }

// Every mounted layer is tracked: a test that mounts a second wrapper must
// not leave the first one's document listeners alive across later tests.
const wrappers = new Set<{ unmount(): void }>()
async function mounted() {
  const w = await mountSuspended(TerminalCopyLayer, {
    props: { snapshot, metrics },
    attachTo: document.body,
  })
  wrappers.add(w)
  return w
}
const pre = (w: Awaited<ReturnType<typeof mounted>>) => w.get('.terminal-copy-text').element as HTMLElement
const copyButton = (w: Awaited<ReturnType<typeof mounted>>) => w.findAll('button').find(b => ['Copy', 'Copied'].includes(b.text()))!

function selectAllIn(root: HTMLElement) {
  const sel = document.getSelection()!
  sel.removeAllRanges()
  const r = document.createRange()
  r.selectNodeContents(root.querySelector('span')!)
  sel.addRange(r)
  document.dispatchEvent(new Event('selectionchange'))
}

afterEach(() => {
  for (const w of wrappers) w.unmount()
  wrappers.clear()
  document.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
  Reflect.deleteProperty(document, 'execCommand')
})

describe('frozen copy layer', () => {
  it('renders the snapshot as literal styled text, never HTML', async () => {
    const w = await mounted()
    const el = pre(w)
    expect(el.textContent).toBe('hello <b>world</b>\n  indented\n\nlast')
    // A hostile string stays text: no <b> element exists inside the surface.
    expect(el.querySelector('b')).toBeNull()
    const spans = w.findAll('.terminal-copy-text span')
    expect(spans[1]!.attributes('style')).toContain('#ff0000')
    expect(spans[1]!.attributes('style')).toContain('font-weight: 600')
    expect(spans[3]!.attributes('style')).toContain('font-style: italic')
    expect(spans[3]!.attributes('style')).toContain('underline')
    expect(spans[7]!.attributes('style')).toContain('line-through')
    expect(el.getAttribute('style')).toContain('JetBrains Mono')
  })

  it('shows translated controls, hint and live status', async () => {
    const w = await mounted()
    expect(copyButton(w).text()).toBe('Copy')
    expect(w.findAll('button').some(b => b.text() === 'Done')).toBe(true)
    expect(w.get('.terminal-copy-hint').text()).toBe('Hold text to select')
    expect(w.get('[role="status"]').text()).toContain('Screen frozen')
  })

  it('copies the scoped native selection through the Clipboard API', async () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const w = await mounted()
    const copy = copyButton(w)
    expect(copy.attributes('disabled')).toBeDefined()
    selectAllIn(pre(w))
    await nextTick()
    expect(copyButton(w).attributes('disabled')).toBeUndefined()
    await copyButton(w).trigger('click')
    expect(writeText).toHaveBeenCalledWith('hello')
    await nextTick()
    expect(copyButton(w).text()).toBe('Copied')
    expect(w.get('[role="status"]').text()).toContain('Copied')
  })

  it('reports a refused copy and keeps the selection for the system menu', async () => {
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'))
    const exec = vi.fn(() => false)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    const w = await mounted()
    selectAllIn(pre(w))
    await nextTick()
    await copyButton(w).trigger('click')
    await vi.waitFor(() => expect(w.find('.terminal-copy-error').exists()).toBe(true))
    expect(w.get('.terminal-copy-error').text()).toContain('Copy failed')
    // The native selection survives so Android's own Copy menu still works.
    expect(document.getSelection()!.rangeCount).toBe(1)
    expect(document.getSelection()!.isCollapsed).toBe(false)
  })

  it('ignores a stale async refusal completing after the layer closed', async () => {
    let reject!: (e: Error) => void
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(() => new Promise((_, r) => { reject = r }))
    const exec = vi.fn(() => true)
    Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
    const w = await mounted()
    selectAllIn(pre(w))
    await nextTick()
    await copyButton(w).trigger('click')
    w.unmount()
    wrappers.delete(w)
    reject(new Error('denied'))
    await Promise.resolve()
    await nextTick()
    // No stale fallback on the selection of a dead layer.
    expect(exec).not.toHaveBeenCalled()
  })

  it('exits on Escape and on Done, without refocusing anything', async () => {
    const w = await mounted()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }))
    expect(w.emitted('close')).toHaveLength(1)
    const w2 = await mounted()
    await w2.findAll('button').find(b => b.text() === 'Done')!.trigger('click')
    expect(w2.emitted('close')).toHaveLength(1)
  })

  it('writes the scoped selection to the system copy event, only while one exists', async () => {
    const w = await mounted()
    selectAllIn(pre(w))
    await nextTick()
    const setData = vi.fn()
    const ev = new Event('copy', { cancelable: true }) as ClipboardEvent
    Object.defineProperty(ev, 'clipboardData', { value: { setData } })
    document.dispatchEvent(ev)
    expect(setData).toHaveBeenCalledWith('text/plain', 'hello')
    expect(ev.defaultPrevented).toBe(true)
    // A copy with no scoped selection is left to whatever the event targets.
    document.getSelection()!.removeAllRanges()
    document.dispatchEvent(new Event('selectionchange'))
    const ev2 = new Event('copy', { cancelable: true }) as ClipboardEvent
    const setData2 = vi.fn()
    Object.defineProperty(ev2, 'clipboardData', { value: { setData: setData2 } })
    document.dispatchEvent(ev2)
    expect(setData2).not.toHaveBeenCalled()
    expect(ev2.defaultPrevented).toBe(false)
  })

  it('ignores Escape while an IME composition is in flight', async () => {
    const w = await mounted()
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
    Object.defineProperty(e, 'isComposing', { value: true })
    document.body.dispatchEvent(e)
    expect(w.emitted('close')).toBeUndefined()
  })

  it('releases its listeners and the native selection on unmount', async () => {
    const w = await mounted()
    selectAllIn(pre(w))
    await nextTick()
    expect(document.getSelection()!.rangeCount).toBe(1)
    w.unmount()
    wrappers.delete(w)
    expect(document.getSelection()!.rangeCount).toBe(0)
    // Dead listeners: nothing reacts any more.
    document.dispatchEvent(new Event('selectionchange'))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(w.emitted('close')).toBeUndefined()
  })
})
