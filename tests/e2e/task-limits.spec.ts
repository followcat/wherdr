// Task limits (herdr-projects 1.2.16+): the Task tab's gauges, and a task
// stopped at a limit raised with one preset (#167's sheet, #155's presets). The
// plugin's launcher is a fake that answers with `details --json` as 1.2.21
// writes it (limits/shown.rs) and writes down each call.
import { expect, test } from './test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fakeHerdr } from './scenario.mjs'
import { boardServes } from './waits'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-limits-'))
const calls = path.join(root, 'calls.log')
const keyReply = JSON.stringify({ settings: [{ name: 'repo.key', kind: 'repo', value: 'DEMO', from: 'your entry', place: 'you', own: false, note: '' }], problems: [] })
fs.mkdirSync(path.join(root, 'bin'))
// `set`: refused when the spec says so; else the board carries on by itself
// (after-set.json becomes the list, as its next tick would).
fs.writeFileSync(path.join(root, 'bin/run.sh'), `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
  list) if [ "$3" = --archived ]; then echo '[]'; else cat '${root}/list.json'; fi ;;
  details) cat '${root}/details.json' ;;
  version) echo 'herdr-projects 1.2.21 (/opt/herdr-projects/bin/herdr-projects-linux-x86_64)' ;;
  set) if [ -f '${root}/refuse' ]; then cat '${root}/refuse' >&2; exit 1; fi
    if [ -f '${root}/after-set.json' ]; then mv '${root}/after-set.json' '${root}/list.json'; fi
    if [ -f '${root}/after-set-details.json' ]; then mv '${root}/after-set-details.json' '${root}/details.json'; fi; echo "set" ;;
  retry|finish) echo "$3: done" ;;
  show) echo '${keyReply}' ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`, { mode: 0o755 })
const manifest = { plugin_id: 'herdr-projects', enabled: true, version: '1.2.21', plugin_root: root, startup: [{ command: ['sh', 'bin/run.sh', 'hook'] }], actions: [{ id: 'open', command: ['sh', 'bin/run.sh', 'open'] }] }
const callLog = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [])
const write = (name: string, v: unknown) => fs.writeFileSync(path.join(root, name), JSON.stringify(v))

const title = 'Tidy the search page'
const working = { id: 'demo/9', title, stage: 'working', state: 'working', app: 'claude', msg: 'Running the tests' }
const stopped = { ...working, stage: 'stopped', state: 'blocked', msg: 'stopped at its 2h limit' }
const limits = (extra: Record<string, unknown> = {}) => ({
  time: { limit: '2h' }, tokens: { limit: '30m', used: 3_400_000, total: 3_400_000 }, ...extra,
})

test.beforeEach(async () => {
  for (const f of ['refuse', 'after-set.json', 'after-set-details.json', 'calls.log']) fs.rmSync(path.join(root, f), { force: true })
  await fakeHerdr('e2e.plugins', { plugins: [manifest] })
})
test.afterEach(async () => { await fakeHerdr('e2e.plugins', { plugins: [] }) })
test.afterAll(() => { fs.rmSync(root, { recursive: true, force: true }) })

const shot = async (page: import('@playwright/test').Page, name: string) => {
  await page.screenshot({ path: `.shots/limits-${name}-phone.png` })
  const phone = page.viewportSize()!
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: `.shots/limits-${name}-desktop.png` })
  await page.setViewportSize(phone)
}

// One journey on one task, so the server's list (reused a few seconds,
// tests/e2e/waits.ts) is waited for once. It was three tests; what only they
// checked is now here or below it:
// - the refused raise (herdr-projects' words, as they are): in this journey;
// - its token presets (×2 → 60 M, +10 M → 40 M): tests/taskLimits.test.ts
//   ('tokens: ×2, +10 M, none…') and tests/components/TaskSheet.test.ts ('offers
//   disabled a preset that would not go above what was used');
// - the Task tab's gauges: at the end of this journey, and
//   tests/components/TaskSheet.test.ts ('shows each limit as a gauge…').
test.describe('English interface', () => {
  const lang = 'en'
  test(`a task stopped at its limit: a refused raise, then one tap; the Task tab's gauges (${lang})`, async ({ page }) => {
    await page.addInitScript(l => localStorage.setItem('herdrLanguage', l), lang)
    write('list.json', [stopped])
    write('details.json', { task: { ...stopped, description: 'Make the search page easier to scan.' }, limits: limits({ stopped: { what: 'time', limit: '2h', used: 7_200_000, role: 'worker', line: stopped.msg } }) })
    write('after-set.json', [working])
    write('after-set-details.json', { task: { ...working, description: 'Make the search page easier to scan.' }, limits: limits({ time: { limit: '3h', used: '2m38s', usedMs: 158_000 } }) })
    // The list of the test before (another spec's) may be reused a few seconds.
    await boardServes(page, rows => rows.some(r => r.id === stopped.id && r.stage === 'stopped'))
    await page.goto('/#/board?machine=&task=demo%2F9')
    const banner = page.locator('.task-needs')
    await expect(banner).toContainText('stopped at its 2h limit')
    await shot(page, `stopped-${lang}`)
    // The hint names the limit Continue grants once more.
    await expect(banner.locator('.task-finish-why')).toContainText('new allowance (2 h a run)')
    await banner.getByRole('button', { name: 'Raise limit', exact: true }).click()
    const presets = page.locator('.raise-limit-presets button')
    await expect(presets).toHaveText(['+1 h3 h', '×24 h', 'No limit'])
    await shot(page, `raise-${lang}`)
    // Refused: herdr-projects' words, as they are.
    fs.writeFileSync(path.join(root, 'refuse'), 'demo/9 is busy. Try again in a moment.\n')
    await presets.first().click()
    await expect(page.getByRole('alert').filter({ hasText: 'busy' })).toHaveText('demo/9 is busy. Try again in a moment.')
    expect(callLog().filter(c => c === 'set limit.time 3h --task demo/9')).toHaveLength(1)
    // Then accepted. Only set: herdr-projects carries on by itself, so no retry follows.
    fs.rmSync(path.join(root, 'refuse'))
    await presets.first().click()
    await expect.poll(() => callLog().filter(c => c === 'set limit.time 3h --task demo/9'), { intervals: [100] }).toHaveLength(2)
    expect(callLog().some(c => c.startsWith('retry'))).toBe(false)
    await expect(banner).toHaveCount(0)
    expect(callLog().some(c => c.startsWith('retry'))).toBe(false)

    // Working again: the Task tab shows a gauge per limit.
    const panel = page.locator('.board-panel')
    await panel.locator('.board-panel-tabs').getByRole('button', { name: 'Task', exact: true }).click()
    await expect(panel.locator('.task-limit')).toHaveCount(2)
    await shot(page, `gauges-${lang}`)
    await expect(panel.locator('.task-limit[data-kind="time"] .task-limit-label')).toHaveText('Time · this run')
    await expect(panel.locator('.task-limit[data-kind="time"] .task-limit-value')).toHaveText('2 min 38 / 3 h')
    await expect(panel.locator('.task-limit[data-kind="tokens"] .task-limit-value')).toHaveText('3.4 M / 30 M')
    await expect(panel.locator('.task-limit.hot')).toHaveCount(0)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  })
})
