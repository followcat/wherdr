// What each started task touches (shared/pm/files.ts), read from its worktree:
// the paths its worker declared in its files marker, and the files it changed
// (committed or not, new ones included) since its fork from its base as of now:
// origin's base, fetched now (origin's default branch when the task names none,
// asked of origin when origin/HEAD is unset), else the local one when origin has
// no such branch or there is no origin, else where its branch started. When
// origin cannot be reached, nothing is read (exit 1): a stale origin/<base>, a
// local base behind origin or that start would count origin's changes as the task's.
// Then the to-do tasks that wait behind one of them start once it no longer touches
// their files (it is done or only waits for its merge, or its files moved on).
import { beyond, fileConflict, parseFiles } from '../../shared/pm/files'
import { runFiles } from '../../shared/pm/advance'
import type { Task } from '../../shared/pm/run'
import { HerdrError } from './herdr'
import { exec, mergingOf, runOn, startTask, type PmLaunchDeps } from './pmLaunch'

const SEP = '--wherdr-files--'
export const FILES_SCRIPT = `wt=$1 b=$2 base=$4
cat "$3" 2>/dev/null; echo; echo "${SEP}"
s=
if git -C "$wt" remote get-url origin >/dev/null 2>&1; then
  [ -n "$base" ] || base=$(git -C "$wt" symbolic-ref -q --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')
  [ -n "$base" ] || base=$(git -C "$wt" ls-remote --symref origin HEAD 2>/dev/null | awk '$1 == "ref:" && $3 == "HEAD" { sub("^refs/heads/", "", $2); print $2; exit }')
  [ -n "$base" ] || exit 1
  if git -C "$wt" fetch -q origin "$base" 2>/dev/null; then s=$(git -C "$wt" merge-base HEAD "origin/$base" 2>/dev/null)
  else r=0; git -C "$wt" ls-remote -q --exit-code origin "refs/heads/$base" >/dev/null 2>&1 || r=$?; [ "$r" = 2 ] || exit 1; fi
fi
[ -n "$s" ] || [ -z "$base" ] || s=$(git -C "$wt" merge-base HEAD "$base" 2>/dev/null)
[ -n "$s" ] || s=$(git -C "$wt" config "branch.$b.wherdrstart") || exit 0
git -C "$wt" diff --name-only "$s" 2>/dev/null; git -C "$wt" ls-files --others --exclude-standard 2>/dev/null`

export function parseFilesRead(out: string): { files: string[], changed: string[] } {
  const [marker = '', diff = ''] = out.split(`${SEP}\n`)
  return { files: parseFiles(marker), changed: parseFiles(diff) }
}

const READ_EVERY_MS = 5 * 60_000
const readAt = new Map<string, number>() // task → when its worktree was last read
const same = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x, i) => x === b[i])

// Each started task not done, every 5 minutes. A marker left empty keeps the
// paths the task had (the coordinator's). New changes beyond them go to its log.
export async function syncFiles(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const runs = await store.runs()
  for (const task of await store.tasks()) {
    if (!task.step?.started || task.step.done || now - (readAt.get(task.id) ?? 0) < READ_EVERY_MS) continue
    const run = runs.filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!run) continue
    readAt.set(task.id, now)
    let on: string | undefined
    try { on = runOn(deps, run) } catch { continue }
    const r = await exec(deps, on, FILES_SCRIPT, [run.worktree, run.branch, runFiles(run.instructions).files, task.base ?? '']).catch(() => null)
    if (r?.code !== 0) continue
    const read = parseFilesRead(r.out)
    const files = read.files.length ? read.files : task.files
    if (same(files, task.files) && same(read.changed, task.changed)) continue
    const next: Task = { ...task, files, changed: read.changed }
    const was = beyond(task), added = beyond(next).filter(f => !was.includes(f))
    if (added.length) await store.logTask(next, 'engine', `changed files beyond the declared ones: ${added.slice(0, 5).join(', ')}${added.length > 5 ? '…' : ''}`)
    else await store.saveTask(next)
  }
}

// Why a task that waited behind `id` for its files waits no more.
export function releaseReason(id: string, tasks: Task[], merging: (t: Task) => boolean): string {
  const t = tasks.find(x => x.id === id)
  if (!t) return `${id} is gone`
  if (t.step?.done) return `${id} is done`
  if (!t.step?.started) return `${id} is not started`
  if (merging(t)) return `${id} is at merge`
  return `${id} no longer changes these files`
}

// To-do tasks that wait behind another for their files: once it no longer
// touches them, they wait no more. A chained or held task then starts by its
// own rule (startChained, startHeld); any other starts now, one per project and tick.
export async function startFileWaits(deps: PmLaunchDeps) {
  const { store } = deps
  const started: string[] = [], projects = new Set<string>()
  const merging = await mergingOf(store)
  for (const t of (await store.tasks()).filter(x => x.sameFiles && x.state === 'todo')) {
    const tasks = await store.tasks()
    const c = fileConflict(t, tasks, merging)
    if (c?.task === t.sameFiles) continue
    if (c) { await store.logTask({ ...t, sameFiles: c.task }, 'engine', `waits for ${c.task}: same files (${c.files.join(', ')})`); continue }
    const own = !t.after && !t.held
    if (own && projects.has(t.project)) continue
    const free = await store.logTask({ ...t, sameFiles: undefined }, 'engine', `no longer waits for ${t.sameFiles}: ${releaseReason(t.sameFiles!, tasks, merging)}`)
    if (!own) continue
    projects.add(free.project)
    // Already starting from elsewhere (busy): that start goes on.
    // Any other failure is saved: no longer behind the files, it would stay to do with nothing to start it.
    const r = await startTask(deps, free.id).catch((e: Error) => e instanceof HerdrError && e.code === 'busy' ? null : store.saveTask({ ...free, state: 'waiting', waiting: e.message }))
    if (!r) continue
    await store.logTask((await store.task(free.id))!, 'engine', r.state === 'working' ? 'started: its files are free' : `could not start: ${r.waiting ?? r.held ?? ''}`)
    started.push(free.id)
  }
  return started
}
