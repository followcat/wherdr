import fs from 'node:fs'
import { CHOICE_GUARD_MS } from '../../app/utils/compactCard'
import { expect, test } from './test'
import { OMP_ASK_PANE as pane, fakeHerdr } from './scenario.mjs'

// omp 18.14's approval prompt (in the composer's place, framed or not): the
// usual question card in the conversation, answered with arrows then Enter,
// gone once omp moves on. Screens are the synthetic fixtures (stub model, ~/demo).
const fx = (name: string) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')
const ask = (screen?: string) => fakeHerdr('e2e.ask', { pane_id: pane, screen })
const answers = async () => (await fakeHerdr('e2e.answers', { pane_id: pane })).answers

test.afterEach(async () => { await ask() })

for (const [file, detail] of [
  ['omp-approve-1814-eval-long.txt', 'Language: python · Code: import os …'],
  ['omp-approve-inline.txt', 'Language: python · Code: import os …'],
] as const) {
  test(`${file}: a question card, Deny sends its arrows then Enter`, async ({ page }, info) => {
    await ask(fx(file))
    await page.goto(`/#/a/${pane}`)
    const card = page.locator('.choices')
    await expect(card.locator('.choices-q')).toHaveText('Allow tool: eval')
    await expect(card.locator('.prompt-detail-tool')).toHaveText('eval')
    await expect(card.locator('.prompt-detail-code')).toContainText(detail)
    const labels = file.includes('inline') ? ['Approve', 'Deny'] : ['Approve', 'Approve eval for this session', 'Deny']
    await expect(card.locator('.choices-list button .l')).toHaveText(labels)
    await expect(card.locator('.choices-list button.cur .l')).toHaveText('Approve')
    await expect(page.locator('.interactive-terminal')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    if (process.env.SHOTS && !file.includes('inline')) await page.screenshot({ path: `${process.env.SHOTS}/${info.project.name}-omp-approval-1814.png` })

    await page.waitForTimeout(CHOICE_GUARD_MS)
    await card.locator('.choices-list button', { hasText: 'Deny' }).click()
    const down = labels.length - 1
    await expect.poll(answers).toEqual([[...Array.from({ length: down }, () => 'down'), 'enter']])
    await expect(page.locator('.choices-list')).toHaveCount(0)
  })
}
