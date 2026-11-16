#!/usr/bin/env node
/** Reuse the launch film's real captures and stage; update only the README WebP. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { serveDemo } from '../launch-video/serve.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stage = join(root, 'tools/launch-video');
const generated = join(stage, '.generated');
const frames = await mkdtemp(join(tmpdir(), 'readme-animation-'));
const fps = 15;
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });
// capture.mjs verifies the app against this revision before driving its real controls.
if (!process.argv.includes('--reuse-captures'))
  run(process.execPath, [join(stage, 'capture.mjs')]);
const capture = JSON.parse(await readFile(join(generated, 'capture.json'), 'utf8'));
assert.equal(capture.uiChanges, false);
assert.equal(capture.overlaysInsideApp, false);
for (const shot of capture.shots) {
  const bytes = await readFile(join(generated, shot.file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.sha256, shot.file);
}
await copyFile(join(root, 'server/assets/branding/icons/icon-512.png'), join(generated, 'logo.png'));
const server = await serveDemo(stage);
let browser, total;
try {
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 720, height: 720 }, deviceScaleFactor: 1,
    locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block',
  });
  const origin = new URL(server.url).origin;
  await context.route('**/*', route =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  console.log('Loading the launch stage');
  await page.goto(server.url);
  console.log('Waiting for local fonts and captures');
  await page.waitForFunction(() => document.fonts.status === 'loaded' &&
    [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await page.evaluate(() => { document.body.style.zoom = '0.6666666667'; });
  // The stage's own length (data-duration), sampled at 15 fps.
  total = Math.round(fps * await page.evaluate(() => Number(document.getElementById('film').dataset.duration)));
  console.log(`Rendering ${total} README frames`);
  for (let frame = 0; frame < total; frame++) {
    await page.evaluate(time => { window.__timelines.wherdr.seek(time); }, frame / fps);
    await page.screenshot({ path: join(frames, `${String(frame).padStart(3, '0')}.png`) });
    if (frame % 60 === 0) console.log(`Rendered frame ${frame + 1}/${total}`);
  }
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  if (browser) await browser.close();
  await server.close();
}
const output = join(root, 'assets/wherdr-readme.webp');
run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-framerate', String(fps), '-i', join(frames, '%03d.png'), '-an',
  '-c:v', 'libwebp_anim', '-quality', '80', '-compression_level', '4',
  '-loop', '0', '-threads', '2', output]);
await rm(frames, { recursive: true, force: true });
// Read RIFF chunks: ffprobe does not reliably report animated WebP duration.
const bytes = await readFile(output);
assert.equal(bytes.toString('ascii', 8, 12), 'WEBP');
let count = 0, duration = 0, loop = false;
for (let offset = 12; offset + 8 <= bytes.length;) {
  const tag = bytes.toString('ascii', offset, offset + 4);
  const size = bytes.readUInt32LE(offset + 4), start = offset + 8;
  if (tag === 'VP8X') {
    assert.equal(bytes.readUIntLE(start + 4, 3) + 1, 720);
    assert.equal(bytes.readUIntLE(start + 7, 3) + 1, 720);
  }
  if (tag === 'ANIM') loop = bytes.readUInt16LE(start + 4) === 0;
  if (tag === 'ANMF') { count++; duration += bytes.readUIntLE(start + 12, 3); }
  offset = start + size + size % 2;
}
assert.ok(loop && count > 100 && Math.abs(duration - (total / fps) * 1000) < 100);
assert.ok(bytes.length < 5 * 1024 * 1024);
await writeFile(join(root, 'assets/wherdr-readme.json'), JSON.stringify({
  source: capture.source, commit: capture.mainCommit, appTree: capture.appTree,
  shots: capture.shots.map(({ file, action, route, viewport }) => ({ file, action, route, viewport })), width: 720, height: 720, frames: count,
  durationMs: duration, bytes: bytes.length, loop: 'infinite',
}, null, 2) + '\n');
console.log(`README WebP: 720×720, ${count} frames, ${duration} ms, ${bytes.length} bytes`);
