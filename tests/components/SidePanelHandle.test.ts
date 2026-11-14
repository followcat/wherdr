import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SidePanelHandle from '~/components/SidePanelHandle.vue'

// A 1440 px window, list right edge at 340 px, panel 500 px wide: the panel
// may grow to 1440 - 340 - 480 = 620 px and shrink to 400 px.
function stage() {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 })
  const box = (id: string, rect: Partial<DOMRect>) => {
    const el = document.createElement('section')
    el.id = id
    el.getBoundingClientRect = () => rect as DOMRect
    document.body.append(el)
  }
  box('home', { right: 340, width: 340 })
  box('settings', { width: 500 })
}
const cssWidth = () => document.documentElement.style.getPropertyValue('--settings-panel')
const handle = () => document.querySelector<HTMLElement>('.panel-handle')!
function drag(dx: number) {
  const el = handle()
  el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 900, bubbles: true }))
  el.dispatchEvent(new PointerEvent('pointermove', { clientX: 900 + dx }))
  el.dispatchEvent(new PointerEvent('pointerup', {}))
}

afterEach(() => {
  for (const id of ['home', 'settings']) document.getElementById(id)?.remove()
  localStorage.clear()
  document.documentElement.style.removeProperty('--settings-panel')
})

it('drags within its limits, double-click resets, the width comes back on mount', async () => {
  stage()
  localStorage.setItem('sidePanelWidth', '520')
  let wrapper = await mountSuspended(SidePanelHandle)
  expect(cssWidth()).toContain('520px')

  drag(-60) // left edge moved left: wider
  await wrapper.vm.$nextTick()
  expect(localStorage.getItem('sidePanelWidth')).toBe('560')
  drag(-1000)
  expect(localStorage.getItem('sidePanelWidth')).toBe('620')
  drag(1000)
  expect(localStorage.getItem('sidePanelWidth')).toBe('400')

  handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
  expect(localStorage.getItem('sidePanelWidth')).toBe('516') // measured 500 + 16

  handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  await wrapper.vm.$nextTick()
  expect(localStorage.getItem('sidePanelWidth')).toBeNull()
  expect(cssWidth()).toBe('')

  wrapper.unmount()
  localStorage.setItem('sidePanelWidth', '600')
  wrapper = await mountSuspended(SidePanelHandle)
  expect(cssWidth()).toContain('600px')
  wrapper.unmount()
})
