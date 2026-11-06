import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { stepAgent, stepTab } from '../../app/utils/stepNav'

// The Alt+arrow helpers click a card/chip in DOM order and always consume the
// key — even at the ends or with nothing to step to — because a loose
// Alt+←/→ would reach the browser as Back/Forward.

const scrollIntoView = Element.prototype.scrollIntoView
const scrollSpy = vi.fn()
Element.prototype.scrollIntoView = scrollSpy as never
afterAll(() => { Element.prototype.scrollIntoView = scrollIntoView })

function cards(specs: { sel?: boolean, hidden?: boolean }[], home = true): HTMLElement[] {
  const wrap = document.createElement('div')
  if (home) wrap.id = 'home'
  document.body.appendChild(wrap)
  return specs.map(({ sel, hidden }, i) => {
    const el = document.createElement('div')
    el.className = `card${sel ? ' sel' : ''}`
    el.dataset.pane = `pane-${i}`
    if (hidden) el.setAttribute('hidden', '')
    wrap.appendChild(el)
    return el
  })
}

function chips(n: number, current?: number): { nav: HTMLElement, list: HTMLElement[] } {
  const nav = document.createElement('nav')
  nav.className = 'space-tabs'
  document.body.appendChild(nav)
  const list = Array.from({ length: n }, (_, i) => {
    const el = document.createElement('button')
    el.className = 'tab-chip'
    el.dataset.tab = `t${i}`
    if (i === current) el.setAttribute('aria-current', 'page')
    nav.appendChild(el)
    return el
  })
  return { nav, list }
}

const clicked = (el: HTMLElement) => {
  const spy = vi.fn()
  el.addEventListener('click', spy)
  return spy
}

afterEach(() => {
  document.body.innerHTML = ''
  scrollSpy.mockClear()
})

describe('stepAgent', () => {
  it('clicks the next card in shown order, scrolls it into view', () => {
    const [a, b, c] = cards([{ sel: true }, {}, {}])
    const ca = clicked(a!), cb = clicked(b!), cc = clicked(c!)
    expect(stepAgent(1)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(ca).not.toHaveBeenCalled()
    expect(cc).not.toHaveBeenCalled()
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    // The route followed the click: card b is the selected one now.
    a!.classList.remove('sel')
    b!.classList.add('sel')
    expect(stepAgent(-1)).toBe(true)
    expect(ca).toHaveBeenCalledTimes(1)
    expect(scrollSpy).toHaveBeenCalledTimes(2)
  })

  it('nothing selected: down starts at the first card, up at the last', () => {
    const [a, , c] = cards([{}, {}, {}])
    const ca = clicked(a!), cc = clicked(c!)
    expect(stepAgent(1)).toBe(true)
    expect(ca).toHaveBeenCalledTimes(1)
    expect(stepAgent(-1)).toBe(true)
    expect(cc).toHaveBeenCalledTimes(1)
  })

  it('stops at both ends and still consumes the key', () => {
    const [a] = cards([{ sel: true }])
    const spy = clicked(a!)
    expect(stepAgent(1)).toBe(true)
    expect(stepAgent(-1)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('no cards at all: still consumed (browser Back/Forward would fire)', () => {
    expect(stepAgent(1)).toBe(true)
    expect(stepAgent(-1)).toBe(true)
  })

  it('cards hidden by the rail stay targets; collapsed sections render none', () => {
    const [a, b] = cards([{ sel: true }, { hidden: true }])
    const cb = clicked(b!)
    expect(stepAgent(1)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('only the home list: cards of another container are not stepped', () => {
    const [a] = cards([{ sel: true }])
    cards([{}, {}], false)
    const spy = clicked(a!)
    expect(stepAgent(1)).toBe(true)
    expect(stepAgent(-1)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('stepTab', () => {
  it('clicks the next chip of the current tab strip, in shown order', () => {
    const { list } = chips(3, 0)
    const [ca, cb, cc] = list.map(clicked)
    expect(stepTab(1)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    // The route followed the click: chip 1 is the current one now.
    list[0]!.removeAttribute('aria-current')
    list[1]!.setAttribute('aria-current', 'page')
    expect(stepTab(1)).toBe(true)
    expect(cc).toHaveBeenCalledTimes(1)
    expect(ca).not.toHaveBeenCalled()
  })

  it('no chip marked current: forward starts at the first, backward at the last', () => {
    const { list } = chips(3)
    const [ca, , cc] = list.map(clicked)
    expect(stepTab(1)).toBe(true)
    expect(ca).toHaveBeenCalledTimes(1)
    expect(stepTab(-1)).toBe(true)
    expect(cc).toHaveBeenCalledTimes(1)
  })

  it('stops at both ends and still consumes the key', () => {
    const { list } = chips(2, 0)
    const [ca, cb] = list.map(clicked)
    expect(stepTab(-1)).toBe(true)
    expect(ca).not.toHaveBeenCalled()
    expect(stepTab(1)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    // The route followed the click: chip 1 is the current one now.
    list[0]!.removeAttribute('aria-current')
    list[1]!.setAttribute('aria-current', 'page')
    expect(stepTab(1)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('no chips at all: still consumed', () => {
    expect(stepTab(1)).toBe(true)
    expect(stepTab(-1)).toBe(true)
  })

  it('the + button and stray chips of another strip are not targets', () => {
    const { nav, list } = chips(2, 0)
    const add = document.createElement('button')
    add.className = 'tab-chip tab-add'
    nav.appendChild(add)
    // A second strip without a current chip (e.g. a stale view): the marked one wins.
    const { list: other } = chips(2)
    const cAdd = clicked(add)
    const cOther = other.map(clicked)
    const [ca, cb] = list.map(clicked)
    expect(stepTab(1)).toBe(true)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cAdd).not.toHaveBeenCalled()
    for (const spy of cOther) expect(spy).not.toHaveBeenCalled()
    // The route followed the click; at the last chip the key is consumed,
    // not passed to the stale strip.
    list[0]!.removeAttribute('aria-current')
    list[1]!.setAttribute('aria-current', 'page')
    expect(stepTab(1)).toBe(true)
    for (const spy of cOther) expect(spy).not.toHaveBeenCalled()
    expect(ca).not.toHaveBeenCalled()
  })
})
