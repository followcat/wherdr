import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ThumbImg from '~/components/ThumbImg.vue'
import { keepPreview } from '~/utils/sentPreviews'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('message thumbnail', () => {
  // Before: a failed <img> stayed a broken icon until the bubble was rebuilt.
  it('retries a failed image once, then offers Tap to reload', async () => {
    vi.useFakeTimers()
    const w = await mountSuspended(ThumbImg, { props: { src: '/api/chat/image?pane=p1&i=0' } })
    await w.get('img').trigger('error')
    vi.advanceTimersByTime(1500)
    await nextTick()
    expect(w.get('img').attributes('src')).toBe('/api/chat/image?pane=p1&i=0&retry=1')
    await w.get('img').trigger('error')
    const reload = w.get('button.thumb-reload')
    expect(reload.text()).toContain('Tap to reload')
    await reload.trigger('click')
    expect(w.get('img').attributes('src')).toBe('/api/chat/image?pane=p1&i=0&retry=2')
    w.unmount()
  })

  it('retries at once when the page comes back to the front', async () => {
    const w = await mountSuspended(ThumbImg, { props: { src: '/uploads/a.jpg' } })
    await w.get('img').trigger('error')
    document.dispatchEvent(new Event('visibilitychange'))
    await nextTick()
    expect(w.get('img').attributes('src')).toBe('/uploads/a.jpg?retry=1')
    w.unmount()
  })

  it('shows the local preview of a photo just sent until its upload loads', async () => {
    const probes: { src: string, onload: (() => void) | null }[] = []
    vi.stubGlobal('Image', class { src = ''; onload = null; onerror = null; constructor() { probes.push(this as never) } })
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    keepPreview('b.jpg', 'blob:local-b')
    const w = await mountSuspended(ThumbImg, { props: { src: '/uploads/b.jpg' } })
    expect(w.get('img').attributes('src')).toBe('blob:local-b')
    expect(probes.at(-1)!.src).toBe('/uploads/b.jpg')
    probes.at(-1)!.onload!()
    await nextTick()
    expect(w.get('img').attributes('src')).toBe('/uploads/b.jpg')
    expect(revoke).toHaveBeenCalledWith('blob:local-b')
    w.unmount()
  })
})
