import { expect, test } from './test'
import { OMP_CHAT_PANE, OMP_DECISIONS_PANE } from './scenario.mjs'

test.beforeEach(async ({ page }) => {
  // Exercise the same two selectors as the reported Codex toolbar, including
  // a long model name. Leave the real session, chat and send routes intact.
  await page.routeWebSocket('**/ws/events', ws => {
    const server = ws.connectToServer()
    server.onMessage(message => {
      const state = JSON.parse(message.toString())
      const pane = state.panes?.find((p: { id: string }) => p.id === OMP_CHAT_PANE)
      if (pane) pane.model = { label: 'GPT-6.1-Sol extended context', effort: 'xhigh' }
      ws.send(JSON.stringify(state))
    })
  })
  await page.goto(`/#/a/${OMP_CHAT_PANE}`)
  await expect(page.locator('.chat').getByText('Ready when you are.')).toBeVisible()
  await expect(page.locator('.prompt .effort-pick')).toBeAttached()
})

test('touch composer expands only for editing or a kept draft', { tag: '@webkit-phone' }, async ({ page }, testInfo) => {
  test.skip(!await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'Touch layout')
  const field = page.locator('.prompt textarea')
  const prompt = page.locator('.prompt')
  await expect(prompt).not.toHaveClass(/expanded/)
  await expect(page.locator('.prompt-models')).toBeHidden()
  const restHeight = (await prompt.boundingBox())!.height
  expect(restHeight).toBeLessThanOrEqual(60)
  if (process.env.SHOTS) await page.locator('.composer').screenshot({ path: `${process.env.SHOTS}/${testInfo.project.name}-composer-rest.png` })

  await field.focus()
  await expect(prompt).toHaveClass(/expanded/)
  await expect(page.locator('.prompt .effort-pick')).toBeVisible()
  await field.blur()
  await expect(prompt).not.toHaveClass(/expanded/)

  await field.fill('保留草稿时，编辑区仍应占满整行。')
  await field.blur()
  await expect(prompt).toHaveClass(/expanded/)
  await expect(page.locator('.prompt .effort-pick')).toBeVisible()
  await field.fill('')
  await field.blur()
  await expect(prompt).not.toHaveClass(/expanded/)
})

test('blurring an empty touch editor keeps a pressed answer in place', { tag: '@webkit-phone' }, async ({ page }) => {
  test.skip(!await page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'Touch layout')
  await page.goto(`/#/a/${OMP_DECISIONS_PANE}`)
  // A hash change keeps the previous pane's view (and its composer) until the
  // route resolves: act only once the decisions pane is shown, not on the
  // composer that is leaving.
  const answer = page.getByRole('button', { name: '1 · Yes: Tag the release today?', exact: true })
  await expect(answer).toBeVisible()
  const field = page.locator('.prompt textarea')
  const prompt = page.locator('.prompt')
  await field.fill('')
  await expect(prompt).toHaveClass(/expanded/)
  await answer.scrollIntoViewIfNeeded()
  const box = (await answer.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  try {
    // Keep the press down across layout frames, as a real finger can: a
    // blur must not collapse the composer and move its target before release.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await expect(prompt).toHaveClass(/expanded/)
    const held = (await answer.boundingBox())!
    expect(held.y).toBeCloseTo(box.y, 0)
  } finally { await page.mouse.up() }
  await expect(field).toHaveValue(/Tag the release today\? —\nYes\n$/)
  await expect(page.locator('.composer-ask')).toHaveText('4 questions unanswered')
  await expect(field).not.toBeFocused()
})

test('the editor keeps its width and the toolbar fits with model and effort controls', {
  tag: ['@webkit-phone', '@chromium-desktop', '@webkit-desktop'],
}, async ({ page }, testInfo) => {
  const field = page.locator('.prompt textarea')
  const prompt = page.locator('.prompt')
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 })
    await field.fill('请继续研究重连与加载速度，把当前实现中的等待链逐项说明。')
    await expect.poll(async () => {
      const editor = (await field.boundingBox())!
      const box = (await prompt.boundingBox())!
      return editor.width / box.width
    }).toBeGreaterThan(.9)

    const editor = (await field.boundingBox())!
    const footer = (await page.locator('.prompt-foot').boundingBox())!
    expect(footer.y).toBeGreaterThanOrEqual(editor.y + editor.height - 1)
    const controls = page.locator('.prompt-plus, .prompt .model-pick, .prompt-send')
    await expect(controls).toHaveCount(4)
    expect(await page.locator('.effort-pick .model-name').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    let right = footer.x
    for (const control of await controls.all()) {
      const box = (await control.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(right - 1)
      expect(box.x + box.width).toBeLessThanOrEqual(footer.x + footer.width + 1)
      right = box.x + box.width
    }
  }
  if (process.env.SHOTS) await page.locator('.composer').screenshot({ path: `${process.env.SHOTS}/${testInfo.project.name}-composer.png` })
})

test('long drafts scroll above a visible toolbar and clearing restores a compact editor', {
  tag: ['@webkit-phone', '@chromium-desktop', '@webkit-desktop'],
}, async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 400 })
  const field = page.locator('.prompt textarea')
  const draft = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行：请保留完整的中文输入宽度。`).join('\n')
  await field.fill(draft)
  await expect.poll(() => field.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true)
  const editor = (await field.boundingBox())!
  const touch = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
  expect(editor.height).toBeLessThanOrEqual(touch ? 121 : 200)
  await expect(page.locator('.prompt-send')).toBeInViewport()
  await expect(field).toHaveValue(draft)
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${testInfo.project.name}-composer-draft.png` })

  await field.fill('')
  await expect.poll(async () => (await field.boundingBox())!.height).toBeLessThanOrEqual(44)
  await expect(page.locator('.prompt-send')).toBeInViewport()
})
