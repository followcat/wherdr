// WHR-343: one switch look everywhere: a USwitch given no color takes the
// success color from app.config.ts, not Nuxt UI's primary.
import { expect, it } from 'vitest'
import { h } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { USwitch } from '#components'

it('a switch rendered without a color gets the success color', async () => {
  const w = await mountSuspended({ render: () => h(USwitch, { modelValue: true }) })
  const cls = w.find('[role="switch"]').classes()
  expect(cls).toContain('data-[state=checked]:bg-success')
  expect(cls).not.toContain('data-[state=checked]:bg-primary')
  w.unmount()
})
