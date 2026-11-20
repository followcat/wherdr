// WHR-496: dragging a divider of wherdr's split tree writes once on release, double-click resets.
import { expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SplitDividers from '~/components/SplitDividers.vue'
import type { Divider } from '#shared/splitTree'

// A right split at 50 % across an 800×400 area.
const d: Divider = { path: '', direction: 'right', ratio: 0.5, at: 50, from: 0, span: 100, start: 0, size: 100 }
function mountIn() {
  const w = mount(SplitDividers, { props: { dividers: [d] }, attachTo: document.body })
  w.get('.divider').element.parentElement!.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 400, right: 800, bottom: 400, x: 0, y: 0, toJSON: () => ({}) })
  return w
}
const pointer = (type: string, clientX: number) => new PointerEvent(type, { pointerId: 1, button: 0, clientX, bubbles: true })

it('previews while dragging and writes the bounded ratio once, on release', async () => {
  const w = mountIn()
  const el = w.get('.divider').element
  el.dispatchEvent(pointer('pointerdown', 400))
  el.dispatchEvent(pointer('pointermove', 600))
  el.dispatchEvent(pointer('pointermove', 790))
  expect(w.emitted('resize')).toBeUndefined()
  expect(w.emitted('preview')).toEqual([['', 0.75], ['', 0.85]])
  el.dispatchEvent(pointer('pointerup', 790))
  expect(w.emitted('resize')).toEqual([['', 0.85]])
  expect(w.emitted('preview')!.at(-1)).toEqual(['', null])
  w.unmount()
})

it('a click without moving writes nothing; a double-click goes back to 50/50', async () => {
  const w = mountIn()
  const el = w.get('.divider').element
  el.dispatchEvent(pointer('pointerdown', 400))
  el.dispatchEvent(pointer('pointerup', 400))
  expect(w.emitted('resize')).toBeUndefined()
  await w.setProps({ dividers: [{ ...d, ratio: 0.3, at: 30 }] })
  await w.get('.divider').trigger('dblclick')
  expect(w.emitted('resize')).toEqual([['', 0.5]])
  w.unmount()
})
