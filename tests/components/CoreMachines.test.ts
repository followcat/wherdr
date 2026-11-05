import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import CoreMachines from '~/components/CoreMachines.vue'

// hostPort comes from the core's rpc.discover (tests/core-capabilities.test.ts):
// false for a recorded 0.1.16 core, true for 0.1.17, null when unreadable.
let hostPort: boolean | null = true
let added: unknown[] = []
registerEndpoint('/api/machine/core', () => ({ version: '0.1.16', pid: 1, uptimeMs: 60000, live: 0, finished: 0, name: null, hostPort }))
registerEndpoint('/api/machine/add', { method: 'POST', handler: async (event) => { added.push(await readBody(event)); return { ok: true } } })

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; hostPort = true; added = [] })
async function mount() {
  const w = await mountSuspended(CoreMachines)
  mounted = w
  await vi.waitFor(() => expect(w.find('[data-testid="core-line"]').exists()).toBe(true))
  return w
}
const addButton = (w: Awaited<ReturnType<typeof mount>>) => w.findAll('button').find(b => b.text() === 'Add machine')!

describe('Add machine and host:port', () => {
  it('refuses a port before sending when the core takes none, and still adds a plain target', async () => {
    hostPort = false
    const w = await mount()
    const input = w.find('#machineTarget')
    expect(input.attributes('placeholder')).toBe('user@10.0.0.7')
    await input.setValue('me@10.0.0.7:2222')
    expect(w.find('[data-testid="machine-port-hint"]').text()).toBe('This herdr-core takes no port: update it, or use a Host from ~/.ssh/config')
    expect(addButton(w).attributes('disabled')).toBeDefined()
    await w.find('form.sheet-form').trigger('submit')
    expect(added).toEqual([])
    await input.setValue('me@10.0.0.7')
    expect(w.find('[data-testid="machine-port-hint"]').exists()).toBe(false)
    await w.find('form.sheet-form').trigger('submit')
    await vi.waitFor(() => expect(added).toEqual([{ target: 'me@10.0.0.7' }]))
  })
  it.each([true, null])('sends user@host:port when the core takes one (hostPort %s)', async (value) => {
    hostPort = value
    const w = await mount()
    const input = w.find('#machineTarget')
    expect(input.attributes('placeholder')).toBe('user@10.0.0.7:22')
    await input.setValue('me@10.0.0.7:2222')
    expect(w.find('[data-testid="machine-port-hint"]').exists()).toBe(false)
    expect(addButton(w).attributes('disabled')).toBeUndefined()
    await w.find('form.sheet-form').trigger('submit')
    await vi.waitFor(() => expect(added).toEqual([{ target: 'me@10.0.0.7:2222' }]))
  })
})
