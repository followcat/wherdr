// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { stepAgent, stepTab } from '../app/utils/stepNav'

function tabs(labels: string[], current: number) {
  document.body.innerHTML = `<div class="space-tabs">${
    labels.map((l, i) => `<div class="tab-chip" data-tab="${l}"${i === current ? ' aria-current="page"' : ''}></div>`).join('')
  }</div>`
  return [...document.querySelectorAll<HTMLElement>('.tab-chip')]
}

function cards(n: number, sel: number) {
  document.body.innerHTML = `<div id="home">${
    Array.from({ length: n }, (_, i) => `<div class="card${i === sel ? ' sel' : ''}" data-pane="p${i}"></div>`).join('')
  }</div>`
  return [...document.querySelectorAll<HTMLElement>('.card')]
}

const clicks: string[] = []
document.body.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  clicks.push(el.dataset.tab ?? el.dataset.pane ?? '?')
})
function watchClicks() { clicks.length = 0 }

describe('stepTab', () => {
  it('clicks the next chip after aria-current, and the previous one', () => {
    watchClicks()
    const chips = tabs(['a', 'b', 'c'], 1)
    expect(stepTab(1)).toBe(true)
    expect(clicks).toEqual(['c'])
    chips[2]!.setAttribute('aria-current', 'page')
    chips[1]!.removeAttribute('aria-current')
    expect(stepTab(-1)).toBe(true)
    expect(clicks).toEqual(['c', 'b'])
  })

  it('at the end nothing is clicked but the key is taken', () => {
    watchClicks()
    tabs(['a', 'b'], 1)
    expect(stepTab(1)).toBe(true)
    expect(clicks).toEqual([])
  })

  it('no chips at all: still true — Alt+←/→ must not reach the browser', () => {
    document.body.innerHTML = '<main></main>'
    expect(stepTab(1)).toBe(true)
    expect(stepTab(-1)).toBe(true)
  })

  it('no chip marked: down starts at the first, up at the last', () => {
    watchClicks()
    tabs(['a', 'b', 'c'], -1)
    expect(stepTab(1)).toBe(true)
    expect(clicks).toEqual(['a'])
    expect(stepTab(-1)).toBe(true)
    expect(clicks).toEqual(['a', 'c'])
  })
})

describe('stepAgent', () => {
  it('steps down from the selected card and back up', () => {
    watchClicks()
    cards(3, 1)
    expect(stepAgent(1)).toBe(true)
    expect(clicks).toEqual(['p2'])
    cards(3, 1)
    expect(stepAgent(-1)).toBe(true)
    expect(clicks).toEqual(['p2', 'p0'])
  })

  it('no cards: still true — the navigation key stays wherdr’s', () => {
    document.body.innerHTML = '<main></main>'
    expect(stepAgent(1)).toBe(true)
  })
})
