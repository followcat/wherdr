import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody, setResponseStatus } from 'h3'
import CoreMachines from '~/components/CoreMachines.vue'

// hostPort comes from the core's rpc.discover (tests/core-capabilities.test.ts):
// false for a recorded 0.1.16 core, true for 0.1.17, null when unreadable.
let hostPort: boolean | null = true
let added: unknown[] = []
let failWith = ''
registerEndpoint('/api/machine/core', () => ({ version: '0.1.16', pid: 1, uptimeMs: 60000, live: 0, finished: 0, name: null, hostPort }))
const settingsPosts: unknown[] = []
registerEndpoint('/api/settings', { method: 'POST', handler: async (event) => {
  const body = await readBody(event)
  settingsPosts.push(body)
  return { settings: Object.fromEntries(Object.entries((body as { settings?: Record<string, string> }).settings || {}).map(([k, v]) => [k, v])) }
} })
registerEndpoint('/api/machine/add', { method: 'POST', handler: async (event) => {
  if (failWith) { setResponseStatus(event, 400); return { error: failWith } }
  added.push(await readBody(event))
  return { ok: true }
} })

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; hostPort = true; added = []; failWith = ''; settingsPosts.length = 0; localStorage.removeItem('hcSockets'); document.body.innerHTML = '' })
async function mount() {
  const w = await mountSuspended(CoreMachines, { attachTo: document.body })
  mounted = w
  await vi.waitFor(() => expect(w.find('[data-testid="core-line"]').exists()).toBe(true))
  return w
}

// This machine's key is '': it must not read as the card being renamed (renaming = '').
it('shows this machine as a card, not in rename mode', async () => {
  const w = await mount()
  expect(w.find('[data-testid="local-machine"] .machine-state').text()).toBe('Host')
  expect(w.find('.rename-form').exists()).toBe(false)
})
// The Add machine sheet is teleported to the body.
const $ = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const button = (label: string) => [...document.body.querySelectorAll('button')].find(b => b.textContent?.trim() === label)!
async function openAdd(w: Awaited<ReturnType<typeof mount>>) {
  await w.find('[data-ui-target="machines.add"]').trigger('click')
  await vi.waitFor(() => expect($('#machineTarget')).not.toBeNull())
}
async function type(sel: string, value: string) {
  const input = $<HTMLInputElement>(sel)!
  input.value = value
  input.dispatchEvent(new Event('input'))
  await nextTick()
}

describe('Add machine', () => {
  it('opens a sheet from the button; Add shows the confirmation, Confirm adds', async () => {
    const w = await mount()
    expect($('#machineTarget')).toBeNull()
    await openAdd(w)
    await type('#machineTarget', 'user@10.0.0.7:22')
    await type('#machineName', 'vps')
    button('Add').click()
    await vi.waitFor(() => expect($('[data-testid="machine-add-confirm"]')?.textContent).toContain('wherdr will connect over SSH and check hc'))
    expect(added).toEqual([])
    button('Confirm').click()
    await vi.waitFor(() => expect(added).toEqual([{ target: 'user@10.0.0.7:22', name: 'vps' }]))
    await vi.waitFor(() => expect($('[data-testid="machine-add-confirm"]')).toBeNull())
  })
  it('keeps the sheet open with the error', async () => {
    failWith = 'The machine cannot be reached over SSH'
    const w = await mount()
    await openAdd(w)
    await type('#machineTarget', 'user@10.0.0.7')
    button('Add').click()
    await vi.waitFor(() => expect(button('Confirm')).toBeDefined())
    button('Confirm').click()
    await vi.waitFor(() => expect($('[data-testid="machine-add-confirm"] [role="alert"]')?.textContent).toBe('The machine cannot be reached over SSH'))
  })
  it('refuses a port before sending when the core takes none', async () => {
    hostPort = false
    const w = await mount()
    await openAdd(w)
    expect($('#machineTarget')!.getAttribute('placeholder')).toBe('user@10.0.0.7')
    await type('#machineTarget', 'me@10.0.0.7:2222')
    expect($('[data-testid="machine-port-hint"]')?.textContent).toBe('This herdr-core takes no port: update it, or use a Host from ~/.ssh/config')
    expect(button('Add').disabled).toBe(true)
    await type('#machineTarget', 'me@10.0.0.7')
    expect($('[data-testid="machine-port-hint"]')).toBeNull()
    expect(button('Add').disabled).toBe(false)
  })
})


describe('extra hc sessions', () => {
  it('does not show the removed manual local-session settings controls', async () => {
    localStorage.setItem('hcSockets', JSON.stringify(['/run/herdr-core/backlot.sock']))
    const w = await mount()
    expect(w.find('[data-testid="extra-hc-sessions"]').exists()).toBe(false)
    expect(w.find('[data-testid="find-local-sessions"]').exists()).toBe(false)
    expect(w.text()).not.toContain('Extra sessions')
    expect(settingsPosts).toEqual([])
  })
})
