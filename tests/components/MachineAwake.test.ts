import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import MachineAwake from '~/components/MachineAwake.vue'
import type { AwakeState } from '#shared/awake'

const base: AwakeState = { supported: true, platform: 'mac', active: false, until: null, battery: null, lidClosed: null, eveningPast: false }
let state: AwakeState = base
registerEndpoint('/api/machine/awake', () => state)

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; state = base; awakeByMachine.value = {} })
async function mount(online = true) {
  awakeByMachine.value = {}
  const w = await mountSuspended(MachineAwake, { props: { machineKey: 'machine-a', online } })
  mounted = w
  if (online) await vi.waitFor(() => expect(awakeByMachine.value['machine-a']).toBeTruthy())
  return w
}
const line = (w: Awaited<ReturnType<typeof mount>>, id: string) => w.find(`[data-testid="${id}"]`)

describe('machine card: keep awake', () => {
  it('shows nothing while the machine sleeps normally, or is offline', async () => {
    expect((await mount()).text()).toBe('')
    state = { ...base, active: true }
    expect((await mount(false)).text()).toBe('')
  })
  it('shows until when, or until turned off', async () => {
    const until = new Date(2026, 10, 9, 18, 0).getTime()
    state = { ...base, active: true, until }
    expect(line(await mount(), 'machine-awake').text()).toBe(`Awake until ${fmtTime(until)}`)
    mounted!.unmount()
    state = { ...base, active: true }
    expect(line(await mount(), 'machine-awake').text()).toBe('Awake until turned off')
  })
  it('warns a laptop on battery, lid open or closed', async () => {
    state = { ...base, active: true, battery: { percent: 40, source: 'battery' }, lidClosed: false }
    expect(line(await mount(), 'machine-awake-warn').text()).toBe('On battery: closing the lid puts it to sleep')
    mounted!.unmount()
    state = { ...state, lidClosed: true }
    expect(line(await mount(), 'machine-awake-warn').text()).toBe('Lid closed on battery: this machine will sleep')
    mounted!.unmount()
    state = { ...state, battery: { percent: 40, source: 'ac' } }
    expect(line(await mount(), 'machine-awake-warn').exists()).toBe(false)
  })
})
