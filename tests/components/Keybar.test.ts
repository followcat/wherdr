// The former expandable rows are now the ordered 2.5 strip. Its full key
// matrix is covered by PhoneKeybar.test.ts and KeybarKeyboard.test.ts.
import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import Keybar from '~/components/Keybar.vue'
import { PHONE_KEY_IDS } from '~/utils/keybarOrder'
import { phoneKeyOrder } from '~/composables/useHerdr'
import type { TerminalCtl } from '~/composables/useTerminal'
import type { VirtualModifier } from '~/utils/virtualKeys'

const previous = phoneKeyOrder.value.slice()
afterEach(() => { phoneKeyOrder.value = previous.slice() })
function ctl() {
  return {
    virtualModifiers: ref<VirtualModifier[]>([]), lastVirtualChord: ref(''), kbdOn: ref(false),
    sendVirtualKey: vi.fn(), toggleModifier: vi.fn(), toggleVirtualModifier: vi.fn(),
    focus: vi.fn(), blur: vi.fn(), hasFocus: () => false,
  } as unknown as TerminalCtl
}

it('forwards the saved key order and the conversation keyboard request', async () => {
  phoneKeyOrder.value = ['esc', ...PHONE_KEY_IDS.filter(id => id !== 'esc')]
  const c = ctl()
  const w = await mountSuspended(Keybar, { props: { ctl: c, compact: true, terminal: false } })
  try {
    expect(w.find('.vk-strip button').attributes('aria-label')).toBe('Esc')
    await w.get('[data-key="esc"]').trigger('click')
    expect(c.sendVirtualKey).toHaveBeenCalledWith('esc')
    await w.get('[data-key="keyboard"]').trigger('click')
    expect(w.emitted('keyboard')).toHaveLength(1)
    expect(c.focus).not.toHaveBeenCalled()
  } finally { w.unmount() }
})

it.each([false, true])('marks a configured draft terminator with compact=%s', async compact => {
  const c = ctl()
  c.virtualModifiers.value = ['shift']
  const w = await mountSuspended(Keybar, { props: { ctl: c, compact, sendWith: ['shift+tab'] } })
  try {
    const key = compact ? w.get('[data-key="tab"]') : w.findAll('button').find(b => b.text() === 'tab')!
    expect(key.classes()).toContain('send-with')
    await key.trigger('click')
    expect(c.sendVirtualKey).toHaveBeenCalledWith('tab')
  } finally { w.unmount() }
})
