import { expect, test } from './test'
import fs from 'node:fs/promises'
import { fakeHerdr, OMP_ASK_PANE } from './scenario.mjs'

test.afterEach(async () => {
  await fakeHerdr('e2e.ask', { pane_id: OMP_ASK_PANE })
  for (const pane_id of ['w1:p1', 'w2:p1']) await fakeHerdr('e2e.pane_status', { pane_id, status: 'idle' })
})

// Real home layout with neutral board links; no user's Board is read or written.
for (const theme of ['wherdr-titanium', 'catppuccin-latte']) {
  const language = 'en'
  for (const compact of [true, false]) {
    test(`board task density: ${compact ? 'compact' : 'normal'}, ${theme}`, async ({ page }, info) => {
      await page.addInitScript(({ language, compact, theme }) => {
        localStorage.setItem('herdrLanguage', language)
        localStorage.setItem('theme', theme)
        localStorage.setItem('compactListV2', compact ? '1' : '0')
      }, { language, compact, theme })
      // Give the repo a main space so its real options menu shares the summary bar.
      await page.routeWebSocket('**/ws/events', ws => {
        const server = ws.connectToServer()
        server.onMessage(message => {
          const state = JSON.parse(String(message))
          const workspace = state.workspaces?.find((w: { id: string }) => w.id === 'w4')
          if (workspace) Object.assign(workspace, { repo: '/project', repoName: 'demo', worktree: false })
          ws.send(JSON.stringify(state))
        })
      })
      await page.route('**/api/tasks/links**', route => route.fulfill({ json: {
        version: 'density-fixture', machines: [{ machine: '',
          repos: [{ repo: 'demo', root: '/project', branch: 'feature/compact-project-header', behind: 2 }],
          coordinators: [{ level: 'project', repo: 'demo', pane: 'w3:p1', workspace: null }],
          tasks: [{ id: 'demo/9', repo: 'demo', n: 9, key: 'DEMO-9',
            title: 'Adapter la navigation et vérifier les petits écrans',
            panes: [{ id: 'w1:p1', role: 'worker' }], workspace: 'w1', stage: 'working', group: 'working',
            progress: 30, msg: 'Vérification des espacements', since: Date.now() - 450000,
          }, {
            id: 'demo/10', repo: 'demo', n: 10, key: 'DEMO-10',
            title: 'Simplifier les filtres',
            panes: [{ id: 'w2:p1', role: 'reviewer', kind: 'codex' }], workspace: 'w2', stage: 'reviewing', group: 'working', review: 'work',
            progress: 85, msg: 'Relecture du changement', since: Date.now() - 150000,
          }, {
            id: 'demo/11', repo: 'demo', n: 11, key: 'DEMO-11',
            title: 'Valider le menu',
            panes: [{ id: OMP_ASK_PANE, role: 'worker' }], workspace: 'w11', stage: 'asks', group: 'needs',
            progress: 60, msg: 'Attente de validation', since: Date.now() - 210000,
          }],
        }],
      } }))
      for (const pane_id of ['w1:p1', 'w2:p1']) await fakeHerdr('e2e.pane_status', { pane_id, status: 'working' })
      await fakeHerdr('e2e.ask', { pane_id: OMP_ASK_PANE, screen: await fs.readFile(new URL('../fixtures/omp-approve-bash.txt', import.meta.url), 'utf8') })
      await page.goto('/')
      const card = page.locator('.project-tree .card', { hasText: 'DEMO-9' })
      await expect(card).toBeVisible()
      await expect(card).toHaveClass(/compact/)
      await expect(card.locator('.home-task-stats')).toHaveText('30% 7m')
      await expect(card.locator('.home-task-line')).toHaveCount(compact ? 0 : 1)
      await expect(card.locator('.card-more, .card-main, .card-tab-dots')).toHaveCount(0)
      const waiting = page.locator('.project-tree .card', { hasText: 'DEMO-11' })
      await expect(waiting.locator('.task-state')).toHaveText('Needs you')
      await expect(waiting.locator('.card-more')).toHaveCount(0)
      const review = page.locator('.project-tree .card', { hasText: 'DEMO-10' })
      await expect(review.locator('.home-task-stage')).toHaveCount(compact ? 0 : 1)
      // The stage stays short; the reviewer has its own mark beside it.
      if (!compact) await expect(review.locator('.home-task-stage')).toHaveText('Under review')
      await expect(review.locator('.task-agent-reviewer')).toHaveAttribute('aria-label', 'Reviewed by Codex')
      const title = card.locator('.card-title')
      expect(await title.evaluate(el => el.scrollWidth >= el.clientWidth)).toBe(true)
      expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
      const height = (await card.boundingBox())!.height
      expect(height).toBeLessThan(compact ? 45 : 65)
      await fs.mkdir('.shots', { recursive: true })
      await page.screenshot({ path: `.shots/home-tasks-${compact ? 'compact' : 'normal'}-${theme}-${info.project.name}.png` })
      // Project hierarchy stays compact in both list modes and at both viewport sizes.
      const project = page.locator('.project', { has: card })
      const lead = project.locator('.home-lead')
      const bar = project.locator('.project-bar')
      await expect(bar.locator('.space-menu')).toBeVisible()
      for (const [width, height] of [[390, 844], [1440, 900]] as const) {
        await page.setViewportSize({ width, height })
        await expect(lead).toBeVisible()
        expect((await lead.boundingBox())!.height).toBeLessThanOrEqual(44)
        const mark = lead.locator('.lead-mark')
        await expect(mark).toHaveCSS('width', '18px')
        await expect(mark).toHaveCSS('height', '18px')
        await expect(mark).toHaveText('DEMO')
        await expect(mark.locator('.app-logo')).toHaveCount(0)
        const key = mark.locator('.lead-project-key')
        expect(await key.evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(16)
        expect(await key.evaluate(el => getComputedStyle(el).fontFamily)).toContain('JetBrains Mono')
        expect(await mark.evaluate(el => {
          const probe = document.createElement('span')
          probe.style.color = 'var(--on-accent)'
          probe.style.backgroundColor = 'var(--accent)'
          el.append(probe)
          const same = getComputedStyle(el).color === getComputedStyle(probe).color
            && getComputedStyle(el).backgroundColor === getComputedStyle(probe).backgroundColor
          probe.remove()
          return same
        })).toBe(true)
        await expect(lead.locator('.lead-name')).toHaveCSS('font-size', '14px')
        await expect(project.locator('.project-branch')).toHaveAttribute('title', /feature\/compact-project-header/)
        for (const row of [lead, bar]) expect(await row.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        const summary = project.locator('.project-sum')
        expect(await summary.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
        expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(44)
        expect((await card.boundingBox())!.x).toBeGreaterThan((await lead.boundingBox())!.x)
        await page.screenshot({ path: `.shots/home-project-${compact ? 'compact' : 'normal'}-${theme}-${width}.png` })
      }
      // The old persisted 0/1 setting survives reload and selects the new task layout.
      await page.reload()
      await expect(card.locator('.home-task-line')).toHaveCount(compact ? 0 : 1)
      expect(await page.evaluate(() => localStorage.getItem('compactListV2'))).toBe(compact ? '1' : '0')
    })
  }
}
