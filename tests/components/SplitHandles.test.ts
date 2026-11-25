// WHR-560: wherdr's split tree drawn as nested USplitters: arrows and double-click write the tree.
import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import SplitHandles from '~/components/SplitHandles.vue'
import type { SplitNode } from '#shared/splitTree'

// x | (y over z): the root splits right at 50 %, its right side down at 30 %.
const node: SplitNode = { dir: 'right', ratio: 0.5, a: 'x', b: { dir: 'down', ratio: 0.3, a: 'y', b: 'z' } }
const flush = () => new Promise(r => setTimeout(r, 0))

it('a handle per split, labelled; arrows move it by 5 %, double-click goes back to 50/50', async () => {
  const w = await mountSuspended(SplitHandles, { props: { node }, attachTo: document.body })
  await flush()
  const handles = w.findAll('[data-slot="handle"]')
  expect(handles.map(h => [h.attributes('aria-orientation'), h.attributes('aria-label')])).toEqual([['vertical', 'Resize'], ['horizontal', 'Resize']])
  expect(w.emitted('resize')).toBeUndefined()

  await handles[0]!.trigger('keydown', { key: 'ArrowRight' })
  await flush()
  expect(w.emitted('resize')).toEqual([['', 0.55]])

  await handles[1]!.trigger('dblclick')
  await flush()
  expect(w.emitted('resize')!.at(-1)).toEqual(['1', 0.5])
  w.unmount()
})

it('a ratio synced from elsewhere moves the handle without writing it back, past the 15 % bound too', async () => {
  // fitTree's stack: 5/6 then 6/7 once a seventh pane comes (its second side under 15 %).
  const stack: SplitNode = { dir: 'down', ratio: 0.833, a: 'x', b: 'y' }
  const w = await mountSuspended(SplitHandles, { props: { node: stack }, attachTo: document.body })
  await flush()
  await w.setProps({ node: { ...stack, ratio: 0.857 } })
  await flush()
  expect(w.emitted('resize')).toBeUndefined()
  expect(w.get('[data-slot="handle"]').attributes('aria-valuenow')).toBe('86')
  w.unmount()
})
