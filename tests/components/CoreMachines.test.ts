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
let localSessions: { directory: string | null, primary: string, envSockets: string[], settingsSockets: string[], available: { path: string, name: string }[] } = {
  directory: '/run/herdr-core', primary: '/run/herdr-core/default.sock', envSockets: [], settingsSockets: [], available: [],
}
const settingsPosts: unknown[] = []
registerEndpoint('/api/machine/local-sessions', () => localSessions)
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
afterEach(() => { mounted?.unmount(); mounted = null; hostPort = true; added = []; failWith = ''; localSessions = { directory: '/run/herdr-core', primary: '/run/herdr-core/default.sock', envSockets: [], settingsSockets: [], available: [] }; settingsPosts.length = 0; localStorage.removeItem('hcSockets'); document.body.innerHTML = '' })
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
  it('shows sockets in use, with a remove control only for the ones saved in settings', async () => {
    localStorage.setItem('hcSockets', JSON.stringify(['/run/herdr-core/backlot.sock']))
    localSessions = { ...localSessions, envSockets: ['/run/herdr-core/env.sock'], settingsSockets: ['/run/herdr-core/backlot.sock'] }
    const w = await mount()
    const rows = w.findAll('[data-testid="hc-session-row"]')
    expect(rows.map(r => r.text())).toEqual(expect.arrayContaining([expect.stringContaining('env.sock'), expect.stringContaining('backlot.sock')]))
    const envRow = rows.find(r => r.text().includes('env.sock'))!
    const settingsRow = rows.find(r => r.text().includes('backlot.sock'))!
    expect(envRow.find('[data-testid="hc-session-remove"]').exists()).toBe(false)
    expect(settingsRow.find('[data-testid="hc-session-remove"]').exists()).toBe(true)
  })

  it('Find local sessions lists the sockets not in use, and one tap saves the choice', async () => {
    localSessions = { ...localSessions, available: [{ path: '/run/herdr-core/backlot.sock', name: 'backlot' }] }
    const w = await mount()
    await w.get('[data-testid="find-local-sessions"]').trigger('click')
    await vi.waitFor(() => expect(w.find('[data-testid="local-session-add"]').exists()).toBe(true))
    expect(w.get('[data-testid="local-session-add"]').text()).toContain('backlot')
    await w.get('[data-testid="local-session-add"]').trigger('click')
    expect(w.find('[data-testid="local-session-add"]').exists()).toBe(false)
    expect(w.text()).toContain('backlot.sock')
    await vi.waitFor(() => expect(settingsPosts.length).toBeGreaterThan(0), { timeout: 1200 })
    const patch = (settingsPosts.at(-1) as { settings: Record<string, string> }).settings
    expect(JSON.parse(patch.hcSockets!)).toEqual(['/run/herdr-core/backlot.sock'])
  })

  it('removing a settings socket saves the shorter list', async () => {
    localStorage.setItem('hcSockets', JSON.stringify(['/run/herdr-core/backlot.sock']))
    localSessions = { ...localSessions, settingsSockets: ['/run/herdr-core/backlot.sock'] }
    const w = await mount()
    expect(w.text()).toContain('backlot.sock')
    await w.get('[data-testid="hc-session-remove"]').trigger('click')
    expect(w.text()).not.toContain('backlot.sock')
    await vi.waitFor(() => expect(settingsPosts.length).toBeGreaterThan(0), { timeout: 1200 })
    const patch = (settingsPosts.at(-1) as { settings: Record<string, string> }).settings
    expect(JSON.parse(patch.hcSockets!)).toEqual([])
  })
})
