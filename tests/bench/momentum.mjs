// Replays the same flick at 60/90/120 Hz and reports the momentum distance
// each frame rate produces. The gesture utility integrates velocity against
// injected time, so a fixed synthetic clock makes the runs comparable.
// Usage: node tests/bench/momentum.mjs [--json] [--repeats N]
import { createTerminalTouch } from '../../app/utils/terminalTouch.ts'

const args = process.argv.slice(2)
const json = args.includes('--json')
const repeats = Number(args[args.indexOf('--repeats') + 1] || 5)
const LIMIT = 10000

// The drag: three -40px samples 16ms apart, released fast (~2.5 px/ms).
function run(hz) {
  const stepMs = 1000 / hz
  let time = 0, id = 0
  const frames = new Map()
  const moved = []
  const touch = createTerminalTouch({
    vertical: (px) => moved.push(px),
    horizontal: () => {}, canHorizontal: () => false,
    maxMomentum: () => LIMIT, now: () => time,
    frame: fn => { frames.set(++id, fn); return id },
    cancelFrame: n => { frames.delete(n) },
  })
  touch.start(0, 0)
  for (const dy of [-40, -80, -120]) { time += 16; touch.move(0, dy) }
  const direct = moved.reduce((n, v) => n + v, 0)
  touch.end()
  // Pump rAF at the simulated refresh rate until the glide settles.
  for (let i = 0; i < 2000 && frames.size; i++) {
    time += stepMs
    for (const [n, fn] of [...frames]) { frames.delete(n); fn(time) }
  }
  const momentum = moved.reduce((n, v) => n + v, 0) - direct
  return { hz, direct, momentum, total: direct + momentum, ms: time }
}

const results = []
for (const hz of [60, 90, 120]) {
  const runs = Array.from({ length: repeats }, () => run(hz))
  const distances = runs.map(r => Math.abs(r.momentum))
  results.push({
    hz,
    samples: runs.length,
    momentum: { min: Math.min(...distances), max: Math.max(...distances), mean: distances.reduce((a, b) => a + b) / runs.length },
  })
}
if (json) console.log(JSON.stringify(results, null, 1))
else for (const r of results) console.log(`${r.hz}Hz  n=${r.samples}  momentum px: min=${r.momentum.min.toFixed(1)} mean=${r.momentum.mean.toFixed(1)} max=${r.momentum.max.toFixed(1)}`)
