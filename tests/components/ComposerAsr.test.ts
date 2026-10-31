import { describe, expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import Composer from '~/components/Composer.vue'
import { asrInstalled } from '~/utils/asrModel'
import type { Pane } from '#shared/types'

const pane = (id: string): Pane => ({
  id, workspace: 'w1', tab: 'w1:t1', tabLabel: null, agent: 'pi', name: null, label: null, status: 'idle', title: null, cwd: '/home/user/demo', agentSession: null,
})

async function mount() {
  return mountSuspended(Composer, { props: { pane: pane('w1:p1'), paneId: 'w1:p1', sendKeys: async () => {} } })
}

describe('Composer voice input', () => {
  it('dims the microphone while the model is not installed', async () => {
    asrInstalled.value = false
    const w = await mount()
    const mic = w.find('.prompt-mic')
    expect(mic.exists()).toBe(true)
    expect(mic.classes()).toContain('dim')
    asrInstalled.value = true
    await nextTick()
    expect(w.find('.prompt-mic').classes()).not.toContain('dim')
    w.unmount()
    asrInstalled.value = false
  })

  it('keeps the field unchanged when the mic is only decorative', async () => {
    asrInstalled.value = false
    const w = await mount()
    await w.find('.prompt-mic').trigger('click')
    expect(w.find('textarea').element.value).toBe('')
    expect(w.find('.prompt-asr').exists()).toBe(false)
    w.unmount()
  })
})
