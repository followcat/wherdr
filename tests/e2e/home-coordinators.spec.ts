import { expect, test } from './test'
import fs from 'node:fs/promises'
import { CLAUDE_PANE, COORDINATOR_PANE, OMP_CHAT_PANE } from './scenario.mjs'

// The home list's Coordinators section: the board's Coordinator and the
// machine coordinator each have their own icon, and the Board's names
// (herdr-projects' names: "Coordinator", "<machine> coordinator"), unlike a repo's
// project coordinator (the wherdr mark and "Coordinator"). Neutral links only.
test.describe('English interface', () => {
  const language = 'en'
  test(`home coordinators: one icon and label per kind, ${language}`, async ({ page }, info) => {
    await page.addInitScript(lang => localStorage.setItem('herdrLanguage', lang), language)
    await page.route('**/api/tasks/links**', route => route.fulfill({ json: {
      version: 'coordinators-fixture', machines: [{ machine: '', tasks: [], coordinators: [
        { level: 'top', pane: COORDINATOR_PANE, workspace: null },
        { level: 'machine', pane: CLAUDE_PANE, workspace: null },
        { level: 'project', repo: 'demo', pane: OMP_CHAT_PANE, workspace: null },
      ] }],
    } }))
    await page.goto('/')
    const section = page.locator('.agent-group.coordinators')
    const top = section.locator(`.card[data-pane="${COORDINATOR_PANE}"]`)
    const machine = section.locator(`.card[data-pane="${CLAUDE_PANE}"]`)
    await expect(top.locator('.card-title')).toHaveText('Coordinator')
    await expect(machine.locator('.card-title')).toHaveText(/^.+ coordinator$/)
    await expect(section).not.toContainText(/setup|configuration/i)
    // Labels read in uppercase mono, as before.
    await expect(top.locator('.card-title')).toHaveCSS('text-transform', 'uppercase')
    // Each its own icon: the board's, the machine's (local: a server).
    await expect(top.locator('.avatar.coord .iconify')).toHaveClass(/square-kanban/)
    await expect(machine.locator('.avatar.coord .iconify')).toHaveClass(/server/)
    await expect(top.locator('.card-title')).toHaveAttribute('title', /.+/)
    // The project coordinator keeps its head row in its repo group.
    const lead = page.locator('.card.home-lead', { hasText: 'demo' })
    await expect(lead.locator('.lead-mark.coord')).toBeVisible()
    await expect(lead.locator('.lead-coord-tag')).toHaveText('Coordinator')
    for (const card of [top, machine]) expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    await fs.mkdir('.shots', { recursive: true })
    await page.screenshot({ path: `.shots/home-coordinators-${language}-${info.project.name}.png` })
  })
})

// A coordinator's file keeps the pane and space it had when it started; once
// Herdr closes that pane (Herdr or the agent restarted), only its conversation,
// which Herdr reports on its new pane, says where it is. The home list still
// shows it at the top, and a coordinator of another conversation takes nothing.
test('home coordinators: found again by their conversation after their pane closed', async ({ page, request }) => {
  const state = await (await request.get('/api/state')).json()
  const conversation = (id: string) => state.panes.find((p: { id: string }) => p.id === id)?.agentSession as string
  expect(conversation(COORDINATOR_PANE)).toBeTruthy()
  await page.route('**/api/tasks/links**', route => route.fulfill({ json: {
    version: 'stale-coordinators-fixture', machines: [{ machine: '', tasks: [], coordinators: [
      { level: 'top', pane: 'w99:p9', workspace: 'w99', agentSession: conversation(COORDINATOR_PANE) },
      // Closed too, and its old ids now name the demo agent: not a coordinator.
      { level: 'machine', pane: OMP_CHAT_PANE, workspace: OMP_CHAT_PANE.split(':')[0], agentSession: '/home/user/.omp/agent/sessions/gone.jsonl' },
    ] }],
  } }))
  await page.goto('/')
  const section = page.locator('.agent-group.coordinators')
  await expect(section.locator(`.card[data-pane="${COORDINATOR_PANE}"] .card-title`)).toHaveText('Coordinator')
  await expect(section.locator('.card')).toHaveCount(1)
  await expect(section.locator(`.card[data-pane="${OMP_CHAT_PANE}"]`)).toHaveCount(0)
})
