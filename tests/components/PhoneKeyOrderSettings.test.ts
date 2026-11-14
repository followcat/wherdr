// Settings › Terminal › Phone key bar: hiding a key removes it from the preview
// and keeps its place in the order; the keyboard key stays; Reset shows all.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PhoneKeyOrderSettings from '~/components/PhoneKeyOrderSettings.vue'
import { phoneKeyHidden, phoneKeyOrder } from '~/composables/useHerdr'
import { PHONE_KEY_IDS } from '~/utils/keybarOrder'

afterEach(() => { phoneKeyHidden.value = []; phoneKeyOrder.value = [...PHONE_KEY_IDS] })

it('hides and shows keys in the preview without losing their place', async () => {
  const w = await mountSuspended(PhoneKeyOrderSettings)
  const preview = () => w.findAll('.key-order-preview [data-key]').map(el => el.attributes('data-key'))
  const check = (id: string) => w.find(`[data-key-row="${id}"] input[type="checkbox"]`)
  expect(preview()).toEqual([...PHONE_KEY_IDS])
  expect(w.find('.bar-pref-reset').attributes('disabled')).toBeDefined()

  await check('esc').setValue(false)
  expect(phoneKeyHidden.value).toEqual(['esc'])
  expect(preview()).not.toContain('esc')
  expect(w.find('[data-key-row="esc"]').classes()).toContain('off')
  expect(w.find('[aria-live]').text()).toBe('Esc: hidden')

  // Moved while hidden, shown again at its new place.
  await w.find('[data-key-row="esc"] .key-order-up').trigger('click')
  await check('esc').setValue(true)
  expect(preview().slice(0, 3)).toEqual(['keyboard', 'esc', 'ctrl'])

  // The keyboard key cannot be hidden.
  expect(check('keyboard').attributes('disabled')).toBeDefined()
  expect(w.find('[data-key-row="keyboard"]').text()).toContain('Always shown')

  await check('tab').setValue(false)
  await w.find('.bar-pref-reset').trigger('click')
  expect(phoneKeyHidden.value).toEqual([])
  expect(preview()).toEqual([...PHONE_KEY_IDS])
  w.unmount()
})
