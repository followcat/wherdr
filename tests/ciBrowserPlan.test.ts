import { expect, it } from 'vitest'
import { browserPlan } from '../scripts/ci-browser-plan.mjs'

it('keeps PRs and branch pushes light, including a PR targeting develop', () => {
  for (const [event, ref] of [['pull_request', 'refs/pull/12/merge'], ['push', 'refs/heads/develop'], ['push', 'refs/heads/main']]) {
    expect(browserPlan(event, ref).scope).toBe('light')
  }
})
it('runs all four projects in full on nightly, manual and release events', () => {
  for (const [event, ref] of [['schedule', 'refs/heads/main'], ['workflow_dispatch', 'refs/heads/topic'], ['push', 'refs/tags/v1.2.3']]) {
    expect(browserPlan(event, ref).scope).toBe('full')
  }
})
it('partitions each phone project exactly once and retains both desktop projects', () => {
  const rows = browserPlan('pull_request', 'refs/pull/12/merge').matrix.include
  for (const [project, count] of [['chromium-phone', 6], ['webkit-phone', 2]] as const) {
    expect(rows.filter(row => row.project === project).map(row => row.shard)).toEqual(
      Array.from({ length: count }, (_, n) => `${n + 1}/${count}`),
    )
  }
  expect(rows.filter(row => !row.shard)).toEqual([{ project: 'chromium-desktop' }, { project: 'webkit-desktop' }])
})
