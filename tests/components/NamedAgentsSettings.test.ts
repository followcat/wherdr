// Settings › Agents › Named agents: add one (refused while invalid), edit and remove it; a synced setting.
import { afterEach, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import NamedAgentsSettings from '~/components/NamedAgentsSettings.vue'
import { appConfig, namedAgents } from '~/composables/useHerdr'

afterEach(() => { namedAgents.value = [] })
const field = (w: Awaited<ReturnType<typeof mountSuspended>>, id: string) => w.find(`[data-testid="${id}"] input, input[data-testid="${id}"]`)

it('adds, edits and removes a named agent', async () => {
  appConfig.value = { ...appConfig.value, machines: undefined, kinds: ['claude', 'omp'] }
  const w = await mountSuspended(NamedAgentsSettings)
  await w.find('[data-testid="named-agent-add"]').trigger('click')
  await field(w, 'named-agent-name').setValue('omp-sub')
  await field(w, 'named-agent-command').setValue('omp-sub --api-key=abc')
  await w.find('form').trigger('submit')
  expect(w.find('[role="alert"]').text()).toMatch(/No key/)
  expect(namedAgents.value).toEqual([])

  await field(w, 'named-agent-command').setValue('omp-sub --thinking medium')
  await w.find('form').trigger('submit')
  expect(namedAgents.value).toEqual([{ name: 'omp-sub', program: 'claude', command: 'omp-sub --thinking medium', machines: [''] }])
  expect(w.find('[data-row="omp-sub"]').text()).toContain('omp-sub --thinking medium')

  await w.find('[data-row="omp-sub"] button').trigger('click')
  await field(w, 'named-agent-name').setValue('omp-api')
  await w.find('form').trigger('submit')
  expect(namedAgents.value.map(a => a.name)).toEqual(['omp-api'])

  await w.findAll('[data-row="omp-api"] button')[1]!.trigger('click')
  expect(namedAgents.value).toEqual([])
  w.unmount()
})
