import { expect, it } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'
import PacingChart from '~/components/PacingChart.vue'
import type { WeekSeries } from '#shared/pacingChart'

const DAY = 86_400_000
const to = Date.now() + 3 * DAY
const series = (more: Partial<WeekSeries> = {}): WeekSeries => ({
  from: to - 7 * DAY, to, now: Date.now(), label: 'line',
  usage: [[{ t: to - 6 * DAY, v: 12 }], [{ t: to - 4 * DAY, v: 40 }]],
  target: [{ t: to - 7 * DAY, v: 0 }, { t: to, v: 90 }], ...more,
})

it('names the week\'s usage and its target line; Free shows usage only, and no reading says so', async () => {
  const w = await mountSuspended(PacingChart, { props: { series: series() } })
  expect(w.find('[data-testid="pace-chart"] [aria-label]').attributes('aria-label')).toBe('Weekly quota this week · 40 % used · Target line 0 %')
  expect(w.find('[data-testid="pace-chart-target"]').text()).toBe('Target line')
  await w.setProps({ series: series({ target: null, usage: [] }) })
  expect(w.find('[data-testid="pace-chart-target"]').exists()).toBe(false)
  expect(w.find('[data-testid="pace-chart-empty"]').text()).toBe('No reading this week yet')
  w.unmount()
})
