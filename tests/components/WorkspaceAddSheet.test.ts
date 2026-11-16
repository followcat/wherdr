import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import WorkspaceAddSheet from '~/components/WorkspaceAddSheet.vue'
import { machineGroups } from '~/composables/useMachineBar'
import { appConfig } from '~/composables/useHerdr'

const { launch } = vi.hoisted(() => ({ launch: vi.fn(async () => undefined) }))
mockNuxtImport('launchCoordinator', () => launch)

registerEndpoint('/api/config', () => ({ kinds: ['claude'], home: '/home/user', dirs: [], push: { enabled: false, key: null, devices: 0 } }))
const added: Record<string, unknown>[] = []
registerEndpoint('/api/pm/project', { method: 'POST', handler: async (event) => {
  const { readBody } = await import('h3')
  added.push(await readBody(event as never))
  return { project: {} }
} })

const stubs = { AppSheet: { template: '<section><slot /><slot name="footer" /></section>' } }
afterEach(() => { added.length = 0; launch.mockClear(); machineGroups.value = []; appConfig.value = { ...appConfig.value, hostLabel: undefined, machines: undefined } })

it('creates a workspace with its root on each machine, then starts its coordinator', async () => {
  machineGroups.value = [{ id: '*group:o', name: 'Office', machines: ['big'] }]
  const w = await mountSuspended(WorkspaceAddSheet, { props: { open: false, taken: ['PA'] }, global: { stubs } })
  appConfig.value = { ...appConfig.value, hostLabel: 'home', machines: [{ key: '', label: 'home', local: true }, { key: 'big', label: 'Build box', local: false }] } as typeof appConfig.value
  await w.setProps({ open: true })
  // Nothing typed yet: the form says what is missing, nothing is sent.
  await w.get('form').trigger('submit')
  await flushPromises()
  expect(w.text()).toContain('Give it a name')
  expect(added).toEqual([])
  await w.get('#add-workspace-name').setValue('Payroll apps')
  // The key follows the name, past the keys taken.
  expect((w.get('#add-workspace-key').element as HTMLInputElement).value).toBe('PA2')
  console.log(w.findAll('[data-testid="add-workspace-machine"]').map(x => x.html().slice(0, 300)))
  await w.findAll('[data-testid="add-workspace-machine"] button[role="checkbox"]')[1]!.trigger('click')
  await w.findAll('input[data-testid="add-workspace-root"]')[1]!.setValue('/srv/work')
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(launch).toHaveBeenCalledWith('PA2'))
  expect(added).toEqual([{ key: 'PA2', name: 'Payroll apps', machine: '', path: '~/work', kind: 'workspace', shared: { machines: ['big'], clones: { big: '/srv/work' } }, plain: true }])
  expect(w.emitted('added')).toEqual([['PA2']])
  w.unmount()
})
