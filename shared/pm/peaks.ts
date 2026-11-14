// Measured memory peaks: what a task's processes really take, so placement
// counts that instead of its weight's starting estimate. Each tick, one script
// per machine with agents at work lists every process's memory and folder; a
// run's sample is the sum of the processes whose folder is in its worktree (the
// agent, builds, test workers, the dev server and its browser all start there).
import { WEIGHTS, WEIGHT_DEFAULTS, weightOf, type Weight } from './weight'
import type { Template } from './workflow'
import type { Run, Task } from './run'

// Lines `p<pid>`, `r<rss in KB>`, `n<folder>`, the format of `lsof -F`. Linux
// reads /proc (one find for every folder); macOS asks ps and lsof.
export const PEAK_SCRIPT = `if [ "$(uname -s)" = Darwin ]; then
  ps -axo pid=,rss= | awk '{print "p"$1; print "r"$2}'
  lsof -a -d cwd -Fpn 2>/dev/null || true # it fails on processes it may not read
else
  ps -eo pid=,rss= | awk '{print "p"$1; print "r"$2}'
  find /proc -mindepth 2 -maxdepth 2 -name cwd -printf 'p%h\\nn%l\\n' 2>/dev/null | sed 's|^p/proc/|p|'
fi`

// PEAK_SCRIPT's output → MB per worktree (0 when nothing runs there).
export function parsePeaks(text: string, worktrees: string[]): Record<string, number> {
  const rss = new Map<string, number>(), cwd = new Map<string, string>()
  let pid = ''
  for (const line of text.split('\n')) {
    const v = line.slice(1).trim()
    if (line[0] === 'p') pid = v
    else if (line[0] === 'r' && Number.isFinite(Number(v))) rss.set(pid, Number(v))
    else if (line[0] === 'n') cwd.set(pid, v)
  }
  const out: Record<string, number> = Object.fromEntries(worktrees.map(w => [w, 0]))
  for (const [p, dir] of cwd) {
    const w = worktrees.find(x => dir === x || dir.startsWith(`${x.replace(/\/$/, '')}/`))
    if (w && rss.has(p)) out[w]! += rss.get(p)! / 1024
  }
  return Object.fromEntries(Object.entries(out).map(([w, mb]) => [w, Math.round(mb)]))
}

// A weight's estimate in one project: the largest of its last LAST measured
// peaks × MARGIN, once MIN runs have one; until then the weight's default.
export const LEARN = { MIN: 3, LAST: 5, MARGIN: 1.15 }
export interface WeightEstimate { mb: number, cores: number, runs: number } // runs: the peaks it comes from, 0 = the default

export function learnedEstimates(t: Template | null | undefined, tasks: Pick<Task, 'id' | 'type' | 'weight'>[], runs: Pick<Run, 'task' | 'peakMb' | 'startedAt'>[]): Record<Weight, WeightEstimate> {
  const weight = new Map(tasks.map(x => [x.id, weightOf(t, x).weight]))
  const measured = runs.filter(r => r.peakMb && weight.has(r.task)).sort((a, b) => b.startedAt - a.startedAt)
  return Object.fromEntries(WEIGHTS.map((w) => {
    const peaks = measured.filter(r => weight.get(r.task) === w).slice(0, LEARN.LAST).map(r => r.peakMb!)
    const mb = peaks.length >= LEARN.MIN ? Math.round(Math.max(...peaks) * LEARN.MARGIN) : WEIGHT_DEFAULTS[w].mb
    return [w, { mb, cores: WEIGHT_DEFAULTS[w].cores, runs: peaks.length >= LEARN.MIN ? peaks.length : 0 }]
  })) as Record<Weight, WeightEstimate>
}
