import { expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import PluginInstallSheet from '~/components/PluginInstallSheet.vue'
import { communityPlugins } from '~/composables/useClientPlugins'

const COMMIT = 'c'.repeat(40)
const source = { repo: 'me/hello', ref: '', commit: COMMIT }
const installed: unknown[] = []
registerEndpoint('/api/client-plugins', () => ({ plugins: [], enabled: false }))
registerEndpoint('/api/client-plugins/preview', () => ({ preview: { id: 'hello', name: 'Hello', version: '1.0.0', description: 'Says hello.', main: 'index.js', source, resolved: 'v1.0.0', update: false } }))
registerEndpoint('/api/client-plugins/install', async (event) => {
  const { readBody } = await import('h3')
  installed.push(await readBody(event as never))
  return { plugin: {} }
})
const stubs = { AppSheet: { template: '<section><slot /><slot name="footer" /></section>' } }

it('shows the plugin, its exact commit and the full-access warning, then installs and turns Community plugins on', async () => {
  communityPlugins.value = false
  const w = await mountSuspended(PluginInstallSheet, { props: { open: true }, global: { stubs } })
  await w.get('input').setValue('me/hello')
  await w.get('form').trigger('submit')
  await vi.waitFor(() => expect(w.find('[data-wherdr="plugin-install-preview"]').exists()).toBe(true))
  const card = w.get('[data-wherdr="plugin-install-preview"]').text()
  expect(card).toContain('Hello')
  expect(card).toContain('me/hello @ v1.0.0')
  expect(card).toContain(COMMIT)
  expect(card).toContain('full access')
  expect(installed).toHaveLength(0)
  await w.findAll('button').find(b => b.text() === 'Install')!.trigger('click')
  await vi.waitFor(() => expect(installed).toEqual([{ source }]))
  await flushPromises()
  expect(communityPlugins.value).toBe(true)
})
