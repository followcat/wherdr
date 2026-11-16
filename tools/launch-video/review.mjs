#!/usr/bin/env node
/** Extract every third output frame (10 fps), in both cuts, for visual review. */
import { mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const output = join(root, ".shots/v3-review");
await mkdir(output, { recursive: true });
function ffmpeg(args) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", ...args],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Review extraction failed (${result.status})`);
}
ffmpeg([
  "-i",
  "assets/wherdr-launch.mp4",
  "-i",
  "assets/wherdr-launch-wide.mp4",
  "-filter_complex",
  "[0:v]fps=10,scale=360:360,drawtext=text='%{n}':fontsize=20:fontcolor=white:box=1:boxcolor=black:x=6:y=6[s];[1:v]fps=10,scale=640:360[w];[s][w]hstack=inputs=2,tile=3x5:nb_frames=15:padding=6:margin=6[v]",
  "-map",
  "[v]",
  "-fps_mode",
  "vfr",
  "-frames:v",
  "40",
  "-threads",
  "2",
  join(output, "sheet-%02d.jpg"),
]);
for (const [at, name, cut] of [
  [6.5, "01-alfred", ""],
  [17.8, "02-approved-with-screenshots", ""],
  [22.8, "03-board-moves-wide", "-wide"],
  [30.5, "04-phone-answer", ""],
]) {
  ffmpeg([
    "-ss",
    String(at),
    "-i",
    `assets/wherdr-launch${cut}.mp4`,
    "-frames:v",
    "1",
    "-threads",
    "1",
    join(output, `${name}.png`),
  ]);
}
console.log(
  "Sheets: every third rendered frame, square + wide. Review before pushing.",
);
