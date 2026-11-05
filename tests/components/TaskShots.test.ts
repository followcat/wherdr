import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import TaskShots from '~/components/TaskShots.vue'
import { lightboxSet, lightboxSrc } from '~/composables/useUi'
import { shotUrl, type Shot } from '#shared/pm/shots'

const shot = (phase: Shot['phase'], n: number): Shot => ({ file: `${String(n).padStart(12, '0')}.png`, phase, at: n })
const url = (n: number) => shotUrl('UI-1', `${String(n).padStart(12, '0')}.png`)
let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; lightboxSrc.value = null; lightboxSet.value = [] })
const mount = async (shots: Shot[], mode: 'after' | 'before-after') =>
  (mounted = await mountSuspended(TaskShots, { props: { task: 'UI-1', shots, mode } }))

it('before/after: pairs each before with its after, toggles the side, opens the whole set full size', async () => {
  const w = await mount([shot('before', 1), shot('after', 2), shot('before', 3)], 'before-after')
  const rows = w.findAll('.shots-row:not(.shots-head)')
  expect(rows.map(r => r.findAll('.shot').map(c => `${c.classes().includes('before') ? 'before' : 'after'}:${c.find('img').exists() ? c.find('img').attributes('src') : '-'}`)))
    .toEqual([[`before:${url(1)}`, `after:${url(2)}`], [`before:${url(3)}`, 'after:-']])

  // The phone's toggle: After by default, Before on a tap.
  const gallery = w.find('[data-testid="task-shots"]')
  expect(gallery.attributes('data-side')).toBe('after')
  await w.find('[data-testid="shots-before"]').trigger('click')
  expect(gallery.attributes('data-side')).toBe('before')
  expect(w.find('[data-testid="shots-before"]').attributes('aria-pressed')).toBe('true')

  // A tap opens the viewer on that image, in the set of all of them (swipe between).
  await w.findAll('[data-testid="shot"]')[1]!.trigger('click')
  expect(lightboxSet.value).toEqual([url(1), url(2), url(3)])
  expect(lightboxSrc.value).toBe(url(2))
})

it('after only: thumbnails of the result, no toggle', async () => {
  const w = await mount([shot('after', 1), shot('after', 2)], 'after')
  expect(w.find('[data-testid="shots-before"]').exists()).toBe(false)
  expect(w.findAll('[data-testid="shot"] img').map(i => i.attributes('src'))).toEqual([url(1), url(2)])
  await w.findAll('[data-testid="shot"]')[0]!.trigger('click')
  expect(lightboxSrc.value).toBe(url(1))
  expect(lightboxSet.value).toHaveLength(2)
})
