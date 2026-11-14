import { afterEach, expect, it, vi } from 'vitest'
import { mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import PacingSettings from '~/components/PacingSettings.vue'
import { DEFAULT_PACE, mergePolicy } from '#shared/pm/pacing'
import type { PaceRow } from '#shared/pm/pace'
import { pick, selectValue } from '../helpers/select'

// A fake server: one Claude account ahead of its line, Codex never read.
const now = Date.now()
let rows: PaceRow[]
const calls: { url: string, body: Record<string, unknown> }[] = []
const reset = () => {
  rows = [
    {
      program: 'claude', account: { key: 'claude:a1b2c3d4', program: 'claude', machines: [''] }, policy: { ...DEFAULT_PACE, mode: 'free', days: [1, 5] },
      week: { used: 60, resetsAt: now + 3 * 86_400_000, limit: 54, label: 'line' }, five: { used: 30, resetsAt: now + 3_600_000 },
      at: now, today: 9, verdict: { go: false, reason: 'ahead', until: now + 86_400_000 },
    },
    { program: 'codex', account: null, policy: DEFAULT_PACE, week: null, five: null, at: null, today: null, verdict: { go: true, unknown: true } },
  ]
  calls.length = 0
}
reset()
registerEndpoint('/api/pacing', {
  handler: async (event) => {
    if (event.method === 'GET') return { rows }
    const body = await readBody(event)
    calls.push({ url: '/api/pacing', body })
    rows = rows.map(r => r.account?.key === body.key ? { ...r, policy: mergePolicy(r.policy, body.policy) } : r)
    return { rows }
  },
})
registerEndpoint('/api/quotas/name', {
  method: 'POST',
  handler: async (event) => {
    const body = await readBody(event)
    calls.push({ url: '/api/quotas/name', body })
    rows = rows.map(r => r.account?.key === body.key ? { ...r, account: { ...r.account!, name: body.name } } : r)
    return { key: body.key, name: body.name }
  },
})

let mounted: { unmount: () => void } | null = null
afterEach(() => { mounted?.unmount(); mounted = null; reset(); quotaDisplay.value = 'left' })

it('an account with credits keeps its bars and auto state; a program with no reading shows no auto state', async () => {
  rows[0] = { ...rows[0]!, credits: { unlimited: false, balance: 120 } }
  const w = await mountSuspended(PacingSettings, { props: { active: true } })
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="pace-row"]')).toHaveLength(2))
  const [account, codex] = w.findAll('[data-testid="pace-row"]')
  expect(account!.find('[data-testid="pace-credits"]').text()).toBe('Credits: 120 credits')
  expect(account!.find('[data-testid="pace-week"]').exists()).toBe(true)
  expect(account!.find('[data-testid="pace-state"]').exists()).toBe(true)
  expect(codex!.find('[data-testid="pace-state"]').exists()).toBe(false)
  expect(codex!.find('[data-testid="pace-credits"]').exists()).toBe(false)
})

it('shows each account\'s pace, changes its mode, days, numbers and name; a program with no reading is unknown', async () => {
  const w = await mountSuspended(PacingSettings, { props: { active: true } })
  mounted = w
  await vi.waitFor(() => expect(w.findAll('[data-testid="pace-row"]')).toHaveLength(2))
  const [claude, codex] = w.findAll('[data-testid="pace-row"]')
  // What is left by default, like the quota table; what is used once the user picks it.
  expect(claude!.find('[data-testid="pace-week"]').text()).toBe('40 % left · line 46 % left')
  quotaDisplay.value = 'used'
  await vi.waitFor(() => expect(claude!.find('[data-testid="pace-week"]').text()).toBe('60 % used · line 54 % used'))
  expect(claude!.find('[data-testid="pace-name"]').attributes('placeholder')).toBe('Claude a1b2')
  expect(claude!.text()).toContain('Today +9 %')
  expect(claude!.find('[data-testid="pace-state"]').text()).toContain('Auto: waiting (ahead of the line) until')
  expect(selectValue(claude!, 'pace-mode')).toBe('free')
  expect(codex!.find('[data-testid="pace-unknown"]').text()).toContain('Quota unknown')
  expect(codex!.find('[data-testid="pace-mode"]').exists()).toBe(false)

  await pick(claude!, 'pace-mode', 'workdays')
  await vi.waitFor(() => expect(calls[0]).toEqual({ url: '/api/pacing', body: { key: 'claude:a1b2c3d4', policy: { mode: 'workdays' } } }))

  // Mode settings: Monday first; turning Friday off leaves Monday, which stays on.
  await w.find('[data-testid="pace-more"]').trigger('click')
  await vi.waitFor(() => expect(w.findAll('[data-testid="pace-day"]')).toHaveLength(7))
  await w.findAll('[data-testid="pace-day"]')[4]!.trigger('click')
  await vi.waitFor(() => expect(calls[1]).toEqual({ url: '/api/pacing', body: { key: 'claude:a1b2c3d4', policy: { days: [1] } } }))
  await vi.waitFor(() => expect(w.findAll('[data-testid="pace-day"]')[0]!.attributes('disabled')).toBeDefined())

  // An emptied number keeps the saved value and says why; a valid one saves.
  const cap = w.find('[data-testid="pace-cap"]')
  await cap.setValue('')
  expect(calls).toHaveLength(2)
  expect((cap.element as HTMLInputElement).value).toBe('90')
  expect(w.find('[data-testid="pace-invalid"]').text()).toContain('from 10 to 100')
  await cap.setValue('80')
  await vi.waitFor(() => expect(calls[2]).toEqual({ url: '/api/pacing', body: { key: 'claude:a1b2c3d4', policy: { cap: 80 } } }))
  expect(w.find('[data-testid="pace-invalid"]').exists()).toBe(false)

  // End-of-week burn: one switch, on until the weekly reset, said under it; then off.
  await w.find('[data-testid="pace-burn"]').trigger('click')
  await vi.waitFor(() => expect(calls[3]).toEqual({ url: '/api/pacing', body: { key: 'claude:a1b2c3d4', policy: { burn: { until: now + 3 * 86_400_000 } } } }))
  await vi.waitFor(() => expect(w.find('[data-testid="pace-burn-hint"]').text()).toMatch(/^Burning until /))
  expect(w.find('.pace-form').findAll('input[type="number"]')).toHaveLength(2) // the mode's own fields only
  await w.find('[data-testid="pace-burn"]').trigger('click')
  await vi.waitFor(() => expect(calls[4]!.body.policy).toEqual({ burn: null }))

  const name = w.find('[data-testid="pace-name"]')
  await name.setValue('  Work Pro ')
  await name.trigger('blur')
  await vi.waitFor(() => expect(calls[5]).toEqual({ url: '/api/quotas/name', body: { key: 'claude:a1b2c3d4', name: 'Work Pro' } }))
})
