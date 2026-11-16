#!/usr/bin/env node
/** Build the real demo captures, then animate them on the marketing stage. Run under nice/flock on shared hosts. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const assets = join(root, "assets");
const cli = join(here, "node_modules/.bin/hyperframes");
const stills = process.argv.includes("--stills");
const env = {
  ...process.env,
  HYPERFRAMES_NO_TELEMETRY: "1",
  HYPERFRAMES_NO_UPDATE_CHECK: "1",
  NODE_OPTIONS: "--max-old-space-size=1024",
};
// Reuse an installed headless browser when available; HyperFrames otherwise manages its browser.
if (!env.HYPERFRAMES_BROWSER_PATH) {
  const cache = join(homedir(), ".cache/ms-playwright");
  for (const entry of (await readdir(cache).catch(() => [])).sort().reverse()) {
    if (!entry.startsWith("chromium_headless_shell-")) continue;
    const candidate = join(
      cache,
      entry,
      "chrome-headless-shell-linux64/chrome-headless-shell",
    );
    if (existsSync(candidate)) {
      env.HYPERFRAMES_BROWSER_PATH = candidate;
      break;
    }
  }
}
function run(command, args, cwd = here) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited ${result.status}`);
}
await mkdir(join(here, ".generated"), { recursive: true });
await mkdir(assets, { recursive: true });
await copyFile(
  join(root, "server/assets/branding/icons/icon-512.png"),
  join(here, ".generated/logo.png"),
);
if (!process.argv.includes("--reuse-captures")) {
  run(
    "git",
    ["diff", "--exit-code", process.env.WHERDR_FILM_BASE || "origin/v3", "--", "app", "nuxt.config.ts"],
    root,
  );
  if (!process.argv.includes("--skip-build"))
    run("npm", ["run", "build:demo"], root);
  run(process.execPath, ["capture.mjs"]);
}
const evidence = JSON.parse(
  await readFile(join(here, ".generated/capture.json"), "utf8"),
);
for (const shot of evidence.shots) {
  const bytes = await readFile(join(here, ".generated", shot.file));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    shot.sha256,
    shot.file,
  );
}
await copyFile(
  join(here, ".generated/capture.json"),
  join(here, "capture.json"),
);
const html = await readFile(join(here, "index.html"), "utf8");
await writeFile(
  join(here, ".wide.html"),
  html
    .replace('id="film"', 'id="film" class="wide"')
    .replace('data-width="1080"', 'data-width="1920"'),
);
try {
  if (stills) {
    run(cli, [
      "snapshot",
      ".",
      "--at",
      "2,6.5,11.5,16.5,17.8,22.8,25.5,29.5,31,34",
      "--no-end",
      "--describe",
      "false",
      "--output",
      join(root, ".shots/launch-video"),
    ]);
    // A separate entry directory lets snapshot read the wide composition using its normal index contract.
    const preview = join(here, ".generated/wide");
    await mkdir(preview, { recursive: true });
    await writeFile(
      join(preview, "index.html"),
      html
        .replace('id="film"', 'id="film" class="wide"')
        .replace('data-width="1080"', 'data-width="1920"'),
    );
    const files = [
      "style.css",
      "timeline.js",
      ".generated/logo.png",
      "node_modules/gsap/dist/gsap.min.js",
      ...["archivo", "inter", "jetbrains-mono"].map(
        (font) =>
          `node_modules/@fontsource-variable/${font}/files/${font}-latin-wght-normal.woff2`,
      ),
    ];
    for (const file of files) {
      await mkdir(dirname(join(preview, file)), { recursive: true });
      await copyFile(join(here, file), join(preview, file));
    }
    for (const shot of evidence.shots)
      await copyFile(
        join(here, ".generated", shot.file),
        join(preview, ".generated", shot.file),
      );
    run(cli, [
      "snapshot",
      preview,
      "--at",
      "2,11.5,17.8,22.8,25.5,31,34",
      "--no-end",
      "--describe",
      "false",
      "--output",
      join(root, ".shots/launch-video-wide"),
    ]);
  } else {
    for (const [composition, name] of [
      ["index.html", "wherdr-launch.mp4"],
      [".wide.html", "wherdr-launch-wide.mp4"],
    ]) {
      run(cli, [
        "render",
        ".",
        "-c",
        composition,
        "-o",
        join(assets, name),
        "--workers",
        "1",
        "--low-memory-mode",
        "--no-browser-gpu",
        "--fps",
        "30",
        "--crf",
        "24",
      ]);
      const raw = join(here, ".generated", name);
      await copyFile(join(assets, name), raw);
      run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        raw,
        "-c",
        "copy",
        "-movflags",
        "+faststart+use_metadata_tags",
        "-metadata",
        "wherdr_capture=playwright-real-app",
        "-metadata",
        `wherdr_app_tree=${evidence.appTree}`,
        join(assets, name),
      ]);
    }
    run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      join(assets, "wherdr-launch.mp4"),
      "-an",
      "-vf",
      "fps=15,scale=720:720:flags=lanczos",
      "-c:v",
      "libwebp_anim",
      // Decoded H.264 compresses worse than clean captures: 75 keeps it under 5 MiB.
      "-quality",
      "75",
      "-compression_level",
      "4",
      "-loop",
      "0",
      "-threads",
      "2",
      join(assets, "wherdr-launch.webp"),
    ]);
    run(process.execPath, ["verify.mjs"]);
    for (const name of [
      "wherdr-launch.mp4",
      "wherdr-launch.webp",
      "wherdr-launch-wide.mp4",
    ]) {
      console.log(
        `${name}: ${((await stat(join(assets, name))).size / 1024 / 1024).toFixed(2)} MiB`,
      );
    }
  }
} finally {
  await rm(join(here, ".wide.html"), { force: true });
}
