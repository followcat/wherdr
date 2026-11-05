import { test, expect } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fixture, startCore } from './core'
import { common, company } from '../../shared/pm/examples'

// The board on the built server: tasks saved by the engine show in their columns,
// the reviewer's live state comes from herdr-core, and the step's button in the
// task sheet moves a task out of Your turn. Columns, indicators and badges are
// covered lower, in tests/components/BoardView.test.ts.
test('board: Your turn, the reviewer\'s state and the step button', async ({ page }) => {
  const terminal = fixture.inventory.terminals[0]!
  const step = (at: number, more = {}) => ({ at, started: true, proofs: {}, rounds: {}, ...more })
  const core = await startCore(call =>
    call.method === 'terminal.list' ? { ...fixture.inventory, terminals: [{ ...terminal, labels: { 'herdr.space': 'sp1', 'herdr.tab': 'tbA' } }] }
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
    await json('templates/common.json', common)
    const task = (id: string, type: string, s: unknown) => ({ id, project: id.split('-')[0], title: `Task ${id}`, description: 'What to do.', type, state: 'working', step: s, createdAt: 1 })
    await json('tasks/CO-1.json', { ...task('CO-1', 'feature', step(2)), links: [{ label: 'PR', url: 'https://example.com/pr/1' }] })
    await json('tasks/CM-1.json', task('CM-1', 'feature-split', step(1, { yourTurn: { reason: 'user', badge: 'Create these tasks' } })))
    await json('runs/r1.json', { id: 'r1', task: 'CO-1', role: 'reviewer', program: 'codex', model: 'm', machine: '', worktree: '/w', branch: 'task/CO-1', instructions: '/i', terminal: terminal.address, attempt: 1, state: 'running', startedAt: 1 })
  })
  try {
    await core.open(page, '/#/board')
    const card = (id: string) => page.locator(`[data-task="${id}"]`)
    await expect(page.locator('[data-lane="your-turn"]').locator('[data-task="CM-1"]')).toContainText('Create these tasks')
    await expect(card('CO-1').getByTestId('holder-state')).toHaveAttribute('aria-label', /^Reviewer: /)
    await expect(card('CM-1').getByTestId('holder-state')).toHaveCount(0)
    await mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/board-${test.info().project.name}.png` })

    await card('CM-1').click()
    await expect(page.getByTestId('task-plan').locator('[aria-current="step"]')).toContainText('pick')
    await page.screenshot({ path: `.shots/board-sheet-${test.info().project.name}.png` })
    await page.getByTestId('step-user').click()
    await expect(page.locator('[data-lane="done"]').locator('[data-task="CM-1"]')).toBeVisible()
    // One project: its template's columns.
    await page.keyboard.press('Escape')
    await page.getByTestId('board-project').selectOption('CO')
    await expect(page.locator('[data-lane="Review"]').locator('[data-task="CO-1"]')).toBeVisible()
    await page.screenshot({ path: `.shots/board-project-${test.info().project.name}.png` })
  } finally {
    await core.stop()
  }
})
