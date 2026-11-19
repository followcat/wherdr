import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import AwakePending from '~/components/AwakePending.vue'
import { menuState } from '~/composables/useUi'
import type { AwakeState } from '#shared/awake'

const state: AwakeState = { supported: true, platform: 'mac', active: false, until: null, battery: null, lidClosed: null, eveningPast: false }
let hold: Promise<void> | null = null
registerEndpoint('/api/machine/awake', { method: 'GET', handler: async () => { await hold; return state } })
registerEndpoint('/api/machine/awake', { method: 'POST', handler: async () => { await hold; return { ...state, active: true } } })

afterEach(() => { hold = null; awakeBusy.value = {}; awakeByMachine.value = {} })
const held = () => { let answer!: () => void; hold = new Promise(r => { answer = r }); return answer }

describe('keep awake from Home: pending feedback', () => {
  it('shows a loader while the machine is read, then while a menu choice is applied', async () => {
    const w = await mountSuspended(AwakePending)
    const pill = () => w.find('[data-testid="awake-pending"]')
    let answer = held()
    const read = openAwake({ key: 'laptop', label: 'Laptop' })
    await vi.waitFor(() => expect(pill().text()).toBe('Asking Laptop…'))
    answer(); await read
    await vi.waitFor(() => expect(pill().exists()).toBe(false))
    answer = held()
    menuState.open = false
    menuState.items.find(i => i.label === '1 hour')!.run!()
    await vi.waitFor(() => expect(pill().text()).toBe('Applying keep awake on Laptop…'))
    answer()
    await vi.waitFor(() => expect(awakeByMachine.value.laptop?.active).toBe(true))
    await vi.waitFor(() => expect(pill().exists()).toBe(false))
    w.unmount()
  })
})
