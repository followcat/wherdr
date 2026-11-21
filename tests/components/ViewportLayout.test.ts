import { afterEach, describe, expect, it, vi } from 'vitest'
import { kbOpen, layout, layoutTick, vvHeight, vvTop } from '~/composables/useViewport'

// Every visualViewport resize/scroll and every window resize runs layout(): the
// same geometry again (the scroll iOS fires while nothing moved) must write
// nothing — three inherited custom properties and a body class restyle the
// whole tree, and the terminal refits on layoutTick.
describe('viewport layout dedupe', () => {
  const vp = { height: 1000, offsetTop: 0 }
  const dims = (w: number, h: number) => {
    vi.stubGlobal('innerWidth', w)
    vi.stubGlobal('innerHeight', h)
    vp.height = h
    layout()
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.classList.remove('kb')
    for (const p of ['--vv-h', '--vv-top', '--vv-bottom']) document.documentElement.style.removeProperty(p)
  })

  it('repeats write nothing, and a real change still writes it all', () => {
    vi.stubGlobal('visualViewport', vp)
    vi.stubGlobal('screen', { width: 820, height: 1180 })
    dims(744, 1000)
    expect(vvHeight.value).toBe(1000)
    expect(vvTop.value).toBe(0)
    expect(document.documentElement.style.getPropertyValue('--vv-h')).toBe('1000px')
    // The same geometry again, five times over: not one more write.
    const tick = layoutTick.value
    for (let i = 0; i < 5; i++) layout()
    expect(layoutTick.value).toBe(tick)
    // The keyboard opens: one tick, the body class, the new height.
    dims(744, 800)
    expect(layoutTick.value).toBe(tick + 1)
    expect(kbOpen.value).toBe(true)
    expect(document.body.classList.contains('kb')).toBe(true)
    expect(document.documentElement.style.getPropertyValue('--vv-h')).toBe('800px')
    // Closed again: one more tick.
    dims(744, 1000)
    expect(layoutTick.value).toBe(tick + 2)
    expect(kbOpen.value).toBe(false)
    expect(document.body.classList.contains('kb')).toBe(false)
  })

  it('an innerHeight move that only shifts the sheet bottom is still written', () => {
    vi.stubGlobal('visualViewport', vp)
    vi.stubGlobal('screen', { width: 820, height: 1180 })
    dims(744, 1000)
    const tick = layoutTick.value
    // The layout viewport grows under an unchanged visual viewport: --vv-bottom
    // follows it (the page stops above the screen's bottom edge).
    vi.stubGlobal('innerWidth', 744)
    vi.stubGlobal('innerHeight', 1100)
    layout()
    expect(layoutTick.value).toBe(tick + 1)
    expect(document.documentElement.style.getPropertyValue('--vv-bottom')).toBe('100px')
    // The same geometry again: nothing.
    layout()
    expect(layoutTick.value).toBe(tick + 1)
  })
})
