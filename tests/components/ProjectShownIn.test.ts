// The project sheet's "Shown in": Automatic names the groups holding one of
// its machines; a group picked is saved at once; deleting that group in
// Settings › Appearance › Machine tabs brings the project back to Automatic.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import ProjectShownIn from '~/components/ProjectShownIn.vue'
import MachineBarSettings from '~/components/MachineBarSettings.vue'
import { machineGroups, projectTabs } from '~/composables/useMachineBar'
import type { Project } from '#shared/pm/project'
import { pick, selectLabels, selectValue } from '../helpers/select'

afterEach(() => { machineGroups.value = []; projectTabs.value = {} })
const project = { key: 'WEB', name: 'Web', machine: '', path: '~/project', machines: ['', 'a'] } as Project

it('offers a hint without groups, saves a group, and goes back to Automatic when it is deleted', async () => {
  const w = await mountSuspended(ProjectShownIn, { props: { project } })
  expect(selectLabels(w, 'pm-shown-in')).toEqual(['Automatic', 'All tabs'])
  expect(w.find('[data-testid="pm-shown-in-hint"]').text()).toContain('Settings › Appearance › Machine tabs')

  machineGroups.value = [{ id: '*group:1', name: 'Laptops', machines: ['a'] }, { id: '*group:2', name: 'Servers', machines: ['b'] }]
  await nextTick()
  expect(selectLabels(w, 'pm-shown-in')).toEqual(['Automatic (Laptops)', 'Laptops', 'Servers', 'All tabs'])
  expect(w.find('[data-testid="pm-shown-in-hint"]').exists()).toBe(false)

  await pick(w, 'pm-shown-in', '*group:2')
  expect(projectTabs.value).toEqual({ WEB: '*group:2' })
  expect(selectValue(w, 'pm-shown-in')).toBe('*group:2')

  const s = await mountSuspended(MachineBarSettings)
  await s.findAll('.machine-group-list button')[1]!.trigger('click')
  await s.find('.delete-machine-group').trigger('click')
  expect(projectTabs.value).toEqual({})
  expect(selectValue(w, 'pm-shown-in')).toBe('auto')
  s.unmount()
  w.unmount()
})
