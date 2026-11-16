#!/usr/bin/env node
/**
 * Photograph the unmodified v3 demo build (app/demo, fictional data). Every
 * step uses the app's real controls in one live page and session; only the
 * demo strip at the top is hidden. Writes .generated/<shot>.png and
 * .generated/capture.json (actions, routes, viewports, SHA-256 of each PNG).
 */
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDemo } from "./serve.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const generated = join(here, ".generated");
const git = (args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
// The branch the film is made from: the app must match it exactly.
const base = process.env.WHERDR_FILM_BASE || "origin/v3";
git(["diff", "--exit-code", base, "--", "app", "nuxt.config.ts"]);
const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 844 };
const provenance = {
  source: "Unmodified wherdr v3 app, static app/demo build",
  base,
  mainCommit: git(["rev-parse", base]),
  appTree: git(["rev-parse", "HEAD:app"]),
  uiChanges: false,
  overlaysInsideApp: false,
  hidden: [".demo-banner"],
  shots: [],
};
await mkdir(generated, { recursive: true });
const server = await serveDemo(join(root, ".output-demo/public"));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: desktop,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: "dark",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const failures = [];
  const origin = new URL(server.url).origin;
  // Only the demo build itself: no network, no real API.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin && !/^\/(api|ws)\//.test(url.pathname))
      return route.continue();
    failures.push(url.pathname);
    await route.abort();
  });
  const page = await context.newPage();
  const device = await context.newCDPSession(page);
  page.on("pageerror", (error) => failures.push(error.message));
  await page.clock.install({ time: new Date("2026-01-01T09:41:00Z") });
  await page.goto(server.url);
  await page.locator(".card[data-pane]").first().waitFor();
  await page.addStyleTag({
    content:
      ".demo-banner { display: none !important } :root { --demo-h: 0px !important }",
  });
  await page.evaluate(() => document.fonts.ready);
  // From here the app's time moves only when the script says, so each shot
  // shows the state its action reached, not a later one.
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  const settle = async (ms = 1500) => {
    await page.clock.runFor(ms);
    await page.waitForTimeout(300);
  };
  const until = async (check, label) => {
    for (let tries = 0; tries < 40; tries++) {
      if (await check()) return;
      await settle(100);
    }
    await page.screenshot({ path: join(generated, "failure.png") });
    throw new Error(`The real UI did not reach: ${label}`);
  };
  const text = () => page.locator("body").innerText();
  async function shot(name, action, fn = async () => {}, wait = 1500) {
    await fn();
    await settle(wait);
    const file = `${name}.png`;
    const bytes = await page.screenshot({
      path: join(generated, file),
      type: "png",
      animations: "disabled",
    });
    provenance.shots.push({
      file,
      action,
      route: new URL(page.url()).hash || "#/",
      viewport: page.viewportSize(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    console.log(`Captured ${file} (${action})`);
  }

  await shot("home", "Open wherdr on a computer: Alfred, Tasks to review, coordinators", () =>
    until(async () => await page.getByTestId("review-open").isVisible(), "Tasks to review on Home"),
  );
  await shot("alfred", "Open Alfred: what needs me today", async () => {
    await page.getByTestId("alfred-open").click();
    await until(async () => (await text()).includes("What needs me today?"), "Alfred conversation");
  });
  await shot("coordinator", "Open the acme-api coordinator: it plans two tasks", async () => {
    await page.getByTestId("coordinator-row").filter({ hasText: "Ada" }).click();
    await until(async () => (await text()).includes("Two independent pieces of work"), "coordinator plan");
  });
  await shot("board", "Open the Board", async () => {
    await page.locator('[aria-label="Board"]').first().click();
    await until(async () => (await page.getByTestId("board-lane").count()) === 4, "four board columns");
  });
  await shot("review", "Open Tasks to review: WEB-7 and its screenshots", async () => {
    await page.locator('[aria-label="Back"]').first().click().catch(() => {});
    await page.evaluate(() => { location.hash = "#/"; });
    await settle();
    await page.getByTestId("review-open").click();
    await until(async () => (await page.locator('[data-testid="review-item"][data-task="WEB-7"]').count()) === 1, "WEB-7 in review");
  });
  await shot("approved", "Approve WEB-7 with the real Approve button", async () => {
    await page.getByTestId("review-approve").click();
    await until(async () => (await page.locator('[data-testid="review-approve"].confirmed').count()) === 1, "approved");
  }, 0);
  await shot("board-after", "Back to the Board: WEB-7 merged and Done", async () => {
    await page.keyboard.press("Escape");
    await settle(3000); // the demo engine merges 2.5 s after the approval
    await page.locator('[aria-label="Board"]').first().click();
    await until(async () => (await page.getByTestId("board-lane").allInnerTexts()).at(-1)?.includes("Dark mode toggle"), "WEB-7 in Done");
  });
  // The same live page, resized to a phone: no reload, no new session.
  await device.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await page.setViewportSize(phone);
  await shot("phone-home", "Continue on a phone: Tasks to review shows WEB-8", async () => {
    await page.evaluate(() => { location.hash = "#/"; });
    await until(async () => (await page.getByTestId("review-ids").allInnerTexts()).join().trim() === "WEB-8", "only WEB-8 left");
  });
  await shot("phone-question", "Open Tasks to review: the agent asks a question", async () => {
    await page.getByTestId("review-open").click();
    await until(async () => (await page.getByTestId("review-choice").count()) === 3, "three answers");
  });
  await shot("phone-answered", "Answer with one tap: Two months free", async () => {
    await page.locator('[data-choice="Two months free"]').click();
    await until(async () => (await page.locator('[data-choice="Two months free"].confirmed').count()) === 1, "answer sent");
  }, 0);
  assert.deepEqual(failures, [], "No external requests, real API calls or browser errors");
  await writeFile(join(generated, "capture.json"), JSON.stringify(provenance, null, 2) + "\n");
  await context.close();
} finally {
  if (browser) await browser.close();
  await server.close();
}
