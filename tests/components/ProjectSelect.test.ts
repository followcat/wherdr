// WHR-305: a project picker shows each project's key badge in its color, then
// its name, in the open list and in the closed picker; other options stay plain.
import { expect, it } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectSelect from '~/components/ProjectSelect.vue'
import { projectOption } from '~/utils/projectOption'
import { projectColorVar } from '~/utils/projectColor'

const items = [
  { label: 'All', value: 'all' },
  projectOption({ key: 'WHR', name: 'Sample app', color: 'teal' }),
  projectOption({ key: 'CMP', label: 'CP', name: 'Customer portal', color: 'violet' }, 'p:CMP'),
]
const badges = () => [...document.querySelectorAll('[data-testid="project-badge"]')].map(b => [b.textContent, (b as HTMLElement).style.getPropertyValue('--key-c')])

it('shows the badge of each project option and of the picked project', async () => {
  const w = await mountSuspended(ProjectSelect, { props: { items, modelValue: 'p:CMP' }, attachTo: document.body })
  expect(badges()).toEqual([['CP', projectColorVar('violet')]])
  await w.setProps({ modelValue: 'all' })
  expect(badges()).toEqual([]) // a plain option: no badge
  await w.find('button').trigger('click')
  await nextTick()
  expect(badges()).toEqual([['WHR', projectColorVar('teal')], ['CP', projectColorVar('violet')]])
  w.unmount()
})
