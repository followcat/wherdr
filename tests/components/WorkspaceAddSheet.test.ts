import { afterEach, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { createError } from 'h3'
import { flushPromises } from '@vue/test-utils'
import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import WorkspaceAddSheet from '~/components/WorkspaceAddSheet.vue'
import { machineGroups } from '~/composables/useMachineBar'
import { appConfig, herdrState } from '~/composables/useHerdr'

const { launch } = vi.hoisted(() => ({ launch: vi.fn(async () => undefined) }))
mockNuxtImport('launchCoordinator', () => launch)

registerEndpoint('/api/config', () => ({ kinds: ['claude'], home: '/home/user', dirs: [], push: { enabled: false, key: null, devices: 0 } }))
const added: Record<string, unknown>[] = []
registerEndpoint('/api/pm/project', { method: 'POST', handler: async (event) => {
  const { readBody } = await import('h3')
  added.push(await readBody(event as never))
  return { project: {} }
} })

const DirBrowser = defineComponent({ props: { start: { type: String, default: null }, machine: { type: String, default: '' } }, emits: ['choose', 'cancel'], template: '<div data-testid="dir-browser" />' })
const stubs = { AppSheet: { template: '<section><slot /><slot name="footer" /></section>' }, DirBrowser }
registerEndpoint('/api/dirs', (event) => {
  const path = new URL(event.node.req.url!, 'http://x').searchParams.get('path')
  if (path !== '~/apps') throw createError({ statusCode: 400, message: 'bad_path' })
  return { path: '/home/user/apps', parent: '/home/user', home: '/home/user', dirs: [] }
})
afterEach(() => { added.length = 0; launch.mockClear(); machineGroups.value = []; herdrState.value = { ...herdrState.value, machines: [] }; appConfig.value = { ...appConfig.value, hostLabel: undefined, machines: undefined } })

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
  await w.findAll('[data-testid="add-workspace-machine"] button[role="checkbox"]')[1]!.trigger('click')
  await w.findAll('input[data-testid="add-workspace-root"]')[1]!.setValue('/srv/work')
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(launch).toHaveBeenCalledWith('PA2', undefined))
  expect(added).toEqual([{ key: 'PA2', name: 'Payroll apps', machine: '', path: '~/work', kind: 'workspace', shared: { machines: ['big'], clones: { big: '/srv/work' } }, plain: true }])
  expect(w.emitted('added')).toEqual([['PA2']])
  w.unmount()
})

it('browses a machine\'s folders for its root: choose fills it, cancel keeps what was typed', async () => {
  const w = await mountSuspended(WorkspaceAddSheet, { props: { open: false, taken: [] }, global: { stubs } })
  appConfig.value = { ...appConfig.value, machines: [{ key: '', label: 'home', local: true }, { key: 'big', label: 'Build box', local: false, home: '/home/user' }] } as typeof appConfig.value
  await w.setProps({ open: true })
  await w.findAll('[data-testid="add-workspace-machine"] button[role="checkbox"]')[1]!.trigger('click')
  // Offline: its Browse is disabled.
  expect(w.findAll('[data-testid="add-workspace-browse"]')[1]!.attributes('disabled')).toBeDefined()
  herdrState.value = { ...herdrState.value, machines: [{ key: 'big', status: 'online' }] } as typeof herdrState.value
  await flushPromises()
  const root = () => w.findAll('input[data-testid="add-workspace-root"]')[1]!
  const browser = () => w.findComponent(DirBrowser)
  // A folder that does not exist there: the browser starts at the machine's home.
  await root().setValue('~/nowhere')
  await w.findAll('[data-testid="add-workspace-browse"]')[1]!.trigger('click')
  await vi.waitFor(() => expect(browser().exists()).toBe(true))
  expect(browser().props()).toEqual({ machine: 'big', start: null })
  expect(w.get('form').attributes('style')).toContain('display: none')
  browser().vm.$emit('cancel')
  await flushPromises()
  expect(browser().exists()).toBe(false)
  expect((root().element as HTMLInputElement).value).toBe('~/nowhere')
  // An existing folder: it starts there; the chosen folder fills that machine's root.
  await root().setValue('~/apps')
  await w.findAll('[data-testid="add-workspace-browse"]')[1]!.trigger('click')
  await vi.waitFor(() => expect(browser().exists()).toBe(true))
  expect(browser().props()).toEqual({ machine: 'big', start: '~/apps' })
  browser().vm.$emit('choose', '/home/user/apps/payroll')
  await flushPromises()
  expect((root().element as HTMLInputElement).value).toBe('~/apps/payroll')
  expect((w.findAll('input[data-testid="add-workspace-root"]')[0]!.element as HTMLInputElement).value).toBe('~/work')
  w.unmount()
})
