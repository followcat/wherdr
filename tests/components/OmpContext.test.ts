import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import type { Pane } from '../../shared/types'
import OmpContext from '~/components/OmpContext.vue'

it('shows omp\'s context as a card bar, a header gauge with details and a phone text, marking old readings', async () => {
  const pane = { id: 'ctx', agent: 'omp', status: 'working', ompStatus: { line: 'Model · project', meters: '◫ 68%/200K · 7d 71%', metersFresh: true } } as Pane
  const wrapper = await mountSuspended(OmpContext, { props: { pane, variant: 'head' }, attachTo: document.body })
  try {
    const button = () => wrapper.get('button')
    expect(button().text()).toMatch(/68%.*136K/)
    expect(button().attributes('aria-label')).not.toContain('Last reading')
    expect(document.querySelector('.omp-context-detail')).toBeNull()
    await button().trigger('click')
    expect(document.querySelector('.omp-context-detail')?.textContent).toContain('Model · project')
    expect(document.querySelector('.omp-context-detail')?.textContent).toContain('7d 71%')
    await wrapper.setProps({ pane: { ...pane, status: 'idle' } })
    expect(button().attributes('aria-label')).toContain('Last reading, not live')
    await wrapper.setProps({ pane: { ...pane, ompStatus: { line: 'Model', meters: '▶──200K─120%◀', metersFresh: true } }, variant: 'bar' })
    expect(wrapper.find('button').exists()).toBe(false)
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuenow')).toBe('100')
    expect(wrapper.get('[role="progressbar"]').classes()).toContain('hi')
    await wrapper.setProps({ variant: 'text' })
    expect(wrapper.text()).toBe('120%')
    for (const other of [{ ...pane, ompStatus: undefined }, { ...pane, agent: 'claude' }]) {
      await wrapper.setProps({ pane: other as Pane })
      expect(wrapper.text()).toBe('')
    }
  } finally { wrapper.unmount() }
})
