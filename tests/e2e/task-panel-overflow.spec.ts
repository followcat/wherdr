import { expect, test, type Page } from './test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CLAUDE_ASK_PANE, SOCK_FILE, fakeHerdr } from './scenario.mjs'

// WHR-45: the Board's side panel on a task whose conversation holds long
// paths, long links and wide command output never scrolls sideways, beside
// the Board, in full screen and on a phone. Wide blocks scroll in their own box.
// All data is fictional.
const LONG_PATH = `/Users/example/dev/${'deeply-nested-folder-name/'.repeat(10)}src/components/WidgetPanel.vue`
const LONG_URL = `https://tracker.example.com/browse/PROJ-1234?focusedCommentId=${'1234567890'.repeat(12)}&page=issue-tab-panels`
const LINT = Array.from({ length: 6 }, (_, i) =>
  `${LONG_PATH}:${i + 10}:5  error  'unusedVariableWithAVeryLongName${i}' is assigned a value but never used  @typescript-eslint/no-unused-vars`).join('\n')
const END = 'End of the lint report.'
const task = { id: 'demo/45', title: `Fix the lint of ${'a-very-long-title-without-any-space-'.repeat(5)}`, stage: 'failed', state: 'error', app: 'claude', msg: `Lint failed in ${LONG_PATH}` }

// herdr-projects 1.2.1, faked: the task, its details and a failure banner
// with the lint output and a long link.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-overflow-'))
const details = {
  task: { ...task, description: `Fix ${LONG_PATH}, see ${LONG_URL}`, branch: `work/45-${'very-long-branch-name-'.repeat(8)}` },
  failure: { stage: 'agent', title: `Lint failed in ${LONG_PATH}`, detail: LINT, next: `Read ${LONG_URL}`, auth: false, agentCanFix: true },
  summary: `Changed ${LONG_PATH}`,
}
fs.mkdirSync(path.join(root, 'bin'))
fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify(details))
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
case "$1" in
  list) echo '${JSON.stringify([task])}' ;;
  details) cat '${root}/details.json' ;;
  coordinator) echo '{"state":"none","pane":""}' ;;
  show) echo '{"settings":[],"problems":[]}' ;;
  *) echo ok ;;
esac
`, { mode: 0o755 })
const plugin = { plugin_id: 'herdr-projects', enabled: true, version: '1.2.1', plugin_root: root, startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }

const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8').trim()), 'home')
const taskDir = path.join(home, '.herdr-projects/data/tasks/demo/45')
const cwd = path.join(home, 'projects/billing')
const sid = '00000000-0000-4000-8000-000000000045'
const transcript = path.join(home, '.claude/projects', cwd.replace(/[/.]/g, '-'), `${sid}.jsonl`)

// The task's Claude conversation: a pasted prompt with a "Folder:" line, a
// typed path and link, tool calls on the long path, then a reply with a
// heading, a Jira-like link, a lint block, a table and many points that end
// on a long path (one of them ends right at the edge of the line).
function writeTranscript() {
  const base = { isSidechain: false, cwd, sessionId: sid }
  let t = Date.now() - 120_000
  const at = () => new Date(t += 1000).toISOString()
  const user = (content: unknown) => ({ ...base, type: 'user', timestamp: at(), message: { role: 'user', content } })
  const ai = (content: unknown[]) => ({ ...base, type: 'assistant', timestamp: at(), message: { model: 'claude-opus-4-1', role: 'assistant', content } })
  const points = Array.from({ length: 80 }, (_, i) => `- Moved the helper to /Users/example/dev/app/src/components/${'x'.repeat(i)}`).join('\n')
  const reply = [
    `## Findings in ${LONG_PATH}`,
    `See [PROJ-1234](${LONG_URL}) and ${LONG_URL}`,
    `The file \`${LONG_PATH}\` fails:`,
    '```', LINT, '```',
    `| File | Rule | Link |\n|---|---|---|\n| ${LONG_PATH} | no-unused-vars | ${LONG_URL} |`,
    points,
    END,
  ].join('\n\n')
  const lines = [
    user(`<pasted_content id="c045">\nWork board task demo/45.\nFolder: ${LONG_PATH}\n${LINT}\n</pasted_content id="c045">`),
    user(`Look at ${LONG_PATH} and ${LONG_URL}`),
    ai([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `npx eslint ${LONG_PATH} --format stylish --max-warnings=0`, description: 'Lint' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: LONG_PATH } },
    ]),
    user([{ type: 'tool_result', tool_use_id: 't1', content: LINT, is_error: true }]),
    ai([{ type: 'text', text: reply }]),
  ]
  fs.mkdirSync(path.dirname(transcript), { recursive: true })
  fs.writeFileSync(transcript, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

test.afterEach(async () => {
  await fakeHerdr('e2e.plugins', { plugins: [] })
  await fakeHerdr('e2e.update_session', { pane_id: CLAUDE_ASK_PANE, session: undefined })
  fs.rmSync(taskDir, { recursive: true, force: true })
  fs.rmSync(transcript, { force: true })
})
test.afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

// Every box of the panel that scrolls sideways, but the wide blocks that are
// meant to scroll in their own box (code, tables).
const sideways = (page: Page) => page.locator('.board-panel').evaluate((panel) => {
  const own = (el: Element) => el.closest('pre, table')
  return [panel, ...panel.querySelectorAll('*')]
    .filter(el => !own(el) && el.clientWidth > 0 && el.scrollWidth > el.clientWidth && ['auto', 'scroll'].includes(getComputedStyle(el).overflowX))
    .map(el => `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 3).join('.')} ${el.scrollWidth} > ${el.clientWidth}`)
})

async function check(page: Page, shot: string) {
  const panel = page.locator('.board-panel')
  expect(await sideways(page), `${shot}: boxes that scroll sideways`).toEqual([])
  expect(await panel.evaluate(el => el.scrollWidth - el.clientWidth), `${shot}: panel`).toBe(0)
  expect(await page.evaluate(() => document.scrollingElement!.scrollWidth - document.scrollingElement!.clientWidth), `${shot}: page`).toBe(0)
  await page.screenshot({ path: `.shots/overflow-${shot}.png` })
}

test('the task panel never scrolls sideways with long paths, links and wide output', { tag: '@chromium-desktop' }, async ({ page, request }, testInfo) => {
  writeTranscript()
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ ...task, link: { pane: CLAUDE_ASK_PANE } }))
  await fakeHerdr('e2e.update_session', { pane_id: CLAUDE_ASK_PANE, session: sid })
  await fakeHerdr('e2e.plugins', { plugins: [plugin] })
  // Another spec can have installed a different fake launcher. Refresh its
  // cached discovery before the instant task opening asks for details.
  const installed = await request.get('/api/plugins/projects?machine=')
  expect(installed.ok()).toBe(true)
  // Herdr's next snapshot must also report the transcript we just installed.
  await expect.poll(async () => {
    const state = await (await request.get('/api/state')).json()
    return state.panes.find((p: { id: string }) => p.id === CLAUDE_ASK_PANE)?.agentSession
  }).toBe(sid)
  // The previous fixture's list is reused for five seconds. A deep link to
  // a task absent from that list would correctly look for it in the archive.
  await expect.poll(async () => {
    const board = await (await request.get('/api/tasks')).json()
    return board.machines.find((m: { machine: string }) => m.machine === '')?.tasks
      .map((t: { id: string }) => t.id)
  }).toEqual(['demo/45'])
  const phone = page.viewportSize()!.width < 600
  const name = testInfo.project.name

  await page.goto('/#/board?machine=&task=demo%2F45')
  const panel = page.locator('.board-panel')
  const tabs = panel.locator('.board-panel-tabs')
  await expect(panel.locator('.chat').getByText(END)).toBeVisible()
  await expect(panel.locator('.task-needs')).toContainText('no-unused-vars')
  // The wide lint block is there, and scrolls in its own box.
  const code = panel.locator('.chat pre').filter({ hasText: 'unusedVariableWithAVeryLongName0' })
  expect(await code.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true)
  await check(page, `chat-${name}`)

  await tabs.getByRole('button', { name: 'Task', exact: true }).click()
  await expect(panel.locator('.task-sheet')).toContainText('see https://tracker.example.com')
  await check(page, `task-${name}`)
  // Back to the Agent tab, in conversation mode (its bar then offers the terminal).
  await tabs.getByRole('button', { name: 'Agent', exact: true }).click()
  await expect(panel.locator('.board-panel-agent-bar').getByRole('button', { name: 'Terminal', exact: true })).toBeVisible()
  await expect(panel.locator('.chat').getByText(END)).toBeAttached()

  if (!phone) {
    await panel.getByRole('button', { name: 'Full screen' }).click()
    await expect(panel).toHaveClass(/expanded/)
    await check(page, `full-${name}`)
    await panel.getByRole('button', { name: 'Exit full screen' }).click()
    // A computer with a narrow window: the panel takes the whole width.
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(panel.locator('.chat').getByText(END)).toBeAttached()
    await check(page, `narrow-${name}`)
  }
})
