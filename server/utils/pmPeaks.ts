// Measured memory peaks (shared/pm/peaks.ts): each mechanic tick, one sample
// per machine with agents at work raises each running run's peakMb; a
// project's estimate per weight is learned from its stored runs.
import { PEAK_SCRIPT, learnedEstimates, parsePeaks } from '../../shared/pm/peaks'
import type { PmStore } from './pmStore'
import { exec, runOn, type PmLaunchDeps } from './pmLaunch'

export async function samplePeaks(deps: PmLaunchDeps) {
  const running = (await deps.store.runs()).filter(r => r.state !== 'ended' && r.worktree)
  const byMachine = new Map<string, typeof running>()
  for (const r of running) byMachine.set(r.machine, [...(byMachine.get(r.machine) ?? []), r])
  const raised = new Map<string, number>()
  await Promise.all([...byMachine].map(async ([, runs]) => {
    let on: string | undefined
    try { on = runOn(deps, runs[0]!) } catch { return }
    const r = await exec(deps, on, PEAK_SCRIPT, [], undefined, 20).catch(() => null)
    if (r?.code !== 0) return
    const mb = parsePeaks(r.out, [...new Set(runs.map(x => x.worktree))])
    for (const run of runs) if ((mb[run.worktree] ?? 0) > (run.peakMb ?? 0)) raised.set(run.id, mb[run.worktree]!)
  }))
  if (!raised.size) return
  // Saved on the runs read now, so a state change made meanwhile is kept.
  for (const run of await deps.store.runs()) {
    const mb = raised.get(run.id)
    if (mb && mb > (run.peakMb ?? 0)) await deps.store.saveRun({ ...run, peakMb: mb })
  }
}

// A project's estimate per weight: learned from its runs' peaks, else the defaults.
export async function projectEstimates(store: PmStore, key: string) {
  const [t, tasks, runs] = await Promise.all([store.workflow(key).catch(() => null), store.tasks(), store.runs()])
  return learnedEstimates(t, tasks.filter(x => x.project === key), runs)
}
