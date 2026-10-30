import { beforeAll, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { ref } from 'vue'
import Keybar from '~/components/Keybar.vue'
import type { VirtualModifier } from '~/utils/virtualKeys'

beforeAll(async () => {
  const app = await mountSuspended({ template: '<div />' })
  app.unmount()
}, 60_000)

function makeCtl() {
  let focused = false
  return {
    virtualModifiers: ref<VirtualModifier[]>([]),
    lastVirtualChord: ref(''),
    toggleVirtualModifier: vi.fn((m: VirtualModifier) => {}),
    sendVirtualKey: vi.fn(async (_key: string) => {}),
    kbdOn: ref(false),
    hasFocus: () => focused,
    focus: vi.fn(() => { focused = true }),
    blur: vi.fn(() => { focused = false }),
  }
}
const stripLabels = (w: Awaited<ReturnType<typeof mountSuspended>>) =>
  w.findAll('.vk-strip button').map(b => b.attributes('aria-label'))

describe('Keybar', () => {
  it('sends named keys from the always-visible strip', async () => {
    const ctl = makeCtl()
    const w = await mountSuspended(Keybar, { props: { ctl: ctl as never, compact: true } })
    expect(stripLabels(w)).toEqual(['Esc', 'Shift', 'Tab', '←', '↑', '↓', '→', 'Enter', 'Show or hide function keys'])
    await w.findAll('.vk-strip button')[2]!.trigger('click')
    expect(ctl.sendVirtualKey).toHaveBeenCalledWith('tab')
    await w.findAll('.vk-strip button')[0]!.trigger('click')
    expect(ctl.sendVirtualKey).toHaveBeenCalledWith('esc')
    w.unmount()
  })

  it('shows digits only when allDigits asks for them', async () => {
    const ctl = makeCtl()
    const plain = await mountSuspended(Keybar, { props: { ctl: ctl as never, compact: true } })
    expect(plain.find('.vk-digits').exists()).toBe(false)
    plain.unmount()

    const w = await mountSuspended(Keybar, { props: { ctl: ctl as never, compact: true, allDigits: true } })
    const buttons = w.findAll('.vk-digits button')
    expect(buttons.map(b => b.text())).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'])
    await buttons[4]!.trigger('click')
    expect(ctl.sendVirtualKey).toHaveBeenCalledWith('5')
    w.unmount()
  })

  it('expands to the function row without duplicating the strip Tab', async () => {
    const ctl = makeCtl()
    const w = await mountSuspended(Keybar, { props: { ctl: ctl as never, compact: true } })
    expect(w.find('.vk-extra-row').exists()).toBe(false)
    await w.get('.vk-more').trigger('click')
    const row = w.findAll('.vk-function-scroll > button')
    const labels = row.map(b => b.attributes('aria-label'))
    expect(labels.slice(0, 2)).toEqual(['Ctrl', 'Alt'])
    expect(labels.slice(2, 12)).toEqual(['Ctrl + C', '⌫', 'Y', 'N', 'PgUp', 'PgDn', 'Home', 'End', 'Del', 'INSERT'])
    expect(labels.slice(12)).toEqual(Array.from({ length: 12 }, (_, i) => `F${i + 1}`))
    expect(labels).not.toContain('Tab')
    await row[2]!.trigger('click')
    expect(ctl.sendVirtualKey).toHaveBeenCalledWith('ctrl+c')
    await row[3]!.trigger('click')
    expect(ctl.sendVirtualKey).toHaveBeenCalledWith('backspace')
    w.unmount()
  })

  it('arms modifiers and announces the pending chord', async () => {
    const ctl = makeCtl()
    const w = await mountSuspended(Keybar, { props: { ctl: ctl as never, compact: true } })
    await w.get('.vk-more').trigger('click')
    const mods = w.findAll('.vk-extra-row .vk-mod')
    await mods[0]!.trigger('click')
    expect(ctl.toggleVirtualModifier).toHaveBeenCalledWith('ctrl')
    ctl.virtualModifiers.value = ['ctrl']
    await w.vm.$nextTick()
    expect(w.get('.vk-announcement').text()).toBe('Ctrl + …')
    w.unmount()
  })

  it('toggles the phone keyboard from the extra row', async () => {
    const ctl = makeCtl()
    const w = await mountSuspended(Keybar, { props: { ctl: ctl as never, compact: true } })
    await w.get('.vk-more').trigger('click')
    await w.get('.vk-system').trigger('click')
    expect(ctl.focus).toHaveBeenCalled()
    w.unmount()
  })
})
