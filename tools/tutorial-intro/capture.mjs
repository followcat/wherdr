// Real UI, with the existing app/demo transport; no writes reach Herdr.
import assert from 'node:assert/strict';
import { chromium, devices } from 'playwright';
import { build } from 'esbuild';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const output = process.env.TUTORIAL_OUT, url = process.env.TUTORIAL_URL;
const repo = fileURLToPath(new URL('../..', import.meta.url));
assert.ok(output); assert.match(url, /^http:\/\/127\.0\.0\.1:769[0-9]$/);
const state = await (await fetch(`${url}/api/state`)).json();
assert.equal(state.ok, true); assert.match(state.session, /^hwtest/);
await mkdir(output, { recursive: true });
// Reuse the reviewed, fictional conversations and terminal instead of maintaining
// a second product simulation. Add two fictional machine labels for this overview.
const bundle = await build({ stdin: { contents: `
import { installDemoNetwork } from './app/demo/shim';
import { DemoServer } from './app/demo/server';
const server = new DemoServer();
const machines = [
  { key: '', label: 'Demo laptop', local: true, status: 'online', error: null },
  { key: 'demo-server', label: 'Demo server', local: false, status: 'online', error: null }
];
const originalState = server.state.bind(server);
server.state = () => ({ ...originalState(), machines });
const handle = server.handle.bind(server);
server.handle = (method, path, body) => {
  const result = handle(method, path, body);
  if (path === '/api/config') Object.assign(result.body, {
    hostLabel: 'Demo laptop', machines: machines.map(m => ({ ...m,
      home: '/Users/demo', dirs: [], online: true, kinds: ['claude', 'codex', 'omp'] }))
  });
  return result;
};
installDemoNetwork('/', server);
`, resolveDir: repo }, bundle: true, plugins: [{ name: 'tutorial-footer', setup(b) {
  // The demo terminal footer says "demo — nothing runs"; the film shows only the model.
  b.onLoad({ filter: /app[\\/]demo[\\/]terminal\.ts$/ }, async args => {
    const source = await readFile(args.path, 'utf8');
    assert.ok(source.includes(' · demo — nothing runs'));
    // Expose the last drawn screen: xterm paints on a canvas, with no text to wait on.
    const marker = '  // The cursor waits in the input field';
    assert.ok(source.includes(marker));
    return { contents: source.replace(' · demo — nothing runs', '')
      .replace(marker, '  ;(globalThis as any).__tutorialScreen = { text: plain(screen), rows }\n' + marker), loader: 'ts' };
  });
} }], write: false, format: 'iife', platform: 'browser' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.TUTORIAL_BROWSER });
const provenance = { appCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  session: state.session, source: 'Real wherdr UI; app/demo fictional transport; no backend writes', frames: [], actions: [] };
try {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2,
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', reducedMotion: 'reduce', serviceWorkers: 'block' });
  const protect = route => {
    const request = route.request(), target = new URL(request.url());
    return target.origin !== url || target.pathname.startsWith('/api/') || request.method() !== 'GET'
      ? route.abort() : route.continue();
  };
  await context.route('**/*', protect);
  await context.addInitScript({ content: bundle.outputFiles[0].text });
  // Headless WebGL draws the terminal at twice its cell size; use the app's HTML renderer.
  await context.addInitScript(() => localStorage.setItem('terminalRenderer', 'html'));
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.clock.install({ time: new Date('2026-01-01T09:41:00Z') });
  const capture = async (id, targets = {}, sourcePage = page) => {
    if (sourcePage === page) await page.mouse.move(1850, 1030);
    await sourcePage.evaluate(() => document.fonts.ready);
    await sourcePage.waitForTimeout(200);
    const boxes = {};
    for (const [name, locator] of Object.entries(targets)) {
      const box = await locator.first().boundingBox(); assert.ok(box, `Missing ${name}`); boxes[name] = box;
    }
    const image = await sourcePage.screenshot({ path: join(output, `${id}.png`), animations: 'disabled' });
    provenance.frames.push({ id, sha256: createHash('sha256').update(image).digest('hex'), targets: boxes });
  };
  await page.goto(url);
  await page.clock.runFor(2000);
  await page.locator('.card[data-pane]').first().waitFor();
  const agent = page.locator('.card[data-pane="w4:p1"]');
  await capture('agents', { agent, machines: page.locator('.machine-bar, .machines-bar, .machine-section-head').first(),
    stats: page.locator('.stats') });
  await agent.click();
  await page.clock.runFor(1500);
  await page.getByLabel('Open alone', { exact: true }).first().click();
  await page.clock.runFor(500);
  await page.locator('textarea').first().fill('Keep the existing layout. Add a regression test.');
  const send = page.getByRole('button', { name: 'Send', exact: true });
  await capture('conversation', { send });
  await send.click();
  await page.clock.runFor(6000);
  const terminal = page.getByRole('tab', { name: 'Terminal', exact: true });
  await capture('replied', { terminal });
  provenance.actions.push('Open agent; send fictional direction through the in-browser demo transport');
  await terminal.click();
  await page.locator('.xterm-screen').waitFor();
  // The demo redraws on the terminal's real size; wait for the conversation to show.
  const drawn = () => page.evaluate(() => globalThis.__tutorialScreen?.text || '');
  for (let i = 0; i < 40 && !(await drawn()).includes('regression test'); i++) {
    await page.clock.runFor(250); await page.waitForTimeout(100);
  }
  assert.match(await drawn(), /regression test/);
  await page.clock.runFor(500); await page.waitForTimeout(300);
  await capture('terminal');
  provenance.actions.push('Show fictional terminal through the existing demo WebSocket shim');
  const phoneContext = await browser.newContext({ ...devices['iPhone 13'], deviceScaleFactor: 2,
    locale: 'en-US', timezoneId: 'UTC', colorScheme: 'dark', serviceWorkers: 'block' });
  await phoneContext.route('**/*', protect);
  await phoneContext.addInitScript({ content: bundle.outputFiles[0].text });
  const phone = await phoneContext.newPage();
  await phone.goto(url);
  await phone.locator('.card[data-pane]').first().waitFor();
  await phone.evaluate(() => { location.hash = '#/a/w4:p1'; });
  await phone.waitForTimeout(2000);
  await phone.evaluate(() => document.fonts.ready);
  const phoneImage = await phone.screenshot({ animations: 'disabled' });
  await writeFile(join(output, 'phone-native.png'), phoneImage);
  const desktop = await readFile(join(output, 'conversation.png'));
  // A 16:9 comparison card, with an actual phone viewport beside the desktop.
  const comparison = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
  await comparison.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#12151b;color:#fff;font:22px sans-serif}
    .desk{position:absolute;left:50px;top:180px;width:1280px;border:1px solid #52606d}
    .phone{position:absolute;right:95px;top:70px;height:930px;border:7px solid #52606d;border-radius:40px}
    p{position:absolute;left:50px;top:95px;letter-spacing:3px}</style><p>DESKTOP + PHONE</p>
    <img class="desk" src="data:image/png;base64,${desktop.toString('base64')}">
    <img class="phone" src="data:image/png;base64,${phoneImage.toString('base64')}">`);
  await comparison.locator('img').evaluateAll(images => Promise.all(images.map(i => i.decode())));
  await capture('phone', { phone: comparison.locator('.phone') }, comparison);
  await comparison.close(); await phoneContext.close();
  await page.evaluate(() => { location.hash = '#/board'; });
  await page.clock.runFor(1500);
  await page.locator('.task-card').first().waitFor();
  await page.getByRole('button', { name: 'Collapse list', exact: true }).click();
  await page.getByRole('button', { name: 'Global', exact: true }).click();
  await capture('board', { task: page.locator('.task-card', { hasText: 'Fix the flaky CSV export test' }),
    review: page.locator('.task-card', { hasText: 'Per-key rate limits' }) });
  assert.deepEqual(errors, []);
  await writeFile(join(output, 'capture.json'), JSON.stringify(provenance, null, 2));
} finally { await browser.close(); }
