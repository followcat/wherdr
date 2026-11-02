// Home quota strip: one row per provider. The compact layout (main.css) puts
// each window's label and percentage together, then a thin bar, then the
// reset time; every piece must still be there, with the urgency and
// old-reading states.
import { afterEach, describe, expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import QuotaStrip from '~/components/QuotaStrip.vue'
import { quotaNow } from '~/composables/useQuotas'
import { quotaDisplay } from '~/composables/useHerdr'
import { resetText, type QuotaRow } from '~/utils/quotas'

const now = Date.now()
const win = (used: number, inMin: number, minutes: number) => ({ used, resetsAt: now + inMin * 60000, minutes })

function rows(): QuotaRow[] {
  return [
    { key: 'claude', agent: 'claude', q: { five: win(16, 132, 300), week: win(49, 3 * 1440, 10080), at: now - 20000 } },
    // Read two hours ago: its week has reset since.
    { key: 'codex', agent: 'codex', q: { five: win(90, 47, 300), week: win(62, -60, 10080), at: now - 2 * 3600000 } },
  ]
}

afterEach(() => { quotaDisplay.value = 'left' })

describe('QuotaStrip', () => {
  it('keeps icon, reading age, both windows with percentage, bar and reset time per provider', async () => {
    quotaNow.value = now
    const w = await mountSuspended(QuotaStrip, { props: { rows: rows() } })
    const lines = w.findAll('.quota-row')
    expect(lines).toHaveLength(2)

    const claude = lines[0]!
    expect(claude.find('.quota-who .avatar').exists()).toBe(true)
    expect(claude.find('.quota-who small').text()).toBe('< 1 min')
    const [five, week] = claude.findAll('.quota')
    // Label and percentage share one group, followed by the bar, then the reset.
    expect(five!.element.children[0]!.className).toBe('quota-top')
    expect(five!.element.children[1]!.className).toBe('quota-bar')
    expect(five!.element.children[2]!.className).toBe('quota-reset')
    expect(five!.find('.quota-label').text()).toBe('5 h')
    expect(five!.find('.quota-top b').text()).toBe('84%')
    expect(five!.find('.quota-bar i').attributes('style')).toContain('width: 84%')
    expect(five!.find('.quota-reset').text()).toBe(resetText(rows()[0]!.q.five!, now, 'en'))
    expect(week!.find('.quota-top b').text()).toBe('51%')
    // Beyond 24 h the reset carries the day.
    expect(week!.find('.quota-reset').text()).toMatch(/^\S+ \S/)
    expect(claude.classes()).not.toContain('stale')
  })

  it('shows the urgency, the old reading and the reset since the reading', async () => {
    quotaNow.value = now
    const w = await mountSuspended(QuotaStrip, { props: { rows: rows() } })
    const codex = w.findAll('.quota-row')[1]!
    expect(codex.classes()).toContain('stale')
    expect(codex.find('.quota-who small').text()).toBe('2 h')
    const [five, week] = codex.findAll('.quota')
    expect(five!.classes()).toContain('hi')
    expect(five!.find('.quota-top b').text()).toBe('10%')
    expect(week!.classes()).toContain('guessed')
    expect(week!.find('.quota-top b').text()).toBe('100%')
    expect(week!.find('.quota-reset').text().toLowerCase()).toBe('reset')
  })

  it('a missing window keeps its empty cell so the columns stay aligned', async () => {
    quotaNow.value = now
    const w = await mountSuspended(QuotaStrip, { props: { rows: [{ key: 'claude', agent: 'claude', q: { five: win(10, 30, 300), week: null, at: now } }] } })
    expect(w.findAll('.quota')).toHaveLength(2)
    expect(w.find('.quota.empty').exists()).toBe(true)
  })
})

describe('QuotaStrip on API billing', () => {
  it('shows a muted label instead of gauges, with no warning colour', async () => {
    quotaNow.value = now
    const w = await mountSuspended(QuotaStrip, { props: { rows: [], api: true } })
    const row = w.find('[data-testid="quota-claude-api"]')
    expect(row.exists()).toBe(true)
    expect(row.find('.quota-api-label').text()).toBe('Claude · API usage, no quota')
    expect(row.find('.quota-who .avatar').exists()).toBe(true)
    expect(w.findAll('.quota')).toHaveLength(0)
    expect(w.find('.hi, .mid, .stale').exists()).toBe(false)
  })

  it('sits before the other rows and is absent without API billing', async () => {
    quotaNow.value = now
    const both = await mountSuspended(QuotaStrip, { props: { rows: rows().slice(1), api: true } })
    expect(both.findAll('.quota-row').map(r => r.classes().includes('quota-api'))).toEqual([true, false])
    const none = await mountSuspended(QuotaStrip, { props: { rows: [] } })
    expect(none.find('.quotas').exists()).toBe(false)
  })
})
