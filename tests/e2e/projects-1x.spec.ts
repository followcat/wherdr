import { expect, test } from './test'
import { BASE_URL } from './scenario.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLAUDE_PANE, COORDINATOR_PANE, SOCK_FILE, fakeHerdr } from './scenario.mjs'

// herdr-projects 1.x on the Board and in Settings. The plugin's launcher
// (bin/run.sh) is a fake that answers with the real output of the 1.2.1
// release (tests/recordings/herdr-projects-1.2.1) and writes down each call.
// demo/6 failed in its agent's own work: 1.2.1 `retry` sends it back (failure_of's shape).
const failedDetails = { task: { id: 'demo/6', title: 'Broke on the tests', stage: 'failed', msg: 'Tests failed' }, failure: { stage: 'agent', title: 'Tests failed', detail: 'npm test exited 1', auth: false, agentCanFix: true } }
// `show --repo <name> --json`: a repo's key (1.2.1 settings show). web's is not its name.
const keyReply = (key: string) => JSON.stringify({ settings: [{ name: 'repo.key', kind: 'repo', value: key, from: 'your entry', place: 'you', own: false, note: '' }], problems: [] })
// `show --json -- <id>`: the task's worker.agent, from the user's entry for its repo.
const taskAgentReply = JSON.stringify({ settings: [{ name: 'worker.agent', kind: 'work', value: 'claude', from: 'your entry for demo', place: 'repo', own: false, note: '' }], problems: [] })
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../recordings/herdr-projects-1.2.1')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-hp1x-'))
const calls = path.join(root, 'calls.log')
// The coordinators told something (`coordinator tell`), one file each.
const told = path.join(root, 'told')
fs.mkdirSync(path.join(root, 'bin'))
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
  list) if [ "$3" = --archived ]; then if [ -f '${root}/archived.json' ]; then cat '${root}/archived.json'; else echo '[]'; fi
    elif [ -f '${root}/list.json' ]; then cat '${root}/list.json'; else cat '${fixtures}/list.json'; fi ;;
  details) if [ -f '${root}/details.json' ]; then cat '${root}/details.json'; else case "$4" in demo/1) cat '${fixtures}/details-approval.json' ;; demo/2) cat '${fixtures}/details-asks.json' ;; demo/6) echo '${JSON.stringify(failedDetails)}' ;; *) cat '${fixtures}/details-working.json' ;; esac; fi ;;
  # The program's own version: the tested release, unless the spec writes another.
  version) if [ -f '${root}/version' ]; then cat '${root}/version'; else echo 'herdr-projects 1.2.21 (/opt/herdr-projects/bin/herdr-projects-linux-x86_64)'; fi ;;
  tell) echo "$3: sent" ;;
  approve) if [ -f '${root}/after-approve.json' ]; then mv '${root}/after-approve.json' '${root}/list.json'; fi; echo "$3: approved, merging" ;;
  coordinator) co="$2"; case "$co" in --machine|--project=*) ;; *) co=main ;; esac
    case "$*" in
    # status --json: the pane herdr-projects keeps for it; web's runs once the spec says so.
    # Told something and not running yet: starting, as herdr-projects says while the words wait.
    *status) if [ "$2" = --project=web ] && [ -f '${root}/web-coordinator' ]; then echo '{"state":"idle","pane":"${COORDINATOR_PANE}"}'
      elif [ -f "${told}/$co" ]; then echo '{"state":"starting","pane":""}'; else echo '{"state":"none","pane":""}'; fi ;;
    *) : > "${told}/$co"; echo "sent to the Coordinator" ;;
  esac ;;
  # Autopilot (1.2.15+): every coordinator of the machine, all off.
  autopilot) echo '[]' ;;
  add) echo "demo/7: added" ;;
  # delegate --worker.agent=X keeps X as the task's own setting, as 1.x does; set/unset --task change it.
  # A refusal the spec writes (a wait in a circle…) is said on stderr, as 1.x does.
  delegate) if [ -f '${root}/refuse' ]; then cat '${root}/refuse' >&2; exit 1; fi
    case "$2" in --worker.agent=*) printf '%s' "\${2#--worker.agent=}" > '${root}/own-agent' ;; esac; echo "done" ;;
  after) echo "$4: waits for nothing, so it starts now" ;;
  set) printf '%s' "$5" > '${root}/own-agent'; echo "set" ;;
  unset) rm -f '${root}/own-agent'; echo "unset" ;;
  stop|retry|fix|finish) echo "$3: done" ;;
  # Archived: in the archived list from now on (the board's list still has it here).
  archive) printf '[{"id":"%s","state":"done","title":"Archived","stage":"failed","archivedAt":1}]' "$3" > '${root}/archived.json'; echo "$3: done" ;;
  # What the board lists once a task is restored, when the spec gives it.
  restore) if [ -f '${root}/after-restore.json' ]; then mv '${root}/after-restore.json' '${root}/list.json'; echo '[]' > '${root}/archived.json'; fi; echo "$3: done" ;;
  show) case "$2" in --json) if [ -f '${root}/show.json' ]; then cat '${root}/show.json'; elif [ -f '${root}/own-agent' ]; then printf '{"settings":[{"name":"worker.agent","kind":"work","value":"%s","from":"this task","place":"task","own":true,"note":""}],"problems":[]}\\n' "$(cat '${root}/own-agent')"; else echo '${taskAgentReply}'; fi ;; --repo=demo) echo '${keyReply('DEMO')}' ;; --repo=web) echo '${keyReply('SITE')}' ;; *) echo '${keyReply('none')}' ;; esac ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })

const manifest = (version: string, launcher = true) => ({
  plugin_id: 'herdr-projects', enabled: true, version, plugin_root: root,
  ...(launcher
    ? { startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }
    : { startup: [{ command: ['target/release/herdr-projects', 'startup'] }] }),
})
const callLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [])

// The board links demo/1 to an agent pane of the scenario (its task.json, read only).
const home = path.join(path.dirname(fs.readFileSync(SOCK_FILE, 'utf8').trim()), 'home')
const taskDir = path.join(home, '.herdr-projects/data/tasks/demo/1')

test.beforeEach(() => {
  for (const f of [path.join(root, 'details.json'), calls, path.join(root, 'own-agent'), path.join(root, 'list.json'), path.join(root, 'archived.json'), path.join(root, 'after-restore.json'), path.join(root, 'after-approve.json'), path.join(root, 'web-coordinator'), path.join(root, 'refuse'), path.join(root, 'show.json'), path.join(root, 'version'), told]) fs.rmSync(f, { recursive: true, force: true })
  fs.mkdirSync(told)
})
test.afterEach(async () => { await fakeHerdr('e2e.plugins', { plugins: [] }) })
// The side panel's way back: a close button beside the Board, "Back to the Board" on a phone.
const closePanel = (page: import('@playwright/test').Page, phone: boolean) =>
  page.locator('.board-panel-head').getByRole('button', { name: phone ? 'Back to the Board' : 'Close' }).click()
test.afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.rmSync(path.join(home, '.herdr-projects'), { recursive: true, force: true })
})

test('the Board shows the 1.x tasks in its five groups, and acts on them', { tag: '@chromium-desktop' }, async ({ page }, testInfo) => {
  // Long, and WebKit on a small machine draws the agent's conversation slowly.
  test.setTimeout(120000)
  fs.mkdirSync(taskDir, { recursive: true })
  fs.writeFileSync(path.join(taskDir, 'task.json'), JSON.stringify({ id: 'demo/1', link: { pane: CLAUDE_PANE }, summary: 'Redirect fixed; a test covers the loop.' }))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.goto('/#/board')
  const phone = testInfo.project.name.includes('phone')
  const card = (key: string) => page.locator('.task-card', { hasText: key })
  // Grouped by repo by default; the five groups are one tap away.
  await expect(page.locator('.board-repo[data-repo="demo"]')).toBeVisible({ timeout: 15000 })
  await page.getByRole('button', { name: 'Global' }).click()
  if (phone) await page.getByRole('button', { name: /Ready to approve/ }).click()
  await expect(card('DEMO-1')).toContainText('Fix login redirect', { timeout: 15000 })
  await expect(card('DEMO-1')).toContainText('#7')
  await expect(card('DEMO-1')).toContainText('review · 1 minor')
  await page.screenshot({ path: `.shots/board-1x-${testInfo.project.name}.png` })
  if (phone) {
    await page.getByRole('button', { name: /Needs you/ }).click()
    await expect(card('DEMO-2')).toContainText('Which changelog format?')
  } else {
    for (const [col, key] of [['needs', 'DEMO-2'], ['ready', 'DEMO-1'], ['working', 'DEMO-3']] as const) {
      await expect(page.locator(`.board-col.${col} .task-card`, { hasText: key })).toBeVisible()
    }
  }
  // Done is hidden by default: its toggle counts it.
  await expect(page.locator('.board-col.done')).toHaveCount(0)
  await expect(page.locator('.board-done-toggle')).toHaveAccessibleName('Show done tasks (1)')
  expect(callLog()).toContain('list --json')

  // A task with an agent: its agent in the side panel (wherdr's agent view), under
  // who it is (machine, repo, task), its title, description and closing note.
  if (phone) await page.getByRole('button', { name: /Ready to approve/ }).click()
  await card('DEMO-1').click()
  const panel = page.locator('.board-panel')
  await expect(panel.locator('.board-panel-repo')).toHaveText('demo', { timeout: 15000 })
  await expect(panel.locator('.board-panel-machine')).not.toBeEmpty()
  await expect(panel.locator('.board-panel-name')).toContainText('DEMO-1')
  await expect(panel.locator('.board-panel-name')).toContainText('Fix login redirect')
  await expect(panel.locator('.board-panel-note')).toHaveCount(0)
  await expect(panel.locator('.cell-view .agent-top')).toHaveCount(0)
  await panel.locator('.board-panel-tabs').getByRole('button', { name: 'Task', exact: true }).click()
  await expect(panel.locator('.task-sheet-text').first()).toContainText('The login page loops')
  await expect(panel.locator('.board-panel-note')).toContainText('Redirect fixed; a test covers the loop.')
  await panel.locator('.board-panel-tabs').getByRole('button', { name: 'Agent', exact: true }).click()
  await expect(panel.locator('.cell-view textarea')).toBeVisible()
  const box = (await panel.boundingBox())!
  const view = page.viewportSize()!
  if (phone) expect(box.width).toBe(view.width)
  else {
    // Beside the Board, which stays in view.
    expect(box.width).toBeLessThan(view.width * 0.6)
    expect((await page.locator('.board-view').boundingBox())!.width).toBeLessThanOrEqual(view.width - box.width + 1)
  }
  await page.screenshot({ path: `.shots/board-1x-panel-${testInfo.project.name}.png` })
  // Its sheet, from the panel: pull request, review, approve (asked first).
  await panel.locator('.board-panel-sheet').click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.locator('.task-sheet-facts').first()).toContainText('Pass · 1 minor · codex')
  await expect(sheet.getByRole('link', { name: /#7/ })).toHaveAttribute('href', 'https://github.com/example/demo/pull/7')
  await expect(sheet.locator('.task-sheet-text').first()).toHaveText('The login page loops')
  // No message field: one button opens the chat (the panel), none other leads to its agent.
  await expect(sheet.getByRole('button', { name: 'Open the chat' })).toBeEnabled()
  await expect(sheet.getByRole('button', { name: 'Open its agent' })).toHaveCount(0)
  await expect(sheet.getByRole('textbox')).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-1x-task-${testInfo.project.name}.png` })
  // Once approved, the board lists it merging (herdr-projects' stage while it lands).
  const listed = JSON.parse(fs.readFileSync(path.join(fixtures, 'list.json'), 'utf8')) as Record<string, unknown>[]
  fs.writeFileSync(path.join(root, 'after-approve.json'), JSON.stringify(listed.map(t => (t.id === 'demo/1' ? { ...t, state: 'working', kind: '', stage: 'merging' } : t))))
  await sheet.getByRole('button', { name: 'Approve', exact: true }).click()
  await page.getByRole('dialog').last().getByRole('button', { name: 'Approve and merge' }).click()
  await expect.poll(callLog).toContain('approve -- demo/1')
  // Approved: the sheet stays, showing the task as the Board now reads it
  // (merging here), Approve no longer offered; the panel stays behind it.
  const approved = page.getByRole('dialog')
  await expect(approved.locator('.task-state')).toHaveText('Working')
  await expect(approved.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
  await expect(approved.getByRole('button', { name: 'Stop', exact: true })).toBeVisible()
  await expect(approved.getByRole('textbox')).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-1x-approved-${testInfo.project.name}.png` })
  // Open the chat: the sheet closes on the task's conversation in the panel.
  await approved.getByRole('button', { name: 'Open the chat' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panel.locator('.board-panel-name')).toContainText('DEMO-1')
  await expect(panel.locator('.cell-view textarea')).toBeVisible()
  await closePanel(page, phone)
  await expect(panel).toHaveCount(0)

  // No message field in a sheet. DEMO-2 has had no agent yet: its sheet, nothing to
  // chat with. DEMO-3 has one, whose pane is not known here: its sheet too, whose
  // chat opens the panel with a field that replies through herdr-projects (tell),
  // the user's words after "--".
  if (phone) await page.getByRole('button', { name: /Needs you/ }).click()
  await card('DEMO-2').click()
  await panel.locator('.board-panel-sheet').click()
  await expect(page.getByRole('dialog').locator('.task-sheet-msg')).toHaveText('Which changelog format?')
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0)
  await page.keyboard.press('Escape')
  if (await panel.count()) await closePanel(page, phone)
  if (phone) await page.getByRole('button', { name: /Working/ }).click()
  await card('DEMO-3').click()
  await panel.locator('.board-panel-sheet').click()
  await expect(page.getByRole('dialog').getByRole('textbox')).toHaveCount(0)
  await page.getByRole('dialog').getByRole('button', { name: 'Open the chat' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(panel.locator('.board-panel-name')).toContainText('DEMO-3')
  await panel.locator('#board-panel-tell').fill('--keep-a-changelog please')
  await page.screenshot({ path: `.shots/board-1x-tell-panel-${testInfo.project.name}.png` })
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(callLog).toContain('tell -- demo/3 --keep-a-changelog please')
  await closePanel(page, phone)
  await expect(page.locator('.board-panel')).toHaveCount(0)
  // No chat box on the Board: the top bar's Coordinator button opens it in the panel,
  // in both views; one not started yet takes a first message, which starts it.
  await expect(page.locator('#board-coord-text')).toHaveCount(0)
  await page.locator('.board-top').getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(panel.locator('.board-panel-name')).toHaveText('Coordinator')
  await panel.locator('#board-panel-first').fill('Add a dark mode toggle')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(callLog).toContain('coordinator -- tell Add a dark mode toggle')
  await expect(panel).toContainText('its conversation opens here')
})

test('a 0.2 or a 1.x older than 1.2.1: the Board and Settings say what to do, and run nothing', async ({ page }, testInfo) => {
  for (const plugin of [manifest('0.2.34', false), manifest('1.2.0')]) {
    await fakeHerdr('e2e.plugins', { plugins: [plugin] })
    // A full load for each version. Not goto + reload: the second goto only changes the
    // hash, and a reload on top of it made WebKit fail with an internal error.
    await page.goto('about:blank')
    await page.goto('/#/settings?section=plugins')
    const machine = page.locator('.projects-plugin-machine').first()
    await expect(machine.locator('.projects-plugin-head')).toContainText(`Update needed · v${plugin.version}`, { timeout: 15000 })
    const note = machine.locator('.projects-upgrade')
    await expect(note).toContainText('Update herdr-projects to 1.2.1 or later, or downgrade wherdr to 1.3.4')
    await expect(note).toContainText('herdr plugin uninstall herdr-projects && herdr plugin install eliasstravik/herdr-projects --ref v1.2.21 --yes')
    await expect(note).toContainText('npm install -g wherdr@1.3.4')
    await expect(note).toContainText('docs/herdr-projects-1x.md')
    if (plugin.version === '0.2.34') {
      await note.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `.shots/projects-plugin-old-${testInfo.project.name}.png` })
    }
  }
  await page.goto('/#/board')
  await expect(page.locator('.projects-upgrade')).toContainText('downgrade wherdr to 1.3.4', { timeout: 15000 })
  await expect(page.locator('.task-card')).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-1x-old-${testInfo.project.name}.png` })
  // The rest of wherdr still works: the agent list.
  await page.goto('/')
  await expect(page.locator('.card').first()).toBeVisible()
  expect(callLog()).toEqual([])
})

test('without herdr-projects: install the tested release, 1.2.21', async ({ page }, testInfo) => {
  await page.route('**/api/plugins/projects?*', route => route.fulfill({ json: { status: 'missing', version: null, installable: true } }))
  await page.goto('/#/settings?section=plugins')
  const machine = page.locator('.projects-plugin-machine').first()
  await expect(machine.locator('.projects-plugin-head')).toContainText('Not installed', { timeout: 15000 })
  await expect(machine.locator('.projects-upgrade')).toContainText('herdr plugin install eliasstravik/herdr-projects --ref v1.2.21 --yes')
  await machine.getByRole('button', { name: 'Install herdr-projects', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Install herdr-projects 1.2.21')
  await expect(dialog).toContainText('release v1.2.21')
  await page.screenshot({ path: `.shots/projects-plugin-install-${testInfo.project.name}.png` })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
})

// The real reply of the server (its program version from the fake launcher),
// on a machine whose Herdr folder wherdr may write to.
const writableHerdr = (page: import('@playwright/test').Page) => page.route('**/api/plugins/projects?*', async (route) => {
  const reply = await route.fetch()
  await route.fulfill({ json: { ...(await reply.json()), installable: true } })
})

test('an older 1.x: Update to the tested release, from what the program itself says', async ({ page }, testInfo) => {
  // Herdr's manifest says 1.2.1; the program was updated since (`herdr-projects update`).
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  fs.writeFileSync(path.join(root, 'version'), 'herdr-projects 1.2.16 (/opt/herdr-projects/bin/herdr-projects-linux-x86_64)\n')
  const posted: unknown[] = []
  await page.route('**/api/plugins/projects', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    posted.push(route.request().postDataJSON())
    fs.rmSync(path.join(root, 'version'), { force: true })
    await route.fulfill({ json: { output: 'Installed herdr-projects' } })
  })
  await writableHerdr(page)
  await page.goto('/#/settings?section=plugins')
  const machine = page.locator('.projects-plugin-machine').first()
  await expect(machine.locator('.projects-plugin-head')).toContainText('Update available · v1.2.16', { timeout: 15000 })
  // Only what 1.2.16 does not have yet.
  await expect(machine.locator('.projects-plugin-update')).toHaveText('Tested with 1.2.21. Adds archiving a whole project, and fixes; your tasks and settings stay.')
  await expect(machine.locator('.projects-upgrade')).toHaveCount(0)
  await machine.locator('.projects-plugin-update').scrollIntoViewIfNeeded()
  await page.screenshot({ path: `.shots/projects-plugin-update-${testInfo.project.name}.png` })
  await machine.getByRole('button', { name: 'Update to 1.2.21', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Update herdr-projects from 1.2.16 to 1.2.21')
  await expect(dialog).toContainText('Your tasks and settings stay.')
  await dialog.getByRole('button', { name: 'Update', exact: true }).click()
  await expect.poll(() => posted).toEqual([{ machine: expect.any(String), update: true }])
  // Then it reads 1.2.21: nothing more to offer.
  await expect(machine.locator('.projects-plugin-head')).toContainText('Installed · v1.2.21')
  await expect(machine.getByRole('button', { name: 'Update to 1.2.21' })).toHaveCount(0)
  await expect(machine.locator('.projects-plugin-reload')).toContainText('prefix')
  await expect(machine.locator('.projects-plugin-reload')).not.toContainText('first-run questions')
})

test('an older 1.x, in French: what the update adds', async ({ page }) => {
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  fs.writeFileSync(path.join(root, 'version'), 'herdr-projects 1.2.1 (/opt/herdr-projects/bin/herdr-projects-linux-x86_64)\n')
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  await writableHerdr(page)
  await page.goto('/#/settings?section=plugins')
  const machine = page.locator('.projects-plugin-machine').first()
  await expect(machine.locator('.projects-plugin-head')).toContainText('Mise à jour disponible · v1.2.1', { timeout: 15000 })
  await expect(machine.locator('.projects-plugin-update')).toHaveText('Testé avec 1.2.21. Ajoute l’accès auto des agents, une page de réglages, les tâches conversation seule, l’archivage de tous les terminés d’un coup, l’autopilot, l’archivage d’un projet entier, et des corrections ; tes tâches et tes réglages restent.')
  await expect(machine.getByRole('button', { name: 'Mettre à jour en 1.2.21', exact: true })).toBeVisible()
})

// Replies of the server the Board must show as they are: a failed read.
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, repo: id.split('/')[0], n: Number(id.split('/')[1]), state: 'blocked', kind: 'permission', stage: 'approval', title: `Task ${id}`, msg: '',
  app: 'claude', progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'ready', ...o,
})
const reply = (machine: Record<string, unknown>) => ({ json: { version: `v-${Date.now()}`, machines: [{ machine: '', status: 'ready', version: '1.2.1', ...machine }] } })

test('a failed read says why, and keeps the last tasks marked with when they were read', async ({ page }, testInfo) => {
  const at = Date.UTC(2026, 0, 2, 9, 41)
  await page.route('**/api/tasks?*', route => route.fulfill(reply({ tasks: [row('demo/1')], at, stale: true, error: 'herdr-projects did not answer within 30 s' })))
  await page.route('**/api/tasks', route => route.fulfill(reply({ tasks: [row('demo/1')], at, stale: true, error: 'herdr-projects did not answer within 30 s' })))
  await page.goto('/#/board')
  const note = page.locator('.board-machine-error')
  await expect(note).toContainText('unreachable', { timeout: 15000 })
  await expect(note.locator('..')).toHaveAttribute('aria-label', 'herdr-projects did not answer within 30 s')
  await expect(page.locator('.board-notes .error')).toHaveCount(0)
  await expect(note).toContainText('read at')
  await expect(page.locator('.task-card.stale')).toContainText('Task demo/1')
  await page.screenshot({ path: `.shots/board-1x-error-${testInfo.project.name}.png` })
})

test('Herdr not answering for a machine: said, not five empty columns', async ({ page }) => {
  await page.route('**/api/tasks*', route => route.fulfill(reply({ status: 'error', tasks: [], error: 'Herdr did not answer' })))
  await page.goto('/#/board')
  await expect(page.locator('.board-machine-error')).toContainText('unreachable', { timeout: 15000 })
  await expect(page.locator('.board-machine .board-fold')).toBeVisible()
  await expect(page.locator('.board-notes .error')).toHaveCount(0)
})

test('unreachable machines follow the selection, with touch detail and empty headings', async ({ page }) => {
  await page.route('**/api/tasks*', route => route.fulfill({ json: { version: 'offline-machines', machines: [
    { machine: '', status: 'ready', version: '1.2.21', tasks: [] },
    { machine: 'laptop', status: 'error', version: '', tasks: [], stale: true, at: Date.UTC(2026, 0, 2, 2, 33), error: 'Connection timed out' },
  ] } }))
  await page.goto('/#/board?machine=')
  await expect(page.locator('.board-machine[data-machine="local"]')).toBeVisible()
  await expect(page.locator('.board-machine-error')).toHaveCount(0)
  await expect(page.locator('.board-notes .error')).toHaveCount(0)
  await page.goto('/#/board?machine=laptop')
  const heading = page.locator('.board-machine[data-machine="laptop"] .board-head.machine')
  await expect(heading).toContainText('unreachable · read at 02:33')
  const hint = heading.locator('.coordinator-hint').filter({ has: page.locator('.board-machine-error') })
  await hint.dispatchEvent('pointerdown', { pointerId: 1, pointerType: 'touch', clientX: 80, clientY: 300 })
  await expect(page.locator('.coordinator-tooltip')).toContainText('Connection timed out')
  await hint.dispatchEvent('pointerup', { pointerId: 1, pointerType: 'touch' })
  await page.screenshot({ path: '.shots/board-unreachable-iphone.png' })
  await heading.locator('.board-fold').click()
  await expect(heading.locator('.board-machine-error')).toBeVisible()
  await page.getByRole('button', { name: 'Global', exact: true }).click()
  await expect(heading.locator('.board-machine-error')).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(page.locator('.board-grid')).toHaveClass(/desk/)
  const headBox = (await heading.boundingBox())!
  const cellsBox = (await page.locator('.board-cols').boundingBox())!
  expect(headBox.y + headBox.height).toBeLessThanOrEqual(cellsBox.y)
  await page.screenshot({ path: '.shots/board-unreachable-desktop.png' })
  await expect(page.locator('.board-notes .error')).toHaveCount(0)
})

test('an unreachable machine label is translated into French', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.route('**/api/tasks*', route => route.fulfill(reply({ status: 'error', tasks: [], at: Date.UTC(2026, 0, 2, 2, 33), error: 'Connection timed out' })))
  await page.goto('/#/board')
  await expect(page.locator('.board-machine-error')).toHaveText('injoignable · lu à 02:33')
})

// A board with a task for each action, in two repos.
const actionBoard = [
  { id: 'demo/5', state: 'idle', title: 'In the backlog', stage: 'todo' },
  { id: 'demo/6', state: 'error', app: 'claude', title: 'Broke on the tests', msg: 'npm test failed', stage: 'failed' },
  { id: 'demo/3', state: 'working', app: 'codex', title: 'Add dark mode toggle', msg: 'Writing tests', stage: 'working', progress: 40 },
  { id: 'web/2', state: 'done', title: 'Old cleanup', msg: 'Merged', stage: 'done' },
]

test('grouped by machine then repo: each heading opens its coordinator in the side panel', async ({ page }, testInfo) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(actionBoard))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.goto('/#/board')
  const phone = testInfo.project.name.includes('phone')
  // Phone: one group at a time, in tabs; the lanes inside.
  const tab = async (name: RegExp) => { if (phone) await page.locator('.board-seg').getByRole('button', { name }).click() }
  const demo = page.locator('.board-repo[data-repo="demo"]')
  const web = page.locator('.board-repo[data-repo="web"]')
  await expect(demo.locator('.board-head')).toContainText('1 needs you · 1 working · 1 to do', { timeout: 15000 })
  // Done is hidden: web's heading still counts it, quietly.
  await expect(web.locator('.board-head-done')).toHaveText('1 done')
  await expect(web.locator('.board-repo-col[data-group="done"]')).toHaveCount(0)
  await tab(/^To do/)
  await expect(demo).toContainText('In the backlog')
  await page.getByRole('button', { name: 'Show done tasks (1)' }).click()
  await expect(web).toContainText('Old cleanup')
  // Each task by its repo's key (show --repo), not its repo's name: web's is SITE.
  await expect(web.locator('.task-card')).toContainText('SITE-2')
  await tab(/^To do/)
  await expect(demo.locator('.task-card', { hasText: 'In the backlog' })).toContainText('DEMO-5')
  await expect(page.locator('.board-head.machine')).toBeVisible()
  // Each repo's lane: one cell under each of the Board's columns.
  const col = (repo: typeof demo, g: string) => repo.locator(`.board-repo-col[data-group="${g}"]`)
  await expect(col(demo, 'needs')).toContainText('Broke on the tests')
  await expect(col(demo, 'working')).toContainText('Add dark mode toggle')
  await expect(col(demo, 'todo')).toContainText('In the backlog')
  await expect(col(web, 'done')).toContainText('Old cleanup')
  if (phone) {
    // Phone: only the tab's group shows, in every lane; an empty one says so.
    await expect(col(demo, 'todo')).toBeVisible()
    await expect(col(demo, 'needs')).toBeHidden()
    await tab(/^Ready to approve/)
    await expect(col(demo, 'ready')).toContainText('Nothing here')
    await expect(col(demo, 'todo')).toBeHidden()
    await tab(/^Needs you/)
  } else {
    // Computer: the columns of equal width, aligned from one lane to the next and with the Board's heads.
    const box = async (l: import('@playwright/test').Locator) => (await l.boundingBox())!
    for (const g of ['needs', 'ready', 'working', 'todo', 'done']) {
      const head = await box(page.locator(`.board-grid-head .board-col-head.${g}`))
      for (const lane of [demo, web]) {
        const cell = await box(col(lane, g))
        expect(Math.abs(cell.x - head.x)).toBeLessThan(1.5)
        expect(Math.abs(cell.width - head.width)).toBeLessThan(1.5)
      }
    }
    expect(Math.abs((await box(col(demo, 'ready'))).width - (await box(col(demo, 'needs'))).width)).toBeLessThan(1.5)
  }
  await page.screenshot({ path: `.shots/board-1x-repos-${testInfo.project.name}.png` })

  const panel = page.locator('.board-panel')
  // A repo's lane: its project coordinator, not started yet: a first message starts it.
  await page.getByRole('button', { name: 'web coordinator' }).click()
  await expect(panel.locator('.board-panel-name')).toHaveText('web coordinator')
  await expect(panel.locator('.board-panel-repo')).toHaveText('web')
  if (!phone) await expect(web.locator('.board-head')).toHaveClass(/talking/)
  await panel.locator('#board-panel-first').fill('--tidy up')
  await page.screenshot({ path: `.shots/board-1x-project-coord-${testInfo.project.name}.png` })
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(callLog).toContain('coordinator --project=web -- tell --tidy up')
  // Once it runs (herdr-projects names its pane), the panel is its conversation.
  fs.writeFileSync(path.join(root, 'web-coordinator'), '')
  await expect(panel.locator('.cell-view .agent-top')).toBeVisible({ timeout: 15000 })
  await expect(panel.locator('.cell-view textarea')).toBeVisible()
  await expect(panel.locator('.board-panel-name')).toHaveText('web coordinator')
  await page.screenshot({ path: `.shots/board-1x-coord-panel-${testInfo.project.name}.png` })
  // The main Coordinator stays at the top; the machine coordinator is in its lane.
  if (phone) await closePanel(page, phone)
  const machineHead = page.locator('.board-head.machine')
  await page.locator('.board-top').getByRole('button', { name: 'Coordinator', exact: true }).click()
  await expect(panel.locator('.board-panel-name')).toHaveText('Coordinator')
  await expect(panel.locator('.board-panel-repo')).toHaveCount(0)
  await panel.locator('#board-panel-first').fill('plain')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(callLog).toContain('coordinator -- tell plain')
  if (phone) await closePanel(page, phone)
  await machineHead.getByRole('button', { name: / coordinator$/ }).click()
  // Named once, after its machine: "<machine> coordinator".
  const host = ((await panel.locator('.board-panel-machine').textContent()) || '').trim()
  expect(host).not.toBe('')
  await expect(panel.locator('.board-panel-name')).toHaveText(`${host} coordinator`)
  await panel.locator('#board-panel-first').fill('for the machine')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(callLog).toContain('coordinator --machine -- tell for the machine')
  await closePanel(page, phone)
  await expect(panel).toHaveCount(0)

  // A folded repo hides its tasks, and stays folded on this device.
  await web.locator('.board-fold').click()
  await expect(web).not.toContainText('Old cleanup')
  await page.reload()
  await expect(page.locator('.board-repo[data-repo="web"]')).not.toContainText('Old cleanup', { timeout: 15000 })
  await expect(page.locator('.board-repo[data-repo="demo"]')).toContainText('In the backlog')
})

// Seven done tasks, newest first as herdr-projects lists them, across two repos.
const doneBoard = [
  { id: 'demo/5', state: 'idle', title: 'In the backlog', stage: 'todo' },
  ...[['web/9', 'Newest done'], ['demo/8', 'Second'], ['web/7', 'Third'], ['demo/6', 'Fourth'], ['web/5', 'Fifth'], ['demo/4', 'Sixth'], ['web/3', 'Oldest done']]
    .map(([id, title]) => ({ id, state: 'done', title, msg: 'Merged', stage: 'done' })),
]

test('Done is hidden by default; its toggle shows the latest five, newest first, and is kept on the device', { tag: '@chromium-desktop' }, async ({ page }, testInfo) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(doneBoard))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.goto('/#/board')
  const phone = testInfo.project.name.includes('phone')
  await page.getByRole('button', { name: 'Global' }).click()
  const toggle = page.locator('.board-done-toggle')
  await expect(toggle).toHaveAccessibleName('Show done tasks (7)', { timeout: 15000 })
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  // Four columns (or tabs), none of them Done.
  if (phone) await expect(page.locator('.board-seg .board-seg-btn:not(.board-done-toggle)')).toHaveCount(4)
  else await expect(page.locator('.board-grid-head .board-col-head')).toHaveCount(4)
  await expect(page.locator('.board-col.done')).toHaveCount(0)
  await expect(page.locator('.task-card', { hasText: 'Newest done' })).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-done-hidden-${testInfo.project.name}.png` })

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(toggle).toHaveAccessibleName('Hide done tasks')
  // Shown (the phone goes to its tab): the latest five, newest first, then how many more.
  const done = page.locator('.board-col.done')
  await expect(done).toBeVisible()
  await expect(done.locator('.task-card')).toHaveCount(5)
  await expect(done.locator('.task-card').first()).toContainText('Newest done')
  await expect(done.locator('.task-card').last()).toContainText('Fifth')
  await expect(done.locator('.board-more')).toHaveText('Show all (2 more)')
  await page.screenshot({ path: `.shots/board-done-shown-${testInfo.project.name}.png` })
  await done.locator('.board-more').click()
  await expect(done.locator('.task-card')).toHaveCount(7)
  await expect(done.locator('.task-card').last()).toContainText('Oldest done')

  // Kept on this device.
  await page.reload()
  await expect(page.locator('.board-done-toggle')).toHaveAttribute('aria-pressed', 'true', { timeout: 15000 })
  if (phone) await page.locator('.board-seg').getByRole('button', { name: /^Done/ }).click()
  await expect(page.locator('.board-col.done .task-card')).toHaveCount(5)
  // Hidden again, in both views.
  await page.locator('.board-done-toggle').click()
  await expect(page.locator('.board-col.done')).toHaveCount(0)
  await page.getByRole('button', { name: 'By repo' }).click()
  await expect(page.locator('.board-repo-col[data-group="done"]')).toHaveCount(0)
  await expect(page.locator('.board-repo[data-repo="web"] .board-head-done')).toHaveText('4 done')
  await page.reload()
  await expect(page.locator('.board-done-toggle')).toHaveAttribute('aria-pressed', 'false', { timeout: 15000 })
})

test('+ New task: in a repo, with Start now; and the task sheet starts, stops, retries and archives', { tag: '@webkit-phone' }, async ({ page }, testInfo) => {
  test.setTimeout(60000)
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(actionBoard))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.goto('/#/board')
  const demo = page.locator('.board-repo[data-repo="demo"]')
  await expect(demo).toContainText('In the backlog', { timeout: 15000 })

  await page.getByRole('button', { name: 'New task in demo' }).click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.getByRole('button', { name: 'Add to To do' })).toBeVisible()
  await sheet.getByLabel('Title').fill('Fix the footer')
  await sheet.getByLabel('Description').fill('--steps here')
  await sheet.getByRole('switch').click()
  await page.screenshot({ path: `.shots/board-1x-new-task-${testInfo.project.name}.png` })
  await sheet.getByRole('button', { name: 'Add and start' }).click()
  await expect.poll(callLog).toContain('add --desc=--steps here --repo=demo --delegate -- Fix the footer')
  await expect(sheet).toHaveCount(0)
  // From the header: the home folder by default, no agent; a repo picked, then the home folder again.
  const selectErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' && /Select/i.test(m.text())) selectErrors.push(m.text()) })
  await page.locator('.board-new').click()
  await page.locator('#new-task-repo').click()
  await page.getByRole('option', { name: 'web' }).click()
  await expect(page.locator('#new-task-repo')).toContainText('web')
  await page.locator('#new-task-repo').click()
  await page.getByRole('option', { name: 'Home folder' }).click()
  await expect(page.locator('#new-task-repo')).toContainText('Home folder')
  expect(selectErrors).toEqual([])
  await page.getByRole('dialog').getByLabel('Title').fill('Home chores')
  await page.getByRole('dialog').getByRole('button', { name: 'Add to To do' }).click()
  await expect.poll(callLog).toContain('add -- Home chores')

  const card = (title: string) => page.locator('.task-card', { hasText: title })
  const task = page.getByRole('dialog')
  // Phone: one group at a time, picked in its tabs.
  const tab = async (name: RegExp) => { if (testInfo.project.name.includes('phone')) await page.locator('.board-seg').getByRole('button', { name }).click() }
  // To do: Start.
  await tab(/^To do/)
  await card('In the backlog').click()
  await page.locator('.board-panel-sheet').click()
  await expect(task.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  // Start names the task's default agent, preselected; one click starts with it, as before.
  const agents = task.getByRole('radiogroup', { name: 'Agent for this start' })
  await expect(agents.getByRole('radio', { name: /claude/ })).toHaveAttribute('aria-checked', 'true')
  await expect(agents).toContainText('Default from your settings for demo')
  await task.getByRole('button', { name: 'Start', exact: true }).click()
  await expect.poll(callLog).toContain('delegate -- demo/5')
  await page.keyboard.press('Escape')
  if (await page.locator('.board-panel').count()) await closePanel(page, testInfo.project.name.includes('phone'))
  // Another installed agent, for this start only: passed to delegate, no setting changed.
  await card('In the backlog').click()
  await page.locator('.board-panel-sheet').click()
  await agents.getByRole('radio', { name: /codex/ }).click()
  await expect(agents).toContainText('For this start only: the default stays.')
  await task.getByRole('button', { name: 'Start with codex', exact: true }).click()
  await expect.poll(callLog).toContain('delegate --worker.agent=codex -- demo/5')
  await page.keyboard.press('Escape')
  if (await page.locator('.board-panel').count()) await closePanel(page, testInfo.project.name.includes('phone'))
  // That pick was for one start: the task's default is claude again (its own setting taken back).
  await card('In the backlog').click()
  await page.locator('.board-panel-sheet').click()
  await expect(agents.getByRole('radio', { name: /claude/ })).toHaveAttribute('aria-checked', 'true')
  await expect(agents).toContainText('Default from your settings for demo')
  await expect.poll(callLog).toContain('unset --task=demo/5 -- worker.agent')
  expect(fs.existsSync(path.join(root, 'own-agent'))).toBe(false)
  await page.keyboard.press('Escape')
  if (await page.locator('.board-panel').count()) await closePanel(page, testInfo.project.name.includes('phone'))
  // Working: Stop, asked first; no Archive.
  await tab(/^Working/)
  await card('Add dark mode toggle').click()
  await page.locator('.board-panel-sheet').click()
  await expect(task.getByRole('button', { name: 'Archive' })).toHaveCount(0)
  await task.getByRole('button', { name: 'Stop', exact: true }).click()
  await page.getByRole('dialog').last().getByRole('button', { name: 'Stop the agent' }).click()
  await expect.poll(callLog).toContain('stop -- demo/3')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  // The sheet stays open after a stop (to reply or retry): closed by its button.
  await task.locator('.hw-sheet-close').click()
  if (await page.locator('.board-panel').count()) await closePanel(page, testInfo.project.name.includes('phone'))
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Failed: Retry, then Archive (the sheet closes).
  await tab(/^Needs you/)
  await card('Broke on the tests').click()
  await page.locator('.board-panel-sheet').click()
  await expect(task.getByRole('button', { name: 'Retry' })).toBeVisible()
  await page.screenshot({ path: `.shots/board-1x-task-actions-${testInfo.project.name}.png` })
  await task.getByRole('button', { name: 'Retry' }).click()
  await expect.poll(callLog).toContain('retry -- demo/6')
  await task.getByRole('button', { name: 'Archive' }).click()
  await expect.poll(callLog).toContain('archive -- demo/6')
  // Archived: the sheet closes, the card leaves the Board at once (the list read
  // again still has it here), and a toast offers Restore for a few seconds.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const toastBox = page.locator('.hw-toast', { hasText: 'DEMO-6 archived' })
  await expect(toastBox).toBeVisible()
  await expect(card('Broke on the tests')).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-1x-archived-toast-${testInfo.project.name}.png` })
  await toastBox.getByRole('button', { name: 'Restore' }).click()
  await expect.poll(callLog).toContain('restore -- demo/6')
  await expect(card('Broke on the tests')).toBeVisible()
})

test('agents unchecked in Settings › Agents are not offered at Start; an unchecked default stays, marked', async ({ page }, testInfo) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(actionBoard))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.addInitScript(() => localStorage.setItem('hiddenAgents', JSON.stringify(['claude', 'codex'])))
  await page.goto('/#/board')
  if (testInfo.project.name.includes('phone')) await page.locator('.board-seg').getByRole('button', { name: /^To do/ }).click()
  await page.locator('.task-card', { hasText: 'In the backlog' }).click({ timeout: 15000 })
  await page.locator('.board-panel-sheet').click()
  const agents = page.getByRole('dialog').getByRole('radiogroup', { name: 'Agent for this start' })
  const claude = agents.getByRole('radio', { name: /claude/ })
  await expect(claude).toHaveAttribute('aria-checked', 'true')
  await expect(claude).toContainText('default · hidden in Settings')
  await expect(agents.getByRole('radio', { name: /codex/ })).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-1x-start-hidden-agents-${testInfo.project.name}.png` })
})

test('Start with a model and an effort: none by default, picked after the program, sent for this start', async ({ page }, testInfo) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(actionBoard))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.route(url => new URL(url).pathname === '/api/tasks/models', route => {
    const program = new URL(route.request().url()).searchParams.get('program')
    return route.fulfill({ json: { program, models: ['gpt-6-sol', 'gpt-6-luna'], efforts: ['low', 'high', 'ultra'], only: [{ models: ['gpt-6-luna'], levels: ['low', 'high'] }] } })
  })
  const sent: unknown[] = []
  await page.route(url => new URL(url).pathname === '/api/tasks/action', (route) => {
    sent.push(route.request().postDataJSON())
    return route.fulfill({ json: { ok: true, msg: 'started' } })
  })
  await page.goto('/#/board')
  if (testInfo.project.name.includes('phone')) await page.locator('.board-seg').getByRole('button', { name: /^To do/ }).click()
  await page.locator('.task-card', { hasText: 'In the backlog' }).click({ timeout: 15000 })
  await page.locator('.board-panel-sheet').click()
  const sheet = page.getByRole('dialog')
  const model = sheet.locator('.task-start-model')
  await expect(model.getByRole('button', { name: 'Model : Program’s default' })).toBeVisible()
  await model.getByRole('button', { name: /^Model/ }).click()
  await page.getByRole('menuitemcheckbox', { name: 'gpt-6-luna' }).click()
  await model.getByRole('button', { name: /^Effort/ }).click()
  await expect(page.getByRole('menuitemcheckbox')).toHaveText(['Model’s default', 'low', 'high'])
  await page.getByRole('menuitemcheckbox', { name: 'high' }).click()
  // Square, 1 px, inside the sheet on a phone: no sideways scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: `.shots/board-1x-start-model-${testInfo.project.name}.png` })
  const start = sheet.getByRole('button', { name: /^Start with/ })
  await expect(start).toHaveText(/codex\/gpt-6-luna|claude\/gpt-6-luna/)
  await start.click()
  await expect.poll(() => sent.length).toBe(1)
  expect(sent[0]).toMatchObject({ action: 'delegate', effort: 'high' })
  expect((sent[0] as { agent: string }).agent).toMatch(/\/gpt-6-luna$/)
})

test('Archived:the archived tasks, each one\'s sheet read-only with Restore', async ({ page }, testInfo) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(actionBoard))
  fs.writeFileSync(path.join(root, 'archived.json'), JSON.stringify([
    { id: 'demo/2', state: 'done', title: 'Put away last week', msg: 'Merged', stage: 'done', archivedAt: 1760000000 },
  ]))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.goto('/#/board')
  await expect(page.locator('.board-repo[data-repo="demo"]')).toContainText('In the backlog', { timeout: 15000 })
  await page.getByRole('button', { name: 'Archived' }).click()
  const archived = page.locator('.board-archived')
  const card = archived.locator('.task-card', { hasText: 'Put away last week' })
  await expect(card).toBeVisible()
  expect(callLog()).toContain('list --json --archived')
  await card.scrollIntoViewIfNeeded()
  await page.screenshot({ path: `.shots/board-1x-archived-list-${testInfo.project.name}.png` })
  await card.click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.locator('.task-archived')).toHaveText('Archived')
  await expect(sheet.locator('.task-sheet-actions').getByRole('button')).toHaveText(['Restore'])
  await expect(sheet.getByRole('textbox')).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-1x-archived-sheet-${testInfo.project.name}.png` })
  // Restored: off the archived list, back on the Board, and its sheet offers Archive again.
  fs.writeFileSync(path.join(root, 'after-restore.json'), JSON.stringify([...actionBoard, { id: 'demo/2', state: 'done', title: 'Put away last week', msg: 'Merged', stage: 'done' }]))
  await sheet.getByRole('button', { name: 'Restore' }).click()
  await expect.poll(callLog).toContain('restore -- demo/2')
  await expect(sheet.locator('.task-archived')).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Archive' })).toBeVisible()
  await expect(archived.locator('.task-card')).toHaveCount(0)
})

test('a push about a task opens it on the Board', async ({ page }) => {
  fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify(actionBoard))
  await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
  await page.goto('/#/board?machine=&task=demo%2F6')
  await page.locator('.board-panel-sheet').click()
  const sheet = page.getByRole('dialog')
  await expect(sheet).toContainText('Broke on the tests', { timeout: 15000 })
  await expect(sheet.getByRole('button', { name: 'Retry' })).toBeVisible()
  // Settings give the one command that turns these pushes on.
  await page.goto('/#/settings?section=plugins')
  await expect(page.locator('.projects-plugin-notify')).toContainText(`herdr-projects set board.notify 'herdr notification show`, { timeout: 15000 })
})

// Two machines, answered by the page itself (/api/tasks): the same task id on
// both, a machine that stops answering, a board kept from an earlier visit.
type Fake = { machine: string, status?: string, error?: string, stale?: boolean, tasks: ({ id: string, title: string } & Record<string, unknown>)[] }
const fakeRow = (id: string, title: string) => ({
  id, repo: id.split('/')[0], n: Number(id.split('/')[1]), state: 'blocked', kind: 'question', stage: 'asks', title, msg: '', app: 'claude',
  progress: null, eta: null, pr: '', review: null, reviewRound: 0, research: false, archived: false, queue: null, group: 'needs',
})
async function fakeBoard(page: import('@playwright/test').Page, get: () => Fake[], delay = 0) {
  let n = 0
  await page.route(url => new URL(url).pathname === '/api/tasks', async (route) => {
    if (delay) await new Promise(r => setTimeout(r, delay))
    await route.fulfill({ json: { version: `v${++n}`, machines: get().map(m => ({ status: 'ready', version: '1.2.1', at: Date.now(), ...m, tasks: m.tasks.map(t => ({ ...fakeRow(t.id, t.title), ...t })) })) } })
  })
  await page.route(url => new URL(url).pathname === '/api/tasks/details', route => route.fulfill({
    json: { id: new URL(route.request().url()).searchParams.get('id'), title: '', stage: 'asks', msg: '', description: '', agent: 'claude', pr: '', branch: '', worktree: '', failure: '', failureStage: '', failureAuth: false, review: null, reviewRounds: 0, plan: '', research: false, pane: null },
  }))
}

test('a push opens its own machine\'s task, never the same id on another machine', async ({ page }) => {
  let machines: Fake[] = [{ machine: 'ma', tasks: [] }, { machine: 'mb', tasks: [{ id: 'demo/1', title: 'On machine B' }] }]
  await fakeBoard(page, () => machines)
  await page.goto('/#/board?machine=ma&task=demo%2F1')
  await expect(page.locator('.board-machine[data-machine="mb"]')).toContainText('On machine B', { timeout: 15000 })
  await expect(page.locator('.hw-toast-title', { hasText: 'That task is no longer on the Board' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Machine A does not answer: said, and its task opens once it does.
  machines = [{ machine: 'ma', status: 'error', error: 'No answer', tasks: [] }, machines[1]!]
  await page.evaluate(() => { location.hash = '#/' })
  await expect(page.locator('.board-view')).toHaveCount(0)
  await page.evaluate(() => { location.hash = '#/board?machine=ma&task=demo%2F1' })
  await expect(page.locator('.hw-toast-title', { hasText: /cannot be read now: its task opens once it answers/ })).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  machines = [{ machine: 'ma', tasks: [{ id: 'demo/1', title: 'On machine A' }] }, machines[1]!]
  await page.locator('.board-filter').click()
  await expect(page.locator('.board-panel')).toContainText('On machine A', { timeout: 15000 })
})

test('Done across machines: the latest five of all of them, newest first; a link still opens a done task while Done is hidden', async ({ page }) => {
  const done = (id: string, title: string, created: number) => ({ id, title, created, state: 'done', kind: '', stage: 'done', msg: 'Merged', group: 'done' })
  // Machine A lists six done tasks, machine B its newest one and an old one.
  await fakeBoard(page, () => [
    { machine: 'ma', tasks: [60, 50, 40, 30, 20, 10].map((c, i) => done(`demo/${10 - i}`, `A done ${i + 1}`, c)) },
    { machine: 'mb', tasks: [done('web/9', 'B newest', 100), done('web/2', 'B oldest', 5)] },
  ])
  // Hidden, yet a link to a done task opens it.
  await page.goto('/#/board?machine=mb&task=web%2F9')
  await expect(page.locator('.board-panel, [role="dialog"]').filter({ hasText: 'B newest' }).first()).toBeVisible({ timeout: 15000 })
  // Back to the Board alone (the panel closes with a fresh page).
  await page.goto('/#/board')
  await page.reload()
  await page.getByRole('button', { name: 'Global' }).click()
  await expect(page.locator('.board-done-toggle')).toHaveAccessibleName('Show done tasks (8)', { timeout: 15000 })
  await page.locator('.board-done-toggle').click()
  const cards = page.locator('.board-col.done .task-card')
  await expect(cards).toHaveCount(5)
  await expect(cards.first()).toContainText('B newest')
  await expect(cards.last()).toContainText('A done 4')
  await expect(page.locator('.board-col.done')).not.toContainText('B oldest')
  await page.locator('.board-col.done .board-more').click()
  await expect(cards).toHaveCount(8)
  await expect(cards.last()).toContainText('B oldest')
})

test('the machine filter lists the local machine and shows only its tasks', async ({ page }, testInfo) => {
  // The local machine (key '') and an SSH machine.
  await fakeBoard(page, () => [{ machine: '', tasks: [{ id: 'demo/1', title: 'On this machine' }] }, { machine: 'mb', tasks: [{ id: 'web/2', title: 'On machine B' }] }])
  const selectErrors: string[] = []
  page.on('console', (m) => { if (m.type() === 'error' && /Select/i.test(m.text())) selectErrors.push(m.text()) })
  await page.goto('/#/board')
  await expect(page.locator('.task-card', { hasText: 'On this machine' })).toBeVisible({ timeout: 15000 })
  await page.locator('.board-scope').click()
  const options = page.getByRole('option')
  await expect(options).toHaveCount(3)
  await expect(options.nth(0)).toHaveText('All machines')
  // Named as this machine is named (HOST_LABEL), in Herdr's order.
  const local = 'devbox'
  await expect(options.nth(1)).toHaveText(local)
  // A machine Herdr does not name: its key, never this machine's name.
  await expect(options.nth(2)).toHaveText('mb')
  await page.screenshot({ path: `.shots/board-scope-local-${testInfo.project.name}.png` })
  await options.nth(1).click()
  await expect(page.locator('.board-scope')).toContainText(local)
  await expect(page.locator('.task-card', { hasText: 'On this machine' })).toBeVisible()
  await expect(page.locator('.task-card', { hasText: 'On machine B' })).toHaveCount(0)
  // Kept on this device: still the local machine after a reload.
  await page.reload()
  await expect(page.locator('.task-card', { hasText: 'On this machine' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.task-card', { hasText: 'On machine B' })).toHaveCount(0)
  await expect(page.locator('.board-scope')).toContainText(local)
  expect(selectErrors).toEqual([])
})

test('the machine filter offers the home list\'s machine groups, and follows them when Settings change them', async ({ page }, testInfo) => {
  await fakeBoard(page, () => [
    { machine: 'ma', tasks: [{ id: 'demo/1', title: 'On machine A' }] },
    { machine: 'mb', tasks: [{ id: 'web/2', title: 'On machine B' }] },
    { machine: 'mc', tasks: [{ id: 'api/3', title: 'On machine C' }] },
  ])
  // Groups as Settings › Machine bar saves them; set once, so a reload keeps what the test changes.
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('machineGroups', JSON.stringify([{ id: '*group:pair', name: 'Pair', machines: ['ma', 'mb'] }]))
  })
  await page.goto('/#/board')
  await expect(page.locator('.task-card', { hasText: 'On machine C' })).toBeVisible({ timeout: 15000 })
  await page.locator('.board-scope').click()
  const options = page.getByRole('option')
  await expect(options).toHaveText(['All machines', 'Pair', 'ma', 'mb', 'mc'])
  await expect(page.getByRole('listbox')).toContainText('Groups')
  await page.screenshot({ path: `.shots/board-scope-groups-${testInfo.project.name}.png` })
  await options.nth(1).click()
  await expect(page.locator('.board-scope')).toContainText('Pair')
  await expect(page.locator('.task-card', { hasText: 'On machine A' })).toBeVisible()
  await expect(page.locator('.task-card', { hasText: 'On machine B' })).toBeVisible()
  await expect(page.locator('.task-card', { hasText: 'On machine C' })).toHaveCount(0)
  // Counters follow: two tasks need you in this group (phone tabs, or the wide Board's column heads).
  const needs = page.locator('.board-seg-btn.needs b, .board-col-head.needs .pp-count')
  await expect(needs).toHaveText('2')
  // Kept on the server (it follows the user across devices); a group edited in
  // Settings shows its machines now.
  const saveGroups = async (groups: unknown[]) => {
    const r = await page.request.post(`${BASE_URL}/api/settings`, { headers: { Origin: BASE_URL }, data: { settings: { machineGroups: JSON.stringify(groups) } } })
    expect(r.ok()).toBe(true)
  }
  await saveGroups([{ id: '*group:pair', name: 'Pair', machines: ['mc'] }])
  await page.reload()
  await expect(page.locator('.task-card', { hasText: 'On machine C' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.task-card', { hasText: 'On machine A' })).toHaveCount(0)
  await expect(page.locator('.board-scope')).toContainText('Pair')
  await expect(needs).toHaveText('1')
  // Deleted in Settings: All machines again, and the menu as without groups.
  await saveGroups([])
  await page.reload()
  await expect(page.locator('.task-card', { hasText: 'On machine A' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.task-card', { hasText: 'On machine C' })).toBeVisible()
  await expect(page.locator('.board-scope')).toContainText('All machines')
  await page.locator('.board-scope').click()
  await expect(page.getByRole('option')).toHaveText(['All machines', 'ma', 'mb', 'mc'])
  await expect(page.getByRole('listbox')).not.toContainText('Groups')
})

test('a push for a task newer than the board kept from the last visit opens it after the next read', async ({ page }) => {
  let machines: Fake[] = [{ machine: '', tasks: [{ id: 'demo/1', title: 'Older one' }] }]
  await fakeBoard(page, () => machines, 800)
  await page.goto('/#/board')
  await expect(page.locator('.task-card', { hasText: 'Older one' })).toBeVisible({ timeout: 15000 })
  // Elsewhere in the app; the task is added meanwhile; its push is tapped.
  await page.evaluate(() => { location.hash = '#/' })
  await expect(page.locator('.board-view')).toHaveCount(0)
  machines = [{ machine: '', tasks: [{ id: 'demo/9', title: 'Brand new' }, { id: 'demo/1', title: 'Older one' }] }]
  await page.evaluate(() => { location.hash = '#/board?machine=&task=demo%2F9' })
  await expect(page.locator('.board-panel')).toContainText('Brand new', { timeout: 15000 })
  await expect(page.locator('.hw-toast-title', { hasText: 'That task is no longer on the Board' })).toHaveCount(0)
})

test('a first message to a coordinator stays with it while its machine is away, and is sent there once it is back', async ({ page }) => {
  let machines: Fake[] = [{ machine: 'ma', tasks: [{ id: 'demo/1', title: 'On A' }] }, { machine: 'mb', tasks: [{ id: 'web/2', title: 'On B' }] }]
  await fakeBoard(page, () => machines)
  const sent: unknown[] = []
  await page.route(url => new URL(url).pathname === '/api/tasks/coordinator', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { pane: null, state: 'none' } })
    sent.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true, msg: 'sent' } })
  })
  await page.goto('/#/board')
  await page.locator('.board-machine[data-machine="ma"] .board-repo[data-repo="demo"] .board-coord').click({ timeout: 15000 })
  const panel = page.locator('.board-panel')
  const text = panel.locator('#board-panel-first')
  await text.fill('Draft for demo on A')
  const send = panel.getByRole('button', { name: 'Send', exact: true })
  // Machine A stops answering: the panel keeps its target and its words, and sends nothing.
  machines = [{ machine: 'ma', status: 'error', error: 'No answer', tasks: [] }, machines[1]!]
  await page.locator('.board-filter').dispatchEvent('click') // under the panel on a phone
  await expect(panel.locator('.board-panel-away')).toBeVisible({ timeout: 15000 })
  await expect(panel.locator('.board-panel-name')).toHaveText('demo coordinator')
  await expect(text).toHaveValue('Draft for demo on A')
  await expect(send).toBeDisabled()
  // Back: still A's demo coordinator.
  machines = [{ machine: 'ma', tasks: [{ id: 'demo/1', title: 'On A' }] }, machines[1]!]
  await page.locator('.board-filter').dispatchEvent('click') // under the panel on a phone
  await expect(panel.locator('.board-panel-away')).toHaveCount(0, { timeout: 15000 })
  await send.click()
  await expect.poll(() => sent).toEqual([{ machine: 'ma', text: 'Draft for demo on A', to: { kind: 'project', repo: 'demo' } }])
})

test('the same task id on another machine: its sheet starts empty, with that machine\'s details', async ({ page }) => {
  const machines: Fake[] = [{ machine: 'ma', tasks: [{ id: 'demo/1', title: 'On machine A' }] }, { machine: 'mb', tasks: [{ id: 'demo/1', title: 'On machine B' }] }]
  await fakeBoard(page, () => machines)
  const asked: string[] = []
  await page.route(url => new URL(url).pathname === '/api/tasks/details', async (route) => {
    const q = new URL(route.request().url()).searchParams
    asked.push(q.get('machine')!)
    await route.fulfill({ json: { id: q.get('id'), title: '', stage: 'asks', msg: '', description: `Details of ${q.get('machine')}`, agent: 'claude', pr: '', branch: '', worktree: '', failure: '', failureStage: '', failureAuth: false, summary: '', report: null, review: null, reviewRounds: 0, plan: '', research: false, pane: null } })
  })
  await page.goto('/#/board')
  // A's task (no pane for its agent here: its sheet).
  await page.locator('.board-machine[data-machine="ma"] .task-card').click({ timeout: 15000 })
  await page.locator('.board-panel-sheet').click()
  const sheet = page.getByRole('dialog')
  await expect(sheet.locator('.task-sheet-text')).toHaveText('Details of ma')
  // A push opens B's task with the same id while A's sheet is open.
  await page.evaluate(() => { location.hash = '#/board?machine=mb&task=demo%2F1' })
  await expect(sheet.locator('.task-sheet-text')).toHaveText('Details of mb', { timeout: 15000 })
  await expect(sheet).toContainText('On machine B')
  await expect(sheet).not.toContainText('Details of ma')
  expect(asked.at(-1)).toBe('mb')
  await expect(sheet.getByRole('textbox')).toHaveCount(0)
})

test('a reply for the coordinator shown before never lands on the one shown now', async ({ page }, testInfo) => {
  const phone = testInfo.project.name.includes('phone')
  await fakeBoard(page, () => [{ machine: '', tasks: [{ id: 'demo/1', title: 'In demo' }, { id: 'web/2', title: 'In web' }] }])
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  const sent: { to: { repo?: string } }[] = []
  await page.route(url => new URL(url).pathname === '/api/tasks/coordinator', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { pane: null, state: 'none' } })
    const body = route.request().postDataJSON()
    sent.push(body)
    if (body.to.repo === 'demo') await held
    await route.fulfill({ json: { ok: true, msg: 'sent' } })
  })
  await page.goto('/#/board')
  const panel = page.locator('.board-panel')
  await page.getByRole('button', { name: 'demo coordinator' }).click({ timeout: 15000 })
  await panel.locator('#board-panel-first').fill('For demo')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => sent.length).toBe(1)
  // demo's reply is still on its way: web's coordinator is shown, and written to.
  if (phone) await closePanel(page, phone)
  await page.getByRole('button', { name: 'web coordinator' }).click()
  await expect(panel.locator('.board-panel-name')).toHaveText('web coordinator')
  await panel.locator('#board-panel-first').fill('Draft for web')
  release()
  await page.waitForTimeout(500)
  await expect(panel.locator('#board-panel-first')).toHaveValue('Draft for web')
  await expect(panel).not.toContainText('its conversation opens here')
  await expect(panel.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  expect(sent.map(b => b.to.repo)).toEqual(['demo'])
})

test('a coordinator herdr-projects could not start says why, and Try again starts it again', async ({ page }, testInfo) => {
  await fakeBoard(page, () => [{ machine: '', tasks: [{ id: 'demo/1', title: 'In demo' }] }])
  // herdr-projects 1.2.1 after a failed start: still "starting" while the words wait, with the error kept.
  const error = '"claude" is not installed here, so it cannot be the Coordinator.'
  let status: Record<string, unknown> = { pane: null, state: 'none', error: '', name: 'Coordinator' }
  const sent: unknown[] = []
  await page.route(url => new URL(url).pathname === '/api/tasks/coordinator', async (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: status })
    const body = route.request().postDataJSON()
    sent.push(body)
    status = body.restart ? { pane: null, state: 'starting', error: '', name: 'Coordinator' } : { pane: null, state: 'starting', error, name: 'Coordinator' }
    await route.fulfill({ json: { ok: true, msg: 'sent' } })
  })
  await page.goto('/#/board')
  await page.locator('.board-top').getByRole('button', { name: 'Coordinator', exact: true }).click({ timeout: 15000 })
  const panel = page.locator('.board-panel')
  await expect(panel.locator('.board-panel-name')).toHaveText('Coordinator')
  await panel.locator('#board-panel-first').fill('Add a dark mode toggle')
  await panel.getByRole('button', { name: 'Send', exact: true }).click()
  // The next lookup has the failure: its reason, never "starting".
  const failed = panel.locator('.board-panel-failed')
  await expect(failed).toBeVisible({ timeout: 15000 })
  await expect(failed).toContainText('Could not start')
  await expect(failed.locator('.board-panel-failed-why')).toHaveText(error)
  await expect(panel).not.toContainText('is starting')
  await expect(panel).not.toContainText('Coordinator coordinator')
  await page.screenshot({ path: `.shots/board-coord-failed-${testInfo.project.name}.png` })
  // Fixed on the machine: Try again starts it again, with nothing typed.
  await failed.getByRole('button', { name: 'Try again' }).click()
  await expect.poll(() => sent.at(-1)).toEqual({ machine: '', to: { kind: 'main' }, restart: true })
  await expect(panel.locator('.board-panel-starting')).toHaveText('Sent. The Coordinator is starting: its conversation opens here.')
  await expect(failed).toHaveCount(0)
})

test('Coordinator choices keep unavailable hosts visible and explain the three roles', async ({ page }, testInfo) => {
  let machines: Fake[] = [
    { machine: '', stale: true, error: 'Local read failed', tasks: [] },
    { machine: 'ma', status: 'error', error: 'SSH unavailable', tasks: [] },
    { machine: 'mb', tasks: [{ id: 'web/1', title: 'Example work' }] },
  ]
  await fakeBoard(page, () => machines)
  const requests: string[] = []
  await page.route(url => new URL(url).pathname === '/api/tasks/coordinator', route => {
    requests.push(new URL(route.request().url()).searchParams.get('machine') || '')
    return route.fulfill({ json: { pane: null, state: 'none' } })
  })
  await page.goto('/#/board')
  const top = page.locator('.board-top-coord')
  await expect(top).toHaveText('Coordinator')
  await expect(page.locator('.board-head.machine .board-coord')).toHaveText(['devbox coordinator', 'ma coordinator', 'mb coordinator'])
  await expect(page.getByRole('button', { name: 'ma coordinator', exact: true })).toBeDisabled()
  await expect(page.locator('.board-machine[data-machine="ma"] .board-machine-error')).toContainText('unreachable')
  await top.click()
  const choices = page.getByRole('menuitem')
  await expect(choices).toHaveCount(3)
  await expect(choices.nth(0)).toContainText('devbox')
  await expect(choices.nth(0)).toContainText('Local read failed')
  await expect(choices.nth(0)).toBeDisabled()
  await expect(choices.nth(1)).toContainText('SSH unavailable')
  await expect(choices.nth(1)).toBeDisabled()
  await page.screenshot({ path: `.shots/board-coordinator-choices-${testInfo.project.name}.png` })
  await choices.nth(2).click()
  const panel = page.locator('.board-panel')
  await expect(panel.locator('.board-panel-machine')).toHaveText('mb')
  await expect(panel.locator('.board-panel-purpose')).toContainText('All work')
  expect(requests).toEqual(['mb'])
  await closePanel(page, testInfo.project.name.includes('phone'))
  await page.getByRole('button', { name: 'mb coordinator', exact: true }).click()
  await expect(panel.locator('.board-panel-purpose')).toContainText('its tasks and agents')
  await expect(panel.locator('.board-panel-title')).toHaveText('mb coordinator')
  await page.screenshot({ path: `.shots/board-machine-coordinator-${testInfo.project.name}.png` })
  await closePanel(page, testInfo.project.name.includes('phone'))
  await page.getByRole('button', { name: 'web coordinator', exact: true }).click()
  await expect(panel.locator('.board-panel-purpose')).toContainText('this repo')
  await closePanel(page, testInfo.project.name.includes('phone'))
  machines = machines.map(m => ({ ...m, status: 'error', error: 'SSH unavailable' }))
  await page.locator('.board-filter').click()
  await expect(page.getByRole('status').filter({ hasText: 'No Coordinator can be reached' })).toBeVisible()
  await page.screenshot({ path: `.shots/board-no-coordinator-${testInfo.project.name}.png` })
  // A single host: the same name, even when it is unavailable.
  machines = [{ machine: 'mb', tasks: [] }]
  await page.locator('.board-filter').click()
  await expect(top).toHaveText('Coordinator')
  await top.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 100, clientY: 20 })
  await expect(page.locator('.coordinator-tooltip')).toBeVisible()
  await expect(page.locator('.coordinator-tooltip')).toContainText('All work')
  await top.dispatchEvent('pointerup', { pointerType: 'touch' })
  await top.dispatchEvent('click')
  await expect(panel).toHaveCount(0)
  await page.screenshot({ path: `.shots/board-coordinator-hint-${testInfo.project.name}.png` })
  machines = [{ machine: 'mb', status: 'error', error: 'SSH unavailable', tasks: [] }]
  await page.locator('.board-filter').click()
  await expect(top).toBeDisabled()
  await expect(top).toHaveText('Coordinator')
  // No horizontal overflow at the phone viewport.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.evaluate(() => localStorage.setItem('herdrLanguage', 'fr'))
  await page.reload()
  await expect(top).toHaveText('Coordinateur')
  await expect(page.getByRole('status').filter({ hasText: 'Aucun Coordinateur' })).toBeVisible()
  await page.screenshot({ path: `.shots/board-no-coordinator-fr-${testInfo.project.name}.png` })
  machines = [{ machine: 'long-example-workstation-name', tasks: [] }]
  await page.locator('.board-filter').click()
  await expect(top).toHaveText('Coordinateur')
  expect(await top.evaluate(el => el.scrollHeight <= el.clientHeight)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: `.shots/board-coordinator-long-host-${testInfo.project.name}.png` })
})

for (const lang of ['en', 'fr']) {
  test(`coordinator failure distinguishes delivery and queue counts (${lang})`, async ({ page }, testInfo) => {
    await fakeBoard(page, () => [{ machine: '', tasks: [] }])
    await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), lang)
    let status: Record<string, unknown> = {}
    await page.route(url => new URL(url).pathname === '/api/tasks/coordinator', route => route.fulfill({ json: status }))
    for (const delivery of [false, true]) {
      for (const queued of [0, 1, 3]) {
        status = { pane: null, state: 'exited', queued, error: delivery ? 'your message sits unsent in its box. Go into it and press enter.' : 'The agent could not be started.' }
        await page.goto('/#/board')
        await page.locator('.board-top-coord').click()
        const failed = page.locator('.board-panel-failed')
        await expect(failed).toBeVisible()
        await expect(failed.locator('h4')).toHaveText(delivery
          ? lang === 'fr' ? 'Envoi du message impossible' : 'Message could not be sent'
          : lang === 'fr' ? 'Démarrage impossible' : 'Could not start')
        await expect(failed.locator('.board-panel-failed-why')).toHaveText(String(status.error))
        if (delivery) {
          await expect(failed.locator('.board-panel-failed-what')).toContainText(lang === 'fr' ? 'n’a pas été envoyé' : 'was not sent')
          await expect(failed).not.toContainText(lang === 'fr' ? 'n’a pas pu être saisi' : 'could not be typed')
        }
        await expect(failed.locator('.board-panel-failed-next')).toContainText(queued
          ? lang === 'fr' ? `${queued} message${queued === 1 ? '' : 's'} attend` : `${queued} message${queued === 1 ? '' : 's'} still waiting`
          : lang === 'fr' ? 'Aucun message en attente.' : 'No message is waiting.')
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
        await page.screenshot({ path: `.shots/coordinator-${lang}-${delivery ? 'delivery' : 'start'}-${queued}-${testInfo.project.name}.png` })
        await page.locator('.board-panel-back, .board-panel-close').click()
      }
    }
  })
}

for (const lang of ['en', 'fr']) {
  test(`task panel setup failure and task tab (${lang})`, async ({ page }, testInfo) => {
    await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), lang)
    const task = { id: 'demo/9', title: 'Improve search results', stage: 'failed', state: 'error', app: 'claude', msg: 'Setup failed' }
    const failure = { stage: 'setup', title: 'Setup failed', detail: 'npm ci\nENOENT: package-lock.json is missing', next: 'Restore the lockfile, then start again.', auth: false, agentCanFix: false }
    fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([task]))
    fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: { ...task, description: 'Search supports titles and labels.' }, failure, report: { file: 'report.md' }, limits: { time: { limit: '2h', used: '3m' }, tokens: { limit: '30m', total: 41088783 } } }))
    const dir = path.join(home, '.herdr-projects/data/tasks/demo/9')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ ...task, link: { pane: CLAUDE_PANE }, summary: 'Search checked with fictional data.' }))
    await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
    await page.goto('/#/board?machine=&task=demo%2F9')
    const panel = page.locator('.board-panel')
    await expect(panel.locator('.task-needs')).toContainText('package-lock.json is missing')
    await expect(panel.locator('.task-needs')).toContainText('Restore the lockfile')
    await expect(panel.locator('.agent-top')).toHaveCount(0)
    // A stale agent link must not make setup failure open a conversation.
    await expect(panel.locator('.board-panel-tabs button')).toHaveText([lang === 'fr' ? 'Tâche' : 'Task', 'Agent', lang === 'fr' ? 'Réglages' : 'Settings'])
    await expect(panel.locator('.board-panel-name .task-state')).toHaveText(lang === 'fr' ? 'À toi' : 'Needs you')
    await page.screenshot({ path: `.shots/task-panel-${lang}-setup-${testInfo.project.name}.png` })
    await panel.locator('.task-needs').getByRole('button', { name: lang === 'fr' ? 'Ouvrir le terminal' : 'Open terminal', exact: true }).click()
    await expect(panel.locator('#term')).toBeVisible()
    // WHR-62: the banner never offers the tab already shown. From the
    // terminal it leads to the conversation, where the answer goes.
    const needsBanner = panel.locator('.task-needs')
    const openTerm = needsBanner.getByRole('button', { name: lang === 'fr' ? 'Ouvrir le terminal' : 'Open terminal', exact: true })
    const answer = needsBanner.getByRole('button', { name: lang === 'fr' ? 'Répondre dans la conversation' : 'Answer in the conversation', exact: true })
    await expect(openTerm).toHaveCount(0)
    await page.screenshot({ path: `.shots/needs-${lang}-term-${testInfo.project.name}.png` })
    const phoneSize = page.viewportSize()!
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/needs-${lang}-term-desktop.png` })
    await page.setViewportSize(phoneSize)
    await answer.click()
    await expect(panel.locator('.board-panel-tabs').getByRole('button', { name: 'Agent', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.locator('.task-setup')).toBeVisible()
    await expect(answer).toHaveCount(0)
    await expect(openTerm).toBeVisible()
    await panel.locator('.board-panel-tabs').getByRole('button', { name: lang === 'fr' ? 'Tâche' : 'Task', exact: true }).click()
    await expect(panel.locator('.task-sheet')).toContainText('Search supports titles and labels.')
    await expect(openTerm).toBeVisible()
    await expect(panel.locator('.board-panel-note')).toContainText('Search checked with fictional data.')
    // The limits as gauges: this run's time, the task's tokens (red past 90 %).
    await expect(panel.locator('.task-limit[data-kind="time"] .task-limit-value')).toHaveText('3 min / 2 h')
    await expect(panel.locator('.task-limit[data-kind="tokens"]')).toHaveClass(/hot/)
    const counts = panel.locator('.token-count button')
    await expect(counts).toHaveText([lang === 'fr' ? '41,1 M' : '41.1 M', '30 M'])
    await expect(counts.first()).toHaveAttribute('title', '41088783')
    await counts.first().click()
    await expect(panel.locator('.token-count-exact')).toHaveText('(41088783)')
    await counts.first().click()
    await expect(panel.locator('.token-count-exact')).toHaveCount(0)
    await counts.nth(1).focus()
    await page.keyboard.press('Enter')
    await expect(panel.locator('.token-count-exact')).toHaveText('(30000000)')
    await counts.nth(1).click()
    await page.screenshot({ path: `.shots/tokens-${lang}-phone.png` })
    const phone = page.viewportSize()!
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.screenshot({ path: `.shots/tokens-${lang}-desktop.png` })
    await page.setViewportSize(phone)
    await expect(panel.locator('.board-panel-report')).toContainText(lang === 'fr' ? 'Rapport' : 'Report')
    await expect(panel.locator('.board-panel-report')).not.toContainText(lang === 'fr' ? 'recherche' : 'Research')
    await page.screenshot({ path: `.shots/task-panel-${lang}-details-${testInfo.project.name}.png` })
    await panel.locator('.task-needs').getByRole('button', { name: lang === 'fr' ? 'Relancer' : 'Start again', exact: true }).click()
    await expect.poll(callLog).toContain('delegate -- demo/9')
    // No pane at all: the panel opens straight on the task (no sheet), its
    // Conversation and Terminal tabs hidden, the failure in its banner.
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ ...task, summary: 'Search checked with fictional data.' }))
    await page.reload()
    await page.goto('/#/board?machine=&task=demo%2F9')
    await expect(panel.locator('.task-sheet')).toContainText('Search supports titles and labels.')
    await expect(panel.locator('.board-panel-tabs button')).toHaveText([lang === 'fr' ? 'Tâche' : 'Task', lang === 'fr' ? 'Réglages' : 'Settings'])
    await expect(panel.locator('.task-setup')).toHaveCount(0)
    await expect(panel.locator('.task-needs')).toContainText('npm ci')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.screenshot({ path: `.shots/task-panel-${lang}-no-agent-${testInfo.project.name}.png` })
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

// WHR-38: a review that failed the day before, then a run stopped at its limit.
// The banner says the limit, not the old failure; Finish takes the work as it is.
for (const lang of ['en', 'fr']) {
  test(`a stale failure is history; Finish on a limit stop (${lang})`, async ({ page }, testInfo) => {
    await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), lang)
    const at = Date.now() - 86_400_000
    const task = { id: 'demo/11', title: 'Group projects by coordinator', stage: 'stopped', state: 'blocked', app: 'claude', msg: 'Stopped at its 2h limit' }
    const failure = { stage: 'review', title: 'Review failed', detail: 'The reviewer finished without a verdict.', next: 'Finish again for a fresh review.', auth: false, agentCanFix: true, at }
    fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([task]))
    fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: { ...task, description: 'Projects sit under their coordinator.' }, failure, limits: { time: { limit: '2h', used: '2h' }, tokens: { limit: 'none', total: 0 } } }))
    const dir = path.join(home, '.herdr-projects/data/tasks/demo/11')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'task.json'), JSON.stringify({ ...task, at: at + 3_600_000, armedAt: at + 60_000, failure }))
    await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
    const banner = page.locator('.board-panel .task-needs')
    // The board's list of the test before may still be kept a few seconds.
    await expect(async () => {
      await page.goto('/#/board?machine=&task=demo%2F11')
      await expect(banner).toBeVisible({ timeout: 2000 })
    }).toPass({ timeout: 20_000 })
    await expect(banner.locator('h3')).toHaveText(`${lang === 'fr' ? 'À toi' : 'Needs you'} · Stopped at its 2h limit`)
    await expect(banner).not.toContainText('Review failed')
    await expect(banner.getByRole('button', { name: lang === 'fr' ? 'Envoyer l’erreur à l’agent' : 'Send the error to the agent' })).toHaveCount(0)
    await expect(banner.locator('.task-finish-why')).toContainText(lang === 'fr' ? 'nouvelle tranche' : 'new allowance')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `.shots/task-finish-${lang}-${testInfo.project.name}.png` })
    // The old failure stays in the Task tab, as history.
    await page.locator('.board-panel-tabs').getByRole('button', { name: lang === 'fr' ? 'Tâche' : 'Task', exact: true }).click()
    await expect(page.locator('.board-panel .task-sheet-earlier')).toContainText('Review failed')
    await page.screenshot({ path: `.shots/task-finish-${lang}-earlier-${testInfo.project.name}.png` })
    await banner.getByRole('button', { name: lang === 'fr' ? 'Prendre tel quel' : 'Take as is', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText('merge.by itself')
    await page.screenshot({ path: `.shots/task-finish-${lang}-confirm-${testInfo.project.name}.png` })
    await dialog.getByRole('button', { name: lang === 'fr' ? 'Terminer' : 'Finish', exact: true }).click()
    await expect.poll(callLog).toContain('finish -- demo/11')
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

// WHR-50: every slot taken, Start says Queue and the place; Start after… waits
// for other tasks (delegate --after), and a task that waits or is queued says so.
for (const lang of ['en', 'fr']) {
  test(`Queue, Start after… and a task that waits (${lang})`, async ({ page }, testInfo) => {
    test.setTimeout(60000)
    const fr = lang === 'fr'
    await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), lang)
    fs.writeFileSync(path.join(root, 'list.json'), JSON.stringify([
      { id: 'demo/5', state: 'idle', title: 'In the backlog', stage: 'todo' },
      { id: 'demo/3', state: 'working', app: 'codex', title: 'Add dark mode toggle', stage: 'working', progress: 40 },
      { id: 'demo/8', state: 'working', app: 'claude', title: 'Search page', stage: 'reviewing', msg: 'Under review' },
      { id: 'demo/9', state: 'working', title: 'Footer links', stage: 'queued', msg: 'Waiting for a free slot', queue: 1 },
      { id: 'demo/10', state: 'working', title: 'Release notes', stage: 'after', msg: 'queued after DEMO-3' },
    ]))
    // Two agents at once (board.agents), both taken.
    fs.writeFileSync(path.join(root, 'show.json'), JSON.stringify({ settings: [
      { name: 'worker.agent', kind: 'work', value: 'claude', from: 'your entry for demo', place: 'repo', own: false, note: '' },
      { name: 'board.agents', kind: 'board', value: 2, from: 'you', place: 'you', own: false, note: '' },
    ], problems: [] }))
    const details = (id: string, title: string, stage: string, extra: Record<string, unknown> = {}) =>
      fs.writeFileSync(path.join(root, 'details.json'), JSON.stringify({ task: { id, title, stage, description: 'Steps in the description.' }, ...extra }))
    details('demo/5', 'In the backlog', 'todo')
    await fakeHerdr('e2e.plugins', { plugins: [manifest('1.2.1')] })
    const panel = page.locator('.board-panel')
    const queue = panel.getByRole('button', { name: fr ? 'Mettre en file' : 'Queue', exact: true })
    // The board's list of the test before may still be kept a few seconds.
    await expect(async () => {
      await page.goto('/#/board?machine=&task=demo%2F5')
      await expect(queue).toBeVisible({ timeout: 3000 })
    }).toPass({ timeout: 20_000 })
    await expect(panel.locator('.task-queue-place')).toHaveText(fr ? '2e dans la file · les 2 places sont prises' : '2nd in the queue · all 2 slots are taken')
    // Start after…: the tasks of the board, found by title.
    await panel.getByRole('button', { name: fr ? 'Démarrer après…' : 'Start after…', exact: true }).click()
    const pick = panel.locator('.task-after-pick')
    await expect(pick.locator('.task-after-choice')).toHaveCount(4)
    await pick.getByRole('textbox').fill('dark')
    await expect(pick.locator('.task-after-choice')).toHaveCount(1)
    await pick.locator('.task-after-choice', { hasText: 'DEMO-3' }).click()
    await expect(pick.locator('.task-wait-chip')).toHaveText('DEMO-3')
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `.shots/task-after-${lang}-pick-${testInfo.project.name}.png` })
    // The board refuses (a wait in a circle): its words, as they are.
    const circle = 'DEMO-5 cannot wait for that: tasks would wait on each other (DEMO-5 → DEMO-3 → DEMO-5). Nothing was changed.'
    fs.writeFileSync(path.join(root, 'refuse'), `${circle}\n`)
    const go = pick.getByRole('button', { name: fr ? 'Démarrer après DEMO-3' : 'Start after DEMO-3', exact: true })
    await go.click()
    await expect(panel.locator('.task-sheet-error')).toHaveText(circle)
    fs.rmSync(path.join(root, 'refuse'))
    await go.click()
    await expect.poll(callLog).toContain('delegate --after=DEMO-3 -- demo/5')

    // A task that waits: for what, and Stop waiting.
    details('demo/10', 'Release notes', 'after', { after: { waitsFor: ['demo/3', 'demo/8'], waiting: true, left: ['demo/3'], waitsForYou: null, tasks: [{ id: 'demo/3', title: 'Add dark mode toggle', done: false }] } })
    await page.goto('/#/board?machine=&task=demo%2F10')
    const wait = panel.locator('.task-wait')
    await expect(wait).toContainText(fr ? 'Attend' : 'Waits for')
    await expect(wait.locator('.task-wait-chip').first()).toHaveText('DEMO-3')
    await expect(wait.locator('.task-wait-chip.done')).toContainText('DEMO-8')
    await page.screenshot({ path: `.shots/task-after-${lang}-waits-${testInfo.project.name}.png` })
    await wait.getByRole('button', { name: fr ? 'Ne plus attendre' : 'Stop waiting' }).click()
    await expect.poll(callLog).toContain('after --clear -- demo/10')

    // A task in the queue: its place.
    details('demo/9', 'Footer links', 'queued', { queue: { place: 1, words: 'waiting for a free slot, Q#1' } })
    await page.goto('/#/board?machine=&task=demo%2F9')
    await expect(panel.locator('.task-wait')).toContainText(fr ? 'Attend une place libre · 1re dans la file' : 'Waiting for a free slot · 1st in the queue')
    await page.screenshot({ path: `.shots/task-after-${lang}-queued-${testInfo.project.name}.png` })
  })
}
