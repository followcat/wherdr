import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { nextTick } from 'vue'
import ImageLightbox from '~/components/ImageLightbox.vue'
import { lightboxSet, lightboxSrc } from '~/composables/useUi'

beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

let unmount: (() => void) | undefined
afterEach(() => {
  unmount?.()
  unmount = undefined
  lightboxSrc.value = null
  lightboxSet.value = []
  vi.restoreAllMocks()
})

describe('image lightbox history handling', () => {
  it('pushes a history entry on open so the back gesture can be consumed', async () => {
    const push = vi.spyOn(history, 'pushState')
    const w = await mountSuspended(ImageLightbox)
    unmount = () => w.unmount()
    lightboxSrc.value = '/img/1.png'
    await nextTick()
    expect(push).toHaveBeenCalledWith({ wherdrLightbox: true }, '')
  })

  it('a system back gesture closes the viewer without navigating again', async () => {
    const back = vi.spyOn(history, 'back')
    const w = await mountSuspended(ImageLightbox)
    unmount = () => w.unmount()
    lightboxSrc.value = '/img/1.png'
    await nextTick()
    window.dispatchEvent(new Event('popstate'))
    await nextTick()
    expect(lightboxSrc.value).toBeNull()
    // The pop already consumed our entry: closing must not navigate further.
    expect(back).not.toHaveBeenCalled()
  })

  it('closing from the UI pops the pushed entry so Back stays consistent', async () => {
    const back = vi.spyOn(history, 'back')
    const w = await mountSuspended(ImageLightbox)
    unmount = () => w.unmount()
    lightboxSrc.value = '/img/1.png'
    await nextTick()
    await w.get('.lightbox-close').trigger('click')
    expect(lightboxSrc.value).toBeNull()
    expect(back).toHaveBeenCalledOnce()
  })

  it('browsing a set keeps a single history entry', async () => {
    const push = vi.spyOn(history, 'pushState')
    const w = await mountSuspended(ImageLightbox)
    unmount = () => w.unmount()
    lightboxSet.value = ['/img/1.png', '/img/2.png']
    lightboxSrc.value = '/img/1.png'
    await nextTick()
    lightboxSrc.value = '/img/2.png'
    await nextTick()
    expect(push).toHaveBeenCalledTimes(1)
  })
})
