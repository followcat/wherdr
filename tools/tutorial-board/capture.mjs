// Capture the real UI; only the Board responses are fictional read-only fixtures.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const output = process.env.TUTORIAL_OUT;
const url = process.env.TUTORIAL_URL || 'http://127.0.0.1:7696';
assert.ok(output, 'Set TUTORIAL_OUT');
assert.match(url, /^http:\/\/127\.0\.0\.1:769[0-9]$/);
const state = await (await fetch(`${url}/api/state`)).json();
assert.equal(state.ok, true);
assert.match(state.session, /^hwtest/); // Never capture a default Herdr session.
const row = (n, title, group, extra = {}) => ({ id: `demo/${n}`, repo: 'demo', n, title, group,
  state: group === 'working' ? 'working' : group === 'todo' ? 'idle' : 'blocked',
  stage: group === 'needs' ? 'asks' : group === 'ready' ? 'approval' : group,
  kind: group === 'needs' ? 'question' : group === 'ready' ? 'permission' : '', app: 'claude', msg: '', ...extra });
const rows = [row(12, 'Make CSV exports predictable', 'needs', { msg: 'Should archived records be included?' }),
  row(11, 'Add webhook retries', 'ready', { pr: 'https://github.com/example/demo/pull/11', review: { pass: true, tally: 'All checks passed', by: 'claude' } }),
  row(13, 'Add API rate limits', 'working', { msg: 'Writing regression tests', progress: 65 }),
  row(14, 'Document the API', 'todo')];
const details = r => ({ ...r, agent: 'claude', pane: null, worktree: '', branch: '', archived: false,
  description: r.n === 12 ? 'Keep CSV columns in a consistent order. Add regression coverage for exported records.' : 'Retry temporary webhook failures with exponential backoff.',
  summary: r.n === 11 ? 'Retry handling is complete. Regression tests pass. Ready for your review.' : '',
  review: r.review || null, reviewRounds: r.n === 11 ? 1 : 0, report: null, failure: '', failureTitle: '', plan: '' });
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.TUTORIAL_BROWSER });
const provenance = { appCommit: process.env.TUTORIAL_SOURCE_REVISION || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), session: state.session, source: 'Real wherdr UI; fictional Board fixtures', frames: [], actions: [] };
try {
  // 1920×1080 CSS keeps the desktop Board on four columns beside an open task;
  // the 2× device scale gives the compositor sharp 3840×2160 sources.
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const request = route.request(), target = new URL(request.url());
    if (target.origin !== url || request.method() !== 'GET') return route.abort();
    if (target.pathname.startsWith('/api/tasks')) {
      let json = { machines: [], settings: [], problems: [] };
      if (target.pathname === '/api/tasks') json = { version: 'tutorial', machines: [{ machine: '', status: 'ready', version: '1.2.26', tasks: rows }] };
      if (target.pathname === '/api/tasks/details') json = details(rows.find(r => r.id === target.searchParams.get('id')) || rows[0]);
      if (target.pathname === '/api/tasks/coordinator') json = { state: 'none', pane: null };
      return route.fulfill({ json });
    }
    return route.continue();
  });
  const page = await context.newPage();
  // A target's box in CSS pixels. 'content' hugs the visible text and controls, so a
  // tutorial mark keeps an even margin around what it points at instead of the layout box.
  const measure = (locator, mode = 'box') => locator.first().evaluate((el, mode) => {
    const rects = [];
    if (mode === 'content') {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (walk.nextNode()) {
        if (!walk.currentNode.textContent.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(walk.currentNode);
        rects.push(...range.getClientRects());
      }
      for (const e of el.querySelectorAll('button, input, textarea, svg, img')) rects.push(e.getBoundingClientRect());
    }
    if (!rects.length) rects.push(el.getBoundingClientRect());
    const shown = rects.filter(r => r.width > 0 && r.height > 0);
    const x = Math.min(...shown.map(r => r.left)), y = Math.min(...shown.map(r => r.top));
    return { x, y, width: Math.max(...shown.map(r => r.right)) - x, height: Math.max(...shown.map(r => r.bottom)) - y };
  }, mode);
  const capture = async (id, targets = {}) => {
    await page.waitForTimeout(250);
    const image = await page.screenshot({ path: join(output, `${id}.png`) });
    const boxes = {};
    for (const [name, [locator, mode]] of Object.entries(targets)) boxes[name] = await measure(locator, mode);
    provenance.frames.push({ id, sha256: createHash('sha256').update(image).digest('hex'), targets: boxes });
  };
  const head = n => [page.locator('.board-col-head').nth(n).locator('span').first(), 'content'];
  const card = n => [page.locator(`.task-card[data-task="demo/${n}"]`), 'box'];
  const panelTab = name => [page.locator('.board-panel-tabs').getByRole('button', { name, exact: true }), 'box'];
  const fourColumns = async () => assert.equal(await page.locator('.board-col:visible').count(), 4);
  await page.goto(`${url}/#/board`);
  await page.locator('.task-card').first().waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole('button', { name: 'Collapse list', exact: true }).click();
  await page.getByRole('button', { name: 'Global', exact: true }).click();
  await capture('board', { needsHead: head(0), readyHead: head(1), workingHead: head(2), todoHead: head(3),
    needsCard: card(12), readyCard: card(11), workingCard: card(13), todoCard: card(14) });
  await page.locator('.task-card[data-task="demo/12"] .task-card-open').click({ position: { x: 12, y: 12 } });
  provenance.actions.push('Open needs-you task');
  await page.locator('.board-grid.desk').waitFor();
  await fourColumns();
  await capture('needs-open', { taskTab: panelTab('Task') });
  await page.locator('.board-panel-tabs').getByRole('button', { name: 'Task', exact: true }).click();
  await page.locator('.task-description').waitFor();
  await fourColumns();
  await capture('needs-task', { question: [page.locator('.task-sheet-msg'), 'content'],
    description: [page.locator('.task-description'), 'content'], close: [page.locator('.board-panel-close'), 'box'] });
  await page.locator('.board-panel-close').click();
  await page.mouse.move(700, 800); // no hover state left on the panel's neighbours
  await capture('board-after', { readyCard: card(11) });
  await page.locator('.task-card[data-task="demo/11"] .task-card-open').click({ position: { x: 12, y: 12 } });
  await page.locator('.board-panel-tabs').getByRole('button', { name: 'Task', exact: true }).click();
  await page.locator('.task-description').waitFor();
  await fourColumns();
  provenance.actions.push('Inspect ready-to-approve task context; no approval sent');
  await capture('ready-task', { facts: [page.locator('.task-sheet-facts'), 'box'],
    summary: [page.locator('.task-sheet-block.board-panel-note'), 'box'], close: [page.locator('.board-panel-close'), 'box'] });
  await page.locator('.board-panel-close').click();
  await page.mouse.move(700, 800);
  await capture('board-closed', { workingCard: card(13), todoCard: card(14), todoHead: head(3) });
  await writeFile(join(output, 'capture.json'), JSON.stringify(provenance, null, 2));
} finally { await browser.close(); }
