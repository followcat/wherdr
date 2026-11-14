import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, startCore } from './core'
import { common, company } from '../../shared/pm/examples'

// The board on the built server: tasks saved by the engine show in their columns,
// the reviewer's live state comes from herdr-core, and the step's button in the
// task sheet moves a task out of Your turn. Columns (also per project), indicators
// and badges are covered lower, in tests/components/BoardView.test.ts.
// Long enough to overflow any sidebar row that does not shrink or ellipsize.
const LONG = 'merged-on-bitbucket-check-develop-before-closing-the-release-branch'

test('board: Your turn, the reviewer\'s state and the step button', async ({ page }) => {
  const terminal = fixture.inventory.terminals[0]!
  const step = (at: number, more = {}) => ({ at, started: true, proofs: {}, rounds: {}, ...more })
  const core = await startCore(call =>
    call.method === 'terminal.list' ? { ...fixture.inventory, terminals: [{ ...terminal, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }, { ...terminal, address: 'host-a/t8', name: LONG, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }] }
    : call.method === 'doc.get' ? { value: call.params.on ? null : { spaces: [{ id: 'sp1', name: 'Demo', folder: '/workspace/demo', tabs: [{ id: 'tbA', name: 'Main' }] }] }, version: 1 }
    : undefined, async (data) => {
    const dir = join(data, 'projects')
    const json = (file: string, v: unknown) => writeFile(join(dir, file), JSON.stringify(v))
    await mkdir(join(dir, 'templates'), { recursive: true })
    await mkdir(join(dir, 'tasks'))
    await mkdir(join(dir, 'runs'))
    await json('pm.json', { v: 1, enabled: true })
    await json('projects.json', { v: 1, projects: [
      { key: 'CO', name: 'Company', machine: '', path: '/workspace/demo', template: 'company', addedAt: 1 },
      { key: 'CM', name: 'Studies', machine: '', path: '/workspace/other', template: 'common', addedAt: 1 },
    ] })
    await json('templates/company.json', company)
    // A long step button: the board's Your turn card shows it as its badge.
    const long = (st: { id: string }) => (st.id === 'pick' ? { ...st, userLabel: `Create these tasks ${LONG}` } : st)
    await json('templates/common.json', { ...common, taskTypes: { ...common.taskTypes, 'feature-split': { steps: common.taskTypes['feature-split']!.steps.map(long) } } })
    const task = (id: string, type: string, s: unknown) => ({ id, project: id.split('-')[0], title: `Task ${id}: ${LONG}`, description: 'What to do.', type, state: 'working', step: s, createdAt: 1 })
    await json('tasks/CO-1.json', { ...task('CO-1', 'feature', step(2)), links: [{ label: 'PR', url: 'https://example.com/pr/1' }] })
    await json('tasks/CM-1.json', task('CM-1', 'feature-split', step(1, { yourTurn: { reason: 'user', badge: `Create these tasks ${LONG}` } })))
    await json('runs/r1.json', { id: 'r1', task: 'CO-1', role: 'reviewer', program: 'codex', model: 'm', machine: '', worktree: '/w', branch: 'task/CO-1', instructions: '/i', terminal: terminal.address, attempt: 1, state: 'running', startedAt: 1 })
  })
  try {
    // The sidebar never scrolls sideways: every row shrinks or ellipsizes (phone and computer).
    await core.open(page, '/')
    const list = page.locator('#home .scroll')
    await expect(page.getByTestId('tasks-to-review')).toBeVisible()
    await mkdir('.shots', { recursive: true })
    for (const size of [{ width: 390, height: 664 }, { width: 320, height: 700 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(size)
      await expect.poll(() => list.evaluate((el) => {
        const right = el.getBoundingClientRect().right
        const out = [...el.querySelectorAll('*')].filter(e => e.getBoundingClientRect().right > right + 0.5).map(e => `${e.tagName}.${e.className}`)
        return { scroll: el.scrollWidth - el.clientWidth, out: out.slice(0, 12) }
      })).toEqual({ scroll: 0, out: [] })
      await page.screenshot({ path: `.shots/sidebar-${size.width}.png` })
    }
    await page.setViewportSize({ width: 390, height: 664 })
    await core.open(page, '/#/board')
    const card = (id: string) => page.locator(`#board [data-task="${id}"]`)
    await expect(page.locator('[data-lane="your-turn"]').locator('[data-task="CM-1"]')).toContainText('Create these tasks')
    await expect(card('CO-1').getByTestId('holder-state')).toHaveAttribute('aria-label', /^Reviewer: /)
    await expect(card('CM-1').getByTestId('holder-state')).toHaveCount(0)
    await page.screenshot({ path: `.shots/board-${test.info().project.name}.png` })

    await card('CM-1').click()
    await expect(page.locator('[data-tab="todo"]')).toHaveAttribute('aria-selected', 'true') // waiting for the user: it opens on To do
    await page.locator('[data-tab="plan"]').click()
    await expect(page.getByTestId('task-plan').locator('[aria-current="step"]')).toContainText('pick')
    await page.screenshot({ path: `.shots/board-sheet-${test.info().project.name}.png` })
    await page.locator('[data-tab="todo"]').click()
    await page.getByTestId('step-user').click()
    await expect(page.locator('[data-lane="done"]').locator('[data-task="CM-1"]')).toBeVisible()
  } finally {
    await core.stop()
  }
})
