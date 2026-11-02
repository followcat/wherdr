import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import AutopilotMessage from '~/components/AutopilotMessage.vue'

const text = 'Autopilot: Check ready work.\nBoard context: no pending replies.  '

function hoverMedia(matches: boolean) {
  const media = Object.assign(new EventTarget(), { matches })
  vi.spyOn(window, 'matchMedia').mockImplementation(query => {
    expect(query).toBe('(hover: hover) and (pointer: fine)')
    return media as MediaQueryList
  })
  return media
}

describe('Autopilot copy visibility', () => {
  afterEach(() => vi.restoreAllMocks())

  it('hides at rest, reveals on hover, then hides on leave', async () => {
    hoverMedia(true)
    const w = await mountSuspended(AutopilotMessage, { props: { text }, attachTo: document.body })
    try {
      const copy = w.get('button')
      expect(getComputedStyle(copy.element).opacity).toBe('0')
      expect(getComputedStyle(copy.element).pointerEvents).toBe('none')
      await w.trigger('mouseenter')
      expect(getComputedStyle(copy.element).opacity).toBe('1')
      expect(getComputedStyle(copy.element).pointerEvents).toBe('auto')
      await copy.trigger('click')
      expect(w.emitted('copy')).toEqual([[text]])
      await w.trigger('mouseleave')
      expect(getComputedStyle(copy.element).opacity).toBe('0')
    } finally { w.unmount() }
  })

  it('reveals on focus events and stays revealed until both focus and hover leave', async () => {
    hoverMedia(true)
    const w = await mountSuspended(AutopilotMessage, { props: { text }, attachTo: document.body })
    try {
      const copy = w.get('button')
      expect(getComputedStyle(copy.element).opacity).toBe('0')
      await copy.trigger('focusin')
      expect(getComputedStyle(copy.element).opacity).toBe('1')
      await w.trigger('mouseenter')
      await w.trigger('mouseleave')
      expect(getComputedStyle(copy.element).opacity).toBe('1')
      await copy.trigger('focusout', { relatedTarget: null })
      expect(getComputedStyle(copy.element).opacity).toBe('0')
    } finally { w.unmount() }
  })

  it('removes the action on a phone even after hover or focus events', async () => {
    hoverMedia(false)
    const w = await mountSuspended(AutopilotMessage, { props: { text }, attachTo: document.body })
    try {
      const copy = w.get('button')
      expect(copy.isVisible()).toBe(false)
      await w.trigger('mouseenter')
      await copy.trigger('focusin')
      expect(copy.isVisible()).toBe(false)
      expect(w.get('.msg-fold').element.textContent).toBe(text)
    } finally { w.unmount() }
  })
})
