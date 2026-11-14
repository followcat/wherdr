// Machine quotas grouped by account: a shared account's numbers show once,
// with the machines that share it as chips under its title.
import { describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import MachineQuotaBlocks from '~/components/MachineQuotaBlocks.vue'
import { quotaNow } from '~/composables/useQuotas'
import { machineQuotaRows, quotaBlocks } from '~/utils/quotas'
import type { Quotas } from '#shared/types'

const now = Date.now()
const win = (used: number) => ({ used, resetsAt: now + 3600000, minutes: 300 })

describe('MachineQuotaBlocks', () => {
  it('renders one block per account with its machines, and a limited account once', async () => {
    quotaNow.value = now
    const q: Quotas = {
      claude: null, codex: null,
      claudeAccounts: [
        { five: win(10), week: win(20), at: now, key: 'claude:aaaa1111', machines: [{ key: 'a', label: 'machine-a' }, { key: 'b', label: 'machine-b' }] },
        { five: null, week: null, at: now, limited: { resetsAt: null }, key: 'claude:bbbb2222', name: 'Work', machines: [{ key: 'c', label: 'machine-c' }] },
      ],
    }
    const machines = ['a', 'b', 'c'].map(k => ({ key: k, name: `machine-${k}`, quotas: machineQuotaRows(q, k), api: false }))
    const w = await mountSuspended(MachineQuotaBlocks, { props: { blocks: quotaBlocks(machines) } })
    const blocks = w.findAll('.state-machine-quotas')
    expect(blocks.map(b => b.find('.state-machine-quotas-label').text())).toEqual(['Claude aaaa', 'Work'])
    expect(blocks[0]!.findAll('.state-machine-quotas-machines li').map(li => li.text())).toEqual(['machine-a', 'machine-b'])
    expect(blocks[0]!.findAll('.quota-row')).toHaveLength(1)
    expect(blocks[1]!.findAll('[data-testid="quota-limited"]').map(e => e.text())).toEqual(['Limit reached'])
  })
})
