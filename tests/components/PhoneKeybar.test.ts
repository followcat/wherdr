import { expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PhoneKeybar from '~/components/PhoneKeybar.vue'
import type { TerminalCtl } from '~/composables/useTerminal'
import { toggleVirtualModifier, virtualChord, type VirtualModifier } from '~/utils/terminalModifiers'
import { displayVirtualChord } from '~/utils/keybarKeys'

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

it('announces the armed chord and spends the modifiers on the next key', async () => {
  // The fake ctl applies the real useTerminal contract: sendVirtualKey
  // composes the chord, clears the armed modifiers and records the readable
  // announcement.
  const virtualModifiers = ref<VirtualModifier[]>([])
  const lastVirtualChord = ref('')
  const sendVirtualKey = vi.fn((key: string) => {
    const chord = virtualChord(key, virtualModifiers.value)
    virtualModifiers.value = []
    lastVirtualChord.value = displayVirtualChord(chord)
  })
  const ctl = {
    virtualModifiers, lastVirtualChord, kbdOn: ref(false),
    sendVirtualKey,
    toggleVirtualModifier: (m: VirtualModifier) => { virtualModifiers.value = toggleVirtualModifier(virtualModifiers.value, m) },
    focus: vi.fn(), blur: vi.fn(), hasFocus: () => false,
  } as unknown as TerminalCtl
  const wrapper = await mountSuspended(PhoneKeybar, { props: { ctl, terminal: true } })
  try {
    const byLabel = (label: string) => wrapper.findAll('button').find(b => b.attributes('aria-label') === label)!
    const announcement = () => wrapper.find('.vk-announcement').text()
    expect(announcement()).toBe('One-shot chord')
    await byLabel('Ctrl').trigger('click')
    expect(byLabel('Ctrl').attributes('aria-pressed')).toBe('true')
    expect(announcement()).toBe('Ctrl + …')
    await byLabel('Alt').trigger('click')
    expect(announcement()).toBe('Ctrl + Alt + …')
    await byLabel('Up arrow').trigger('click')
    expect(sendVirtualKey).toHaveBeenCalledTimes(1)
    expect(sendVirtualKey).toHaveBeenCalledWith('up')
    expect(virtualModifiers.value).toEqual([])
    expect(byLabel('Ctrl').attributes('aria-pressed')).toBe('false')
    // The consumed chord is announced with readable names.
    expect(announcement()).toBe('Ctrl + Alt + ↑')
    await byLabel('Left arrow').trigger('click')
    expect(sendVirtualKey).toHaveBeenLastCalledWith('left')
    expect(announcement()).toBe('←')
  } finally { wrapper.unmount() }
})
