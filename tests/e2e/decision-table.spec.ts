import { expect, test, type Page } from './test'
import { OMP_DECISIONS_PANE, OMP_TWO_TABLES_PANE } from './scenario.mjs'
import { decision, decisions, expectDraft } from './refs'

// The panel under a decision table (utils/questionReply.ts, decisionRows):
// "OK to all", and Yes / No / Reply per numbered row. Everything is composed
// in the field, each answer under a reference to the message and the row
// (shared/reference.ts); the user sends.
const shot = (page: Page, name: string, project: string) =>
  process.env.SHOTS ? page.screenshot({ path: `${process.env.SHOTS}/${project}-${name}.png` }) : Promise.resolve()

const ROWS = [
  ['1', 'Tag the release today?'],
  ['2', 'Keep the old export format for one more version?'],
  ['3', 'Publish the release notes on the site?'],
  ['4', 'Which name for the new theme?'],
]
const row = (n: number) => decision(ROWS[n - 1]![0]!, ROWS[n - 1]![1]!)
const ALL = decisions('1-4', ROWS.map(r => r[1]).join(' · '))

async function open(page: Page, style?: string, language?: string) {
  await page.addInitScript(([s, l]) => {
    localStorage.setItem('typewriterSpeed', 'off')
    if (s) localStorage.setItem('replyStyle', s)
    if (l) localStorage.setItem('herdrLanguage', l)
  }, [style, language])
  await page.goto(`/#/a/${OMP_DECISIONS_PANE}`)
  const chat = page.locator('.chat')
  await expect(chat.locator('table')).toHaveCount(3)
  const field = page.locator('.prompt textarea').first()
  await field.fill('')
  return { chat, field, panel: chat.locator('.q-table') }
}
const fits = (page: Page) => page.locator('.chat-list').evaluate(el => el.scrollWidth <= el.clientWidth)
const sentCount = (page: Page) => page.locator('.msg-user-wrap').count()

test('a decision table is answered row by row under it; other tables get nothing', async ({ page }, testInfo) => {
  const { chat, field, panel } = await open(page)
  const before = await sentCount(page)
  // One panel, right under the table of decisions: not under the two others.
  await expect(panel).toHaveCount(1)
  expect(await panel.evaluate(el => [el.previousElementSibling!.tagName, el.previousElementSibling!.querySelector('th')!.textContent, el.getAttribute('aria-label')])).toEqual(['TABLE', '#', 'Decisions'])
  const rows = panel.locator('.q-trow')
  expect(await rows.evaluateAll(els => els.map(el => [(el as HTMLElement).dataset.n, (el as HTMLElement).dataset.q]))).toEqual(ROWS)
  // The words shown come from the row; the panel holds no text of its own.
  expect(await rows.nth(1).locator('.q-tl').evaluate(el => [getComputedStyle(el, '::before').content, getComputedStyle(el, '::after').content])).toEqual(['"2"', `"${ROWS[1]![1]}"`])
  expect(await panel.evaluate(el => el.textContent)).toBe('')
  await panel.scrollIntoViewIfNeeded()
  // Finger-sized buttons on a phone, on one line that never widens the page.
  const sizes = await rows.nth(1).locator('button').evaluateAll(els => els.map(el => el.getBoundingClientRect()).map(r => [Math.round(r.width), Math.round(r.height)]))
  const min = testInfo.project.name.includes('phone') ? 40 : 34
  for (const [w, h] of sizes) { expect(w).toBeGreaterThanOrEqual(36); expect(h).toBeGreaterThanOrEqual(min) }
  expect(await fits(page)).toBe(true)
  await shot(page, 'decisions', testInfo.project.name)

  // A row answered under a reference to it; the other answer replaces it in place.
  await panel.getByRole('button', { name: '1 · Yes: Tag the release today?' }).click()
  await expectDraft(field, `${row(1)}\nYes\n`)
  await panel.getByRole('button', { name: `2 · No: ${ROWS[1]![1]}` }).click()
  await expectDraft(field, `${row(1)}\nYes\n${row(2)}\nNo\n`)
  await expect(panel.getByRole('button', { name: `2 · No: ${ROWS[1]![1]}` })).toHaveAttribute('aria-pressed', 'true')
  await panel.getByRole('button', { name: '1 · No: Tag the release today?' }).click()
  await expectDraft(field, `${row(1)}\nNo\n${row(2)}\nNo\n`)
  await expect(panel.getByRole('button', { name: '1 · Yes: Tag the release today?' })).toHaveAttribute('aria-pressed', 'false')
  // Reply refers to the row the same way, for an answer in words.
  const reply = panel.getByRole('button', { name: `Reply: 4. ${ROWS[3]![1]}` })
  await reply.click()
  await expectDraft(field, `${row(1)}\nNo\n${row(2)}\nNo\n${row(4)}\n`)
  await expect(reply).toHaveClass(/quoted/)
  await shot(page, 'decisions-answered', testInfo.project.name)
  // The field keeps the keyboard down for the taps, and nothing was sent.
  expect(await sentCount(page)).toBe(before)

  // "Which name…?" is an open question: Reply alone on its row.
  await expect(rows.nth(3).locator('.q-tans')).toHaveCount(0)
  await expect(rows.nth(2).locator('.q-tans')).toHaveCount(2)
  // The closing question of the message keeps its own Yes / No.
  await expect(chat.locator('.q-reply')).toHaveCount(1)
  await expect(chat.locator('.md-body .q-ans')).toHaveCount(2)
})

test('"OK to all" accepts the table under a reference to it, a second tap takes it back', async ({ page }, testInfo) => {
  const { field, panel } = await open(page)
  const all = panel.locator('.q-all')
  await all.scrollIntoViewIfNeeded()
  expect(await all.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"OK to all"')
  await all.click()
  await expectDraft(field, `${ALL}\nOK to all\n`)
  await expect(all).toHaveAttribute('aria-pressed', 'true')
  // On a computer the field takes the focus, so that Enter sends; not on a phone.
  if (testInfo.project.name.includes('phone')) await expect(field).not.toBeFocused()
  else await expect(field).toBeFocused()
  // An exception still goes below it.
  await panel.getByRole('button', { name: `3 · No: ${ROWS[2]![1]}` }).click()
  await expectDraft(field, `${ALL}\nOK to all\n${row(3)}\nNo\n`)
  await shot(page, 'decisions-ok-all', testInfo.project.name)
  await all.click()
  await expectDraft(field, `${row(3)}\nNo\n`)
  await expect(all).toHaveAttribute('aria-pressed', 'false')
  // Keyboard: the buttons are focusable and Enter answers.
  await all.focus()
  await page.keyboard.press('Enter')
  await expectDraft(field, `${row(3)}\nNo\n${ALL}\nOK to all\n`)
})

test('the panel stays English with a legacy French preference', async ({ page }, testInfo) => {
  const { field, panel } = await open(page, undefined, 'fr')
  const all = panel.locator('.q-all')
  await all.scrollIntoViewIfNeeded()
  expect(await all.evaluate(el => getComputedStyle(el, '::before').content)).toBe('"OK to all"')
  await panel.getByRole('button', { name: '1 · Yes: Tag the release today?' }).click()
  await panel.getByRole('button', { name: `2 · No: ${ROWS[1]![1]}` }).click()
  await all.click()
  // The answers follow the language of the interface; the reference does not change.
  await expectDraft(field, `${row(1)}\nYes\n${row(2)}\nNo\n${ALL}\nOK to all\n`)
  await shot(page, 'decisions-fr', testInfo.project.name)
})

for (const style of ['text', 'list']) {
  test(`the panel is the same in the ${style} reply style`, async ({ page }, testInfo) => {
    const { field, panel } = await open(page, style)
    await expect(panel.locator('.q-trow')).toHaveCount(4)
    await panel.scrollIntoViewIfNeeded()
    await panel.getByRole('button', { name: '1 · Yes: Tag the release today?' }).click()
    await panel.getByRole('button', { name: `Reply: 4. ${ROWS[3]![1]}` }).click()
    await expectDraft(field, `${row(1)}\nYes\n${row(4)}\n`)
    expect(await fits(page)).toBe(true)
    await shot(page, `decisions-${style}`, testInfo.project.name)
  })
}

test('two decision tables of one message keep their own answers, the same question included', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('typewriterSpeed', 'off'))
  await page.goto(`/#/a/${OMP_TWO_TABLES_PANE}`)
  const panels = page.locator('.chat .q-table')
  await expect(panels).toHaveCount(2)
  const field = page.locator('.prompt textarea').first()
  await field.fill('')
  const [staging, production] = [panels.nth(0), panels.nth(1)]
  const pressed = (panel: typeof staging, name: string) => panel.getByRole('button', { name }).getAttribute('aria-pressed')

  // Yes to the first table, No to the same question of the second: two
  // references, told apart by the code of their table.
  await staging.getByRole('button', { name: '1 · Yes: Continue?' }).click()
  await production.getByRole('button', { name: '1 · No: Continue?' }).click()
  const draft = await field.inputValue()
  const m = /^↳ Quote decision \d\d:\d\d #1 ~([0-9a-z]{3}) : Continue\? —\nYes\n↳ Quote decision \d\d:\d\d #1 ~([0-9a-z]{3})2 : Continue\? —\nNo\n$/.exec(draft)
  expect(m, draft).not.toBeNull()
  expect(m![2]).toBe(m![1])
  expect(await pressed(staging, '1 · Yes: Continue?')).toBe('true')
  expect(await pressed(staging, '1 · No: Continue?')).toBe('false')
  expect(await pressed(production, '1 · No: Continue?')).toBe('true')
  expect(await pressed(production, '1 · Yes: Continue?')).toBe('false')
  await expect(page.locator('.prompt .qm-mirror .qm-q')).toHaveCount(2)
  await shot(page, 'two-tables-answered', testInfo.project.name)

  // "OK to all" on the second table accepts that one only, and names the rows it has.
  await field.fill('')
  await production.locator('.q-all').click()
  expect(await field.inputValue()).toMatch(/^↳ Quote decisions \d\d:\d\d #1,4 ~[0-9a-z]{3}2 : Continue\? · Delete the old production replica\? —\nOK to all\n$/)
  await expect(production.locator('.q-all')).toHaveAttribute('aria-pressed', 'true')
  await expect(staging.locator('.q-all')).toHaveAttribute('aria-pressed', 'false')
  await expect(staging.locator('.q-tquote.quoted')).toHaveCount(0)
  await staging.locator('.q-all').click()
  expect(await field.inputValue()).toMatch(/^↳ Quote decisions [^\n]* #1,4 [^\n]*\nOK to all\n↳ Quote decisions \d\d:\d\d #1-2 ~[0-9a-z]{3} : Continue\? · Keep the staging data\? —\nOK to all\n$/)
  await expect(production.locator('.q-all')).toHaveAttribute('aria-pressed', 'true')
  expect(await fits(page)).toBe(true)
  await shot(page, 'two-tables-ok-all', testInfo.project.name)
  await field.fill('')
})
