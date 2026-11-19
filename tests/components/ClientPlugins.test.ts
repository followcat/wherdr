import { expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import ClientPlugins from '~/components/ClientPlugins.vue'
import { clientPlugins, communityPlugins } from '~/composables/useClientPlugins'
import { answerConfirm, confirmState } from '~/composables/useUi'

registerEndpoint('/api/client-plugins', () => ({ plugins: [], enabled: false }))

it('says so when no plugin is installed', async () => {
  clientPlugins.value = []
  const w = await mountSuspended(ClientPlugins)
  expect(w.text()).toContain('No plugin installed')
})

it('turns Community plugins on only after the full-access warning', async () => {
  const w = await mountSuspended(ClientPlugins)
  communityPlugins.value = false
  const sw = () => w.find('[data-wherdr="community-plugins"] [role="switch"]')
  await sw().trigger('click')
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  expect(confirmState.message).toContain('full access')
  expect(confirmState.action).toBe('Turn on')
  answerConfirm(false)
  await nextTick()
  expect(communityPlugins.value).toBe(false)
  await sw().trigger('click')
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  answerConfirm(true)
  await vi.waitFor(() => expect(communityPlugins.value).toBe(true))
})

it('lists a plugin disabled after an error with its message', async () => {
  const w = await mountSuspended(ClientPlugins)
  clientPlugins.value = [{ id: 'demo', name: 'Demo', version: '1.0', description: '', main: 'index.js', status: 'failed', error: 'boom' }]
  await nextTick()
  const li = w.find('[data-plugin="demo"]')
  expect(li.text()).toContain('Disabled after an error')
  expect(li.find('[role="alert"]').text()).toBe('boom')
})

it('Update leaves Community plugins off, so nothing starts without the full-access warning', async () => {
  const source = { repo: 'me/demo', ref: '', commit: 'a'.repeat(40) }
  const installed: unknown[] = []
  registerEndpoint('/api/client-plugins/check', () => ({ update: { id: 'demo', name: 'Demo', version: '1.1', description: '', main: 'index.js', source: { ...source, commit: 'b'.repeat(40) }, resolved: 'main', update: true } }))
  registerEndpoint('/api/client-plugins/install', () => { installed.push(1); return { plugin: {} } })
  const w = await mountSuspended(ClientPlugins)
  communityPlugins.value = false
  await flushPromises()
  clientPlugins.value = [{ id: 'demo', name: 'Demo', version: '1.0', description: '', main: 'index.js', status: 'off', wanted: true, source }]
  await nextTick()
  const button = (label: string) => w.findAll('[data-plugin="demo"] button').find(b => b.text() === label)
  await button('Check for update')!.trigger('click')
  await vi.waitFor(() => expect(button('Update')).toBeTruthy())
  await button('Update')!.trigger('click')
  await vi.waitFor(() => expect(installed).toHaveLength(1))
  // The refresh after the install lists no plugin (the endpoint above): the update is done.
  await vi.waitFor(() => expect(w.find('[data-plugin="demo"]').exists()).toBe(false))
  await flushPromises()
  expect(confirmState.open).toBe(false)
  expect(communityPlugins.value).toBe(false)
})
