// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { attachQuoteMirror, mirrorLines } from '../app/utils/quoteMirror'

describe('mirrorLines', () => {
  it('keeps every character of every line, in order (the mirror wraps like the field)', () => {
    const draft = '↳ Quote point 11:37 : Tea or coffee? —\nCoffee.\n\n↳ Quote message 11:35 : And your favorite series? —  \nLost!\n> typed\n'
    expect(mirrorLines(draft).map(l => l.head + l.text + l.tail).join('\n')).toBe(draft)
  })
  it('splits a reference line into what introduces it, its excerpt and its closing dash', () => {
    expect(mirrorLines('↳ Quote decision 11:37 #3 : Publish — today? —\nYes\n↳ Décision : Publier ? —').map(l => [l.ref, l.head, l.text, l.tail])).toEqual([
      [true, '↳ Quote decision 11:37 #3 : ', 'Publish — today?', ' —'],
      [false, '', 'Yes', ''],
      [true, '↳ Décision : ', 'Publier ?', ' —'],
    ])
  })
  it('draws nothing else as a token: ">" lines, lookalikes, a reference off the first column', () => {
    expect(mirrorLines('> a quote typed by hand\n>>>\n↳ note —\n\\↳ Quote point 11:37 : pasted —\n↳ Quote point 11:37 : answered — yes').every(l => !l.ref)).toBe(true)
  })
})

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(f => f()) })

function field(value: string) {
  const host = document.createElement('div')
  const ta = document.createElement('textarea')
  ta.value = value
  host.append(ta)
  document.body.append(host)
  const m = attachQuoteMirror(ta)
  cleanup.push(() => { m.destroy(); host.remove() })
  return { host, ta, m, rows: () => [...host.querySelectorAll('.qm-mirror > div > div')] as HTMLElement[] }
}

const Q1 = '↳ Quote point 11:37 : Tea or coffee? —'
const Q2 = '↳ Quote decision 11:37 #2 : And your series? —'

describe('attachQuoteMirror (native field)', () => {
  it('draws one row per line, the reference lines as tokens, behind an unchanged field', () => {
    const draft = `${Q1}\nCoffee.\n${Q2}\nLost!\n> typed`
    const { ta, host, rows } = field(draft)
    expect(rows().map(r => r.className)).toEqual(['qm-q', '', 'qm-q', '', ''])
    // The same characters as the field, in the same order: the lines wrap alike.
    expect(rows().map(r => r.textContent)).toEqual([Q1, 'Coffee.', Q2, 'Lost!', '> typed'])
    expect([...rows()[2]!.children].map(c => [c.className, c.textContent])).toEqual([['qm-a', '↳'], ['qm-h', ' Quote decision 11:37 #2 : '], ['qm-h', ' —']])
    expect(host.firstElementChild?.className).toBe('qm-mirror')
    expect(ta.classList.contains('qm-on')).toBe(true)
    // What is sent is the field's text: the mirror never touches it.
    expect(ta.value).toBe(draft)
  })

  it('follows typing and text set from script', () => {
    const { ta, m, rows } = field(`${Q1}\n`)
    expect(rows()).toHaveLength(2)
    ta.value = `${Q1}\nA\n${Q2}\nB`
    ta.dispatchEvent(new Event('input'))
    expect(rows().filter(r => r.classList.contains('qm-q'))).toHaveLength(2)
    // The line stops being a token as soon as words follow its dash.
    ta.value = `${Q1} yes`
    ta.dispatchEvent(new Event('input'))
    expect(rows().map(r => r.className)).toEqual([''])
    ta.value = 'plain'
    m.render()
    expect(rows().map(r => r.className)).toEqual([''])
  })

  it('leaves the field as it was once destroyed', () => {
    const { ta, host, m } = field(`${Q1}\nA`)
    m.destroy()
    expect(host.querySelector('.qm-mirror')).toBeNull()
    expect(ta.classList.contains('qm-on')).toBe(false)
    expect(host.classList.contains('qm-host')).toBe(false)
  })
})
