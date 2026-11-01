import { describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime'
import Composer from '~/components/Composer.vue'
import { asrInstalledBy, asrModelId } from '~/utils/asrModel'
import type { Pane } from '#shared/types'

const pane = (id: string): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'pi', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null,
})

const sp = vi.hoisted(() => ({ impl: null as any, start: 0, stop: 0, cancel: 0 }))
mockNuxtImport('useSpeech', () => () => (sp.impl = {
  status: ref('ready'), error: ref(''), phase: ref(''), dl: ref(null), partial: ref(''), segments: ref<string[]>([]),
  finalText: ref(''), loadMs: ref(0), decodeMs: ref(null), take: ref(null), levels: ref<number[]>([]), recMs: ref(0),
  installed: ref(true),
  ensure: async () => {},
  startMic: async () => { sp.start++; sp.impl.status.value = 'recording' },
  stopMic: () => { sp.stop++; sp.impl.status.value = 'flushing' },
  cancelMic: () => { sp.cancel++; sp.impl.status.value = 'ready' },
  reset: () => {}, decodeBlob: async () => {}, dispose: () => {},
}))

async function mount() {
  return mountSuspended(Composer, { props: { pane: pane('w1:p1'), paneId: 'w1:p1', sendKeys: async () => {} } })
}

function installed(v: boolean) {
  asrInstalledBy.value = { [asrModelId.value]: v }
}

// VTU trigger() doesn't dispatch pointer events under happy-dom — go native.
const ptr = (el: Element, type: string) => el.dispatchEvent(new window.Event(type, { bubbles: true }))

describe('Composer voice input', () => {
  it('dims the microphone while the model is not installed', async () => {
    const w = await mount()
    installed(false)
    await nextTick()
    const mic = w.find('.prompt-mic')
    expect(mic.exists()).toBe(true)
    expect(mic.classes()).toContain('dim')
    installed(true)
    await nextTick()
    expect(w.find('.prompt-mic').classes()).not.toContain('dim')
    w.unmount()
    installed(false)
  })

  it('keeps the field unchanged when the mic is only decorative', async () => {
    const w = await mount()
    installed(false)
    await nextTick()
    await w.find('.prompt-mic').trigger('click')
    expect(w.find('textarea').element.value).toBe('')
    expect(w.find('.prompt-asr').exists()).toBe(false)
    w.unmount()
  })

  it('hold to talk: press records, release past the floor ends the take', async () => {
    const w = await mount()
    await new Promise(r => setTimeout(r, 0))
    sp.start = 0; sp.stop = 0; sp.cancel = 0
    installed(true)
    await nextTick()
    const mic = w.find('.prompt-mic')
    ptr(mic.element, 'pointerdown')
    await nextTick()
    expect(sp.start).toBe(1)
    expect(w.find('.prompt-asr').exists()).toBe(true)
    expect(w.find('.asr-wave').exists()).toBe(true)
    await new Promise(r => setTimeout(r, 700))
    ptr(mic.element, 'pointerup')
    await nextTick()
    expect(sp.stop).toBe(1)
    // The trailing click after a real hold does not toggle again.
    await mic.trigger('click')
    expect(sp.start).toBe(1)
    expect(sp.stop).toBe(1)
    w.unmount()
    installed(false)
  })

  it('a quick press stays on as tap-to-start; the next press stops it', async () => {
    const w = await mount()
    await new Promise(r => setTimeout(r, 0))
    sp.start = 0; sp.stop = 0; sp.cancel = 0
    installed(true)
    await nextTick()
    const mic = w.find('.prompt-mic')
    ptr(mic.element, 'pointerdown')
    await nextTick()
    ptr(mic.element, 'pointerup')
    await nextTick()
    // Under the hold floor the take keeps running — tap toggle preserved.
    expect(sp.stop).toBe(0)
    expect(sp.impl.status.value).toBe('recording')
    await mic.trigger('click') // already handled, no double toggle
    expect(sp.start).toBe(1)
    ptr(mic.element, 'pointerdown')
    await nextTick()
    ptr(mic.element, 'pointerup')
    await nextTick()
    expect(sp.stop).toBe(1)
    w.unmount()
    installed(false)
  })

  it('the wave draws the take as block glyphs', async () => {
    const w = await mount()
    await new Promise(r => setTimeout(r, 0))
    sp.start = 0; sp.stop = 0; sp.cancel = 0
    installed(true)
    await nextTick()
    const mic = w.find('.prompt-mic')
    ptr(mic.element, 'pointerdown')
    await nextTick()
    sp.impl.levels.value = [0.0, 0.02, 0.2, 0.6]
    sp.impl.recMs.value = 510
    await nextTick()
    expect(w.find('.asr-wave-in').text()).toMatch(/^[▁-█]+$/)
    expect(w.find('.asr-wave-in').text().length).toBe(4)
    expect(w.find('.asr-time').text()).toBe('0:00')
    ptr(mic.element, 'pointerup')
    w.unmount()
    installed(false)
  })
})
