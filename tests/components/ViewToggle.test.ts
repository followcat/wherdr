import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import { defineComponent, h, ref } from 'vue'
import { UApp } from '#components'
import ViewToggle from '~/components/ViewToggle.vue'

it('offers the opposite view and emits one toggle per click', async () => {
  const mode = ref<'chat' | 'term'>('chat')
  let toggles = 0
  const Host = defineComponent({ render: () => h(UApp, null, () => h(ViewToggle, { mode: mode.value, onToggle: () => { toggles++ } })) })
  const wrapper = await mountSuspended(Host)
  try {
    expect(wrapper.findAll('button')).toHaveLength(1)
    expect(wrapper.get('button').attributes('aria-label')).toBe('Show terminal')
    expect(wrapper.get('button').text()).toBe('Terminal')
    await wrapper.get('button').trigger('click')
    expect(toggles).toBe(1)
    mode.value = 'term'
    await wrapper.vm.$nextTick()
    expect(wrapper.get('button').attributes('aria-label')).toBe('Show conversation')
    expect(wrapper.get('button').text()).toBe('Conversation')
    await wrapper.get('button').trigger('click')
    expect(toggles).toBe(2)
  } finally { wrapper.unmount() }
})
