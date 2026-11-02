import { expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PhoneKeybar from '~/components/PhoneKeybar.vue'
import type { TerminalCtl } from '~/composables/useTerminal'

it('keeps the complete ordered key strip usable in Conversation', async () => {
  const sendVirtualKey = vi.fn()
  const ctl = {
    virtualModifiers: ref([]), lastVirtualChord: ref(''), kbdOn: ref(false),
    sendVirtualKey, toggleVirtualModifier: vi.fn(), focus: vi.fn(), blur: vi.fn(), hasFocus: () => false,
  } as unknown as TerminalCtl
  const wrapper = await mountSuspended(PhoneKeybar, { props: { ctl, terminal: false } })
  try {
    const labels = () => wrapper.findAll('button').map(b => b.attributes('aria-label'))
    expect(labels().slice(0, 16)).toEqual(['Show or hide the phone keyboard', 'Ctrl', 'Esc', 'Tab', 'Left arrow', 'Up arrow', 'Down arrow', 'Right arrow', 'Enter', 'Ctrl+C', 'Backspace', 'Home', 'End', 'PgUp', 'PgDn', 'Delete'])
    await wrapper.findAll('button')[0]!.trigger('click')
    expect(wrapper.emitted('keyboard')).toHaveLength(1)
    expect(ctl.focus).not.toHaveBeenCalled()
    await wrapper.findAll('button')[2]!.trigger('click')
    expect(sendVirtualKey).toHaveBeenCalledWith('esc')
    expect(wrapper.find('.vk-more').exists()).toBe(false)
    const caps = Object.fromEntries(wrapper.findAll('button').map(b => [b.attributes('aria-label'), b.text()]))
    expect([caps.PgUp, caps.PgDn, caps.Delete, caps.Insert]).toEqual(['PgUp', 'PgDn', 'Del', 'Ins'])
    await wrapper.setProps({ terminal: true })
    await wrapper.findAll('button')[0]!.trigger('click')
    expect(ctl.focus).toHaveBeenCalledOnce()
    expect(labels().slice(0, 16)).toEqual(['Show or hide the phone keyboard', 'Ctrl', 'Esc', 'Tab', 'Left arrow', 'Up arrow', 'Down arrow', 'Right arrow', 'Enter', 'Ctrl+C', 'Backspace', 'Home', 'End', 'PgUp', 'PgDn', 'Delete'])
  } finally { wrapper.unmount() }
})
