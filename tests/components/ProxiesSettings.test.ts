// Settings › Agents › Proxies: the list (name, masked url, machines), the
// add/edit form posting the whole list — a ••• url going back as it came —
// and delete/reorder.
import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ProxiesSettings from '~/components/ProxiesSettings.vue'
import { appConfig, herdrState } from '~/composables/useHerdr'
import { proxies } from '~/composables/useProxies'
import type { ProxyEntry } from '#shared/proxies'

let store: ProxyEntry[] = []
const posted: ProxyEntry[][] = []
registerEndpoint('/api/proxies', async (event) => {
  if (event.method === 'GET') return { proxies: store, last: {} }
  const { readBody } = await import('h3')
  const body = await readBody<{ proxies: ProxyEntry[] }>(event as never)
  posted.push(body.proxies)
  // Answer like the server: ids assigned, every password masked.
  store = body.proxies.map((p, i) => ({ ...p, id: p.id || `px${i + 1}` }))
  return { proxies: store, last: {} }
})

afterEach(() => { store = []; posted.length = 0; proxies.value = []; appConfig.value = { kinds: ['claude'], home: '/h', dirs: [], push: { enabled: false, key: null, devices: 0 } }; herdrState.value = { ok: false, workspaces: [], panes: [] } })

it('adds, edits (mask untouched) and deletes an entry', async () => {
  store = [{ id: 'px1', name: 'office', url: 'http://alice:•••@proxy.example:3128' }]
  const w = await mountSuspended(ProxiesSettings)
  await flushPromises()
  expect(w.text()).toContain('office')
  expect(w.text()).toContain('http://alice:•••@proxy.example:3128')

  // Add: the form posts the whole list with the new entry (no id).
  await w.get('[data-testid="proxy-add"]').trigger('click')
  await w.get('[data-testid="proxy-name"]').setValue('home socks')
  await w.get('[data-testid="proxy-url"]').setValue('socks5://127.0.0.1:7890')
  await w.get('form[data-testid="proxy-form"]').trigger('submit')
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(posted.at(-1)).toHaveLength(2)
  expect(posted.at(-1)![1]).toMatchObject({ name: 'home socks', url: 'socks5://127.0.0.1:7890' })

  // Edit: the masked url goes back exactly as shown — the server keeps the password.
  await w.get('[data-row="px1"] [aria-label*="Edit"]').trigger('click')
  await flushPromises()
  expect((w.get('[data-testid="proxy-url"]').element as HTMLInputElement).value).toBe('http://alice:•••@proxy.example:3128')
  await w.get('form[data-testid="proxy-form"]').trigger('submit')
  await vi.waitFor(() => expect(posted).toHaveLength(2))
  expect(posted.at(-1)![0]!.url).toBe('http://alice:•••@proxy.example:3128')

  // Delete.
  await w.get('[data-row="px1"] [aria-label*="Delete"]').trigger('click')
  await vi.waitFor(() => expect(posted).toHaveLength(3))
  expect(posted.at(-1)!.map(p => p.id)).toEqual(['px2'])
  w.unmount()
})

it('reorders with the step buttons', async () => {
  store = [{ id: 'a', name: 'one', url: 'http://proxy.example:1' }, { id: 'b', name: 'two', url: 'http://proxy.example:2' }]
  const w = await mountSuspended(ProxiesSettings)
  await flushPromises()
  await w.get('[data-row="b"] .key-order-up').trigger('click')
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(posted.at(-1)!.map(p => p.id)).toEqual(['b', 'a'])
  w.unmount()
})

it('offers machine checkboxes when several machines exist', async () => {
  store = []
  appConfig.value = { kinds: ['claude'], home: '/h', dirs: [], push: { enabled: false, key: null, devices: 0 },
    machines: [{ key: '', label: 'Laptop', local: true, home: '/h', dirs: [], online: true, kinds: [] }, { key: 'vps', label: 'vps', local: false, home: '/h', dirs: [], online: true, kinds: [] }] }
  herdrState.value = { ok: true, workspaces: [], panes: [], machines: [
    { key: '', label: 'Laptop', local: true, status: 'online', error: null },
    { key: 'vps', label: 'vps', local: false, status: 'online', error: null }] }
  const w = await mountSuspended(ProxiesSettings)
  await flushPromises()
  await w.get('[data-testid="proxy-add"]').trigger('click')
  expect(w.findAll('.proxy-machine input').length).toBeGreaterThan(0)
  await w.get('[data-testid="proxy-name"]').setValue('only vps')
  await w.get('[data-testid="proxy-url"]').setValue('http://proxy.example:3128')
  const boxes = w.findAll('.proxy-machine input')
  await boxes[1]!.setValue(true)
  await w.get('form[data-testid="proxy-form"]').trigger('submit')
  await vi.waitFor(() => expect(posted).toHaveLength(1))
  expect(posted.at(-1)![0]).toMatchObject({ name: 'only vps', machines: ['vps'] })
  w.unmount()
})
