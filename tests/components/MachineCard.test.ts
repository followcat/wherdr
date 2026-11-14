import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import MachineCard from '~/components/MachineCard.vue'
import type { AwakeState } from '#shared/awake'

const awake: AwakeState = { supported: true, platform: 'mac', active: true, until: null, battery: { percent: 40, source: 'battery' }, lidClosed: false, eveningPast: false }
registerEndpoint('/api/machine/awake', () => awake)
let sent: unknown[] = []
registerEndpoint('/api/machine/memory', { method: 'POST', handler: async (event) => { sent.push(await readBody(event)); return { machines: [] } } })

const memory: MemoryRow = { key: 'machine-b', label: 'machine-b', mem: null, settings: { minFreeMb: 2048 }, agents: 1, cap: 5, line: 'Available · 6 GB free · 1 agent' }
const remote = { key: 'machine-b', label: 'machine-b', local: false, status: 'online' as const, error: null }
let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; sent = []; awakeByMachine.value = {} })
async function mount(props: InstanceType<typeof MachineCard>['$props']) {
  const w = await mountSuspended(MachineCard, { props })
  mounted = w
  return w
}
const slots = (w: Awaited<ReturnType<typeof mount>>) => w.find('.machine-actions').element.children.length

describe('machine card', () => {
  it('this machine: its badge, keep awake alone in the first action slot', async () => {
    const w = await mount({ machine: { key: 'machine-a', label: 'machine-a', local: true, status: 'online', error: null } })
    expect(w.find('[data-testid="machine-state"]').text()).toBe('Host')
    expect(w.find('[data-testid="machine-awake-open"]').exists()).toBe(true)
    expect(w.find('[data-testid="machine-rename"]').exists()).toBe(false)
    expect(slots(w)).toBe(1)
  })
  it('a connected machine: three actions, keep-awake line and battery warning under the name, then its memory settings', async () => {
    const w = await mount({ machine: remote, memory })
    expect(w.find('[data-testid="machine-state"]').text()).toBe('Connected')
    expect(slots(w)).toBe(3)
    await vi.waitFor(() => expect(w.find('.machine-sub [data-testid="machine-awake"]').text()).toBe('Awake until turned off'))
    expect(w.find('.machine-sub [data-testid="machine-awake-warn"]').text()).toBe('On battery: closing the lid puts it to sleep')
    expect(w.find('.machine-memory [data-testid="memory-line"]').text()).toBe(memory.line)
    const min = w.find('[data-testid="memory-min"]')
    expect((min.element as HTMLInputElement).value).toBe('2')
    await min.setValue('3')
    await vi.waitFor(() => expect(sent).toEqual([{ key: 'machine-b', minFreeGb: 3 }]))
  })
  it('empty memory fields are Auto: the placeholder shows the pick, emptying one sends null', async () => {
    const w = await mount({ machine: remote, memory: { ...memory, settings: {}, autoReserve: 1229, cap: 6 } })
    const min = w.find('[data-testid="memory-min"]'), cap = w.find('[data-testid="memory-cap"]')
    expect([(min.element as HTMLInputElement).value, min.attributes('placeholder')]).toEqual(['', 'Auto (≈1.2 GB)'])
    expect([(cap.element as HTMLInputElement).value, cap.attributes('placeholder')]).toEqual(['', 'Auto (6)'])
    expect(w.find('[data-testid="memory-auto-hint"]').exists()).toBe(true)
    await cap.setValue('')
    await vi.waitFor(() => expect(sent).toEqual([{ key: 'machine-b', maxAgents: null }]))
  })
  it('an offline machine keeps the keep-awake slot empty and offers Reconnect', async () => {
    const w = await mount({ machine: { ...remote, status: 'offline', error: 'unreachable' } })
    expect(w.find('[data-testid="machine-state"]').text()).toBe('Offline')
    expect(w.find('[data-testid="machine-awake-open"]').exists()).toBe(false)
    expect(slots(w)).toBe(3)
    await w.findAll('button').find(b => b.text() === 'Reconnect')!.trigger('click')
    expect(w.emitted('reconnect')).toHaveLength(1)
  })
})
