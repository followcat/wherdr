import { expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { createTerminal } from '~/composables/useTerminal'

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = {}; modes = { mouseTrackingMode: 'none' }
  write(_data: unknown, done?: () => void) { done?.() }
  loadAddon() {} open() {} dispose() {} refresh() {} attachCustomWheelEventHandler() {}
  attachCustomKeyEventHandler() {} onData() {} onBinary() {}
} }))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions() { return null } } }))

// A conversation-mode terminal may not be connected (input() === false): a
// "Send with <chord>" keybar press must still reach submitKey — it is a
// composer action, not terminal input. Before the fix the input gate ran
// first and swallowed the chord.
it('a draft-terminator chord reaches submitKey while terminal input is off', async () => {
  const chords: string[] = []
  let ctl!: ReturnType<typeof createTerminal>
  mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p1', {
        setBanner: vi.fn(), hasBanner: () => false,
        input: () => false,
        submitKey: (c) => { chords.push(c); return c === 'ctrl+enter' },
      })
      return () => h('div')
    },
  }))
  ctl.toggleVirtualModifier('ctrl')
  await ctl.sendVirtualKey('enter')
  expect(chords).toEqual(['ctrl+enter'])
  expect(ctl.virtualModifiers.value).toEqual([])
})

it('a non-terminator chord still respects the input gate', async () => {
  const chords: string[] = []
  let ctl!: ReturnType<typeof createTerminal>
  mount(defineComponent({
    setup() {
      ctl = createTerminal('w1:p2', {
        setBanner: vi.fn(), hasBanner: () => false,
        input: () => false,
        submitKey: (c) => { chords.push(c); return false },
      })
      return () => h('div')
    },
  }))
  await ctl.sendVirtualKey('enter')
  expect(chords).toEqual(['enter'])
})
