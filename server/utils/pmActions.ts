// Runs one engine action in a task's worktree, on its project's machine:
// guard first, receipt before, transient errors tried again (1, 2, 4, 8 min;
// it runs outside the engine's ticks, pmBoard.ts startAction), a merge's wait
// for CI or GitHub's lag handed back as later (a later pass looks again),
// then the alert when the task's commit sits on a protected branch that no
// step of the user and no guarded action put it on.
import { PATH_SETUP, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import type { PmStore } from './pmStore'
import { mayMerge } from '../../shared/pm/guards'
import { BB_STRATEGY, CODE, RETRY_MS, SCRIPT, SLOW, SLOW_SECS, allText, bbReady, errorText, keepsBranch, commandState, guardAction, isTransient, leaks, outputTail, prReady, readPrInfo, receiptId, runsState, type ActionResult, type GhRun, type PrInfo, type ShellResult } from '../../shared/pm/actions'
import type { ResolvedGuards } from '../../shared/pm/guards'
import type { BbStatus } from '../../shared/pm/actions'
import { isPrMerge, type MergeBy, type StepAction } from '../../shared/pm/workflow'

type Shell = (script: string, args: string[], input?: string) => Promise<ShellResult>
export interface ActionDeps {
  store: Pick<PmStore, 'receipt' | 'saveReceipt'>
  sh: Shell
  sleep?: (ms: number) => Promise<void>
}
export interface ActionJob {
  task: { id: string, title: string, description: string, project?: string }
  shown?: string // the task id as the user sees it, for the PR title
  step: string
  attempt: number // from the step engine's action effect
  action: StepAction
  by: MergeBy // 'user' when the user's gesture started it
  guards: ResolvedGuards
  worktree: string
  branch: string
  allowed?: string[] // protected branches the task already reached through you
  reviewed?: string // a PR merge: the commit the last review passed
  approved?: string // github.merge: the commit the user approved; the interface changed since → asked again
  halted?: () => Promise<boolean> // the task was stopped meanwhile: no merge
}

// A merge cut by a restart (wherdr reloading after a merge, an update) asks
// GitHub where its PR stands, at most this many times, then goes to the user.
export const MERGE_RESUMES = 2
// The merges running now: a shutdown waits for them (server/plugins/pm.ts).
const merging = new Set<Promise<unknown>>()
export const mergesSettled = (ms: number) =>
  Promise.race([Promise.allSettled([...merging]), pause(ms)]).then(() => merging.size === 0)

// The shell of a project's machine, through herdr-core. stdout and stderr
// stay apart: a warning on stderr (ssh, gh) is never read as the result.
export const actionShell = (deps: Pick<CoreAdminDeps, 'call'>, on: string | undefined): Shell =>
  (script, args, input) => exec(deps, on, `${PATH_SETUP}\n${script}`, args, input, SLOW.has(script) ? SLOW_SECS : undefined)

// What moved in the task's own change (all its files, or its interface files)
// from commit `from` to `to`: nothing but merges of its base (same), comments
// and whitespace only (comments), or the files listed (changed).
type Moved = { kind: 'same' | 'comments' } | { kind: 'changed', files: string[] }
const ownMoved = async (deps: ActionDeps, script: string, wt: string, base: string, from: string, to: string): Promise<Moved> => {
  const r = await run(deps, script, [wt, base, from, to])
  const lines = r.out.trim().split('\n').map(l => l.trim()).filter(Boolean), last = lines.pop()
  if (r.code === 0 && (last === 'same' || last === 'comments')) return { kind: last }
  return { kind: 'changed', files: r.code === 0 ? lines.slice(0, 20) : [] }
}
const KEPT = { same: 'base merge, same interface', comments: 'comment-only change' }
const span = (from: string, to: string) => `${from.slice(0, 7)}..${to.slice(0, 7)}`
// The head moved after the review (catch-up, conflict, CI fix): reviewed again,
// unless only base merges or comments moved, said in `kept` for the task's log.
const newSinceReview = async (deps: ActionDeps, job: ActionJob, base: string, head: string, kept: Set<string>): Promise<ActionResult | undefined> => {
  if (!job.reviewed || job.reviewed === head) return
  const m = await ownMoved(deps, SCRIPT.ownChanged, job.worktree, base, job.reviewed, head)
  if (m.kind === 'changed') return { ok: false, error: `merge: new commits since the review (${span(job.reviewed, head)})`, review: { since: job.reviewed, head }, commit: head }
  if (m.kind === 'comments') kept.add(`no new review: comment-only change (${span(job.reviewed, head)})`)
}
// Approved earlier: a new look only if the task's own interface changed since,
// with the files and commits as the reason; else the approval stays, said in `kept`.
const lookAgain = async (deps: ActionDeps, job: ActionJob, base: string, head: string, kept: Set<string>): Promise<ActionResult | undefined> => {
  if (!job.approved || job.approved === head) return
  const ui = await ownMoved(deps, SCRIPT.uiChanged, job.worktree, base, job.approved, head)
  if (ui.kind === 'changed') return { ok: false, error: `merge: the interface changed since your approval (${span(job.approved, head)}${ui.files.length ? `: ${ui.files.join(', ')}` : ''})`, unapproved: { since: job.approved, head, files: ui.files }, commit: head }
  if (ui.kind === 'comments') return void kept.add(`approval kept: ${KEPT.comments} (${span(job.approved, head)})`)
  const all = await ownMoved(deps, SCRIPT.ownChanged, job.worktree, base, job.approved, head)
  kept.add(`approval kept: ${all.kind === 'changed' ? 'no interface file changed' : KEPT[all.kind]} (${span(job.approved, head)})`)
}
const keptNote = (kept: Set<string>) => (kept.size ? { note: [...kept].join('; ') } : {})

// A PR head made by GitHub's Update branch (SCRIPT.headOf says update): taken
// into the worktree, where the project's after-merge fix runs, then pushed at
// once so the PR does not keep the unfixed merge.
export async function takeUpdate(sh: Shell, wt: string, branch: string, guards: ResolvedGuards, by: MergeBy):
Promise<{ ok: true, head: string } | { ok: false, error: string, toAgent?: boolean }> {
  const failed = (r: ShellResult) => ({ ok: false as const, error: lastLine(errorText(r)) || `exit code ${r.code}`, ...(r.code === CODE.SEND_BACK ? { toAgent: true } : {}) })
  const y = await sh(SCRIPT.sync, [wt, branch])
  if (y.code !== 0) return failed(y)
  const no = guardAction(guards, { kind: 'git.push' }, { branch, by })
  if (no) return { ok: false, error: no }
  const up = await sh(SCRIPT.push, [wt, branch])
  return up.code === 0 ? { ok: true, head: lastLine(up.out) } : failed(up)
}

// GitHub's words for a PR in conflict with its base.
const CONFLICT = /not mergeable|merge conflict|cannot be cleanly created/i
const lastLine = (out: string) => out.trim().split('\n').pop()?.trim().slice(0, 300) || ''
// Why a script failed: a refused push says it on its "! [rejected]" line
// (git's hints and "failed to push" come after it); else the last line.
export function whyFailed(out: string) {
  const lines = out.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('hint:'))
  const m = lines.map(l => /^! \[(?:remote )?rejected\]\s+\S+ -> (\S+) \((.+)\)$/.exec(l)).find(Boolean)
  return (m ? `push to ${m[1]} refused: ${m[2]}` : lines.at(-1) ?? '').slice(0, 300)
}
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runAction(deps: ActionDeps, job: ActionJob): Promise<ActionResult> {
  const { store } = deps
  const id = receiptId(job.task.id, job.step, job.attempt)
  const base = { id, task: job.task.id, step: job.step, action: job.action }
  // A watch only reads: no receipt, each poll is a new one.
  if (job.action.kind === 'pipeline.watch') return watch(deps, job)
  const last = await store.receipt(id)
  if (last?.state === 'done') return last.result!
  // A merge that waited for its checks or GitHub's lag: this pass looks again, as new.
  const prev = last?.state === 'later' ? undefined : last
  if (last?.by) job = { ...job, by: last.by }
  const merge = isPrMerge(job.action.kind)
  const resumes = prev ? (prev.resumes ?? 0) + 1 : 0
  if (prev && (!merge || prev.state !== 'pending' || resumes > MERGE_RESUMES)) {
    await store.saveReceipt({ ...prev, state: 'uncertain' })
    const why = merge && resumes > MERGE_RESUMES ? `interrupted ${MERGE_RESUMES + 1} times` : 'interrupted before its result was known'
    return { ok: false, error: `${job.action.kind} was ${why}: check by hand, then try again` }
  }
  // Resumed, it keeps who started it (above): your gesture still counts for the guards.
  const refused = guardAction(job.guards, job.action, { branch: job.branch, by: job.by, project: job.task.project })
  if (refused) return finish({ ok: false, error: refused })
  await store.saveReceipt({ ...base, by: job.by, state: 'pending', at: Date.now(), ...(resumes ? { resumes } : {}) })
  const running = perform(deps, job, resumes > 0)
  if (!merge) return finish(await running)
  merging.add(running)
  try { return await finish(await running) } finally { merging.delete(running) }

  async function finish({ reached, ...result }: Done) {
    if (result.ok) {
      const alert = await leakAlert(deps, job, result, reached ?? []).catch(() => undefined)
      if (alert) result = { ...result, alert: [result.alert, alert].filter(Boolean).join('. ') }
    }
    await store.saveReceipt({ ...base, state: result.later ? 'later' : 'done', result, at: Date.now(), ...(result.later ? { by: job.by } : {}) })
    return result
  }
}

// Runs a script in the worktree; a transient error is tried again, a timeout
// too unless `once` (a merge cut off may have gone through).
async function run(deps: ActionDeps, script: string, args: string[], input?: string, once = false) {
  for (let i = 0; ; i++) {
    const r = await deps.sh(script, args, input)
    if (r.code === 0 || (once && r.code === null) || !isTransient(r.code, allText(r)) || i >= RETRY_MS.length) return r
    await (deps.sleep ?? pause)(RETRY_MS[i]!)
  }
}

// reached: the protected branch a guarded merge put the commit on.
type Done = ActionResult & { reached?: string[] }

// resumed: an interrupted merge run again, which first finds where GitHub left its PR.
async function perform(deps: ActionDeps, job: ActionJob, resumed = false): Promise<Done> {
  const { action: a, worktree: wt, branch } = job
  const name = a.kind.split('.')[1]
  const fail = (r: ShellResult): ActionResult =>
    ({ ok: false, error: `${name}: ${r.code === null ? 'timed out' : whyFailed(errorText(r)) || `exit code ${r.code}`}`, ...(r.code === CODE.SEND_BACK ? { toAgent: true } : {}) })
  const commit = async (script: string, args: string[]) => {
    const r = await run(deps, script, [wt, ...args])
    return r.code === 0 ? { ok: true, commit: lastLine(r.out) } : fail(r)
  }
  switch (a.kind) {
    case 'git.land': return commit(SCRIPT.land, [a.target!])
    case 'git.push': return commit(SCRIPT.push, [branch])
    case 'git.verify-merged': {
      const r = await run(deps, SCRIPT.verify, [wt, a.target!, branch])
      if (r.code === 0) return { ok: true, commit: lastLine(r.out) }
      // Not merged by git, or GitHub could not answer (gh logged out on a Bitbucket repository): Bitbucket may know.
      return ((r.code === CODE.NOT_MERGED || /\(GitHub not checked: /.test(r.out)) && await bitbucketMerged(deps, wt, branch, a.target!)) || fail(r)
    }
    case 'github.pr': {
      const r = await run(deps, SCRIPT.pr, [wt, branch, a.base!, `${job.shown ?? job.task.id}: ${job.task.title}`], job.task.description || job.task.title)
      return r.code === 0 ? { ok: true, link: lastLine(r.out) } : fail(r)
    }
    case 'github.merge': {
      // Waits for GitHub to show a fresh push, or for the checks: later, a later pass looks again.
      // unread: PR details that could not be read, tried again as a transient error.
      // cut: merges that timed out, after which GitHub is asked again first.
      let pushed = false, synced = false, unread = 0, cut = 0
      const kept = new Set<string>()
      for (;;) {
        const r = await run(deps, SCRIPT.prInfo, [wt, branch])
        if (r.code !== 0) return fail(r)
        const info = readPrInfo(r.out)
        if (!info) {
          if (unread < RETRY_MS.length) { await (deps.sleep ?? pause)(RETRY_MS[unread++]!); continue }
          return { ok: false, error: `merge: unreadable PR details: ${outputTail(r.out) || 'no output'}` }
        }
        const head = info.head, pr: PrInfo | undefined = info.prs[0]
        // Merged on GitHub already (by hand, or a merge answered with an error): done.
        // Its base counts as reached only where this step could have merged:
        // a protected branch merged outside your gesture still raises the alert.
        if (pr?.merged) {
          const reached = mayMerge(job.guards, pr.baseRefName, job.by) ? [pr.baseRefName] : []
          if (!pr.stray) return { ok: true, link: pr.url, commit: head.trim(), base: pr.baseRefName, reached, note: resumed ? 'merged before the restart' : 'already merged on GitHub' }
          // Merged at a head without the task's commit: what GitHub merged is recorded, and what it left out is said.
          const h = head.trim().slice(0, 7), m = pr.headRefOid.slice(0, 7)
          return { ok: true, link: pr.url, commit: pr.headRefOid, base: pr.baseRefName, reached, note: `already merged on GitHub at ${m}, without the task's commit ${h}`,
            alert: `${job.task.id}'s commit ${h} was not merged: its PR was merged on GitHub at ${m} without it. Its later commits need a new branch` }
        }
        const refused = pr && guardAction(job.guards, a, { branch, by: job.by, base: pr.baseRefName })
        if (refused) return { ok: false, error: refused }
        if (pr) {
          const h = head.trim(), at = await run(deps, SCRIPT.headOf, [wt, pr.headRefOid, pr.baseRefName])
          if (at.code !== 0) return fail(at)
          const where = lastLine(at.out)
          // Updated on GitHub (Update branch): fixed in the worktree and pushed, then looked at again.
          if (where === 'update' && !synced) {
            synced = true
            const u = await takeUpdate((sc, ar, i) => run(deps, sc, ar, i), wt, branch, job.guards, job.by)
            if (!u.ok) return { ok: false, error: `merge: ${u.error}`, ...(u.toAgent ? { toAgent: true } : {}) }
            continue
          }
          if (where === 'foreign') return { ok: false, error: `merge: the PR head ${pr.headRefOid.slice(0, 7)} has commits the task's worktree never had (pushed from elsewhere): bring them into the worktree, or merge by hand` }
          const again = await newSinceReview(deps, job, pr.baseRefName, h, kept) ?? await lookAgain(deps, job, pr.baseRefName, h, kept)
          if (again) return again
          if (where === 'behind') {
            if (pushed) {
              // GitHub's API can lag a fresh push: the remote branch is the truth.
              const rb = await run(deps, SCRIPT.remoteHead, [wt, branch])
              if (rb.code !== 0) return fail(rb)
              const remote = lastLine(rb.out)
              if (remote !== h) return { ok: false, error: `merge: the push did not move origin/${branch} (at ${remote.slice(0, 7) || 'nothing'}, the task at ${h.slice(0, 7)}): push the branch by hand, then try the step again` }
              return { ok: false, later: true, error: `merge: GitHub still shows the PR head at ${pr.headRefOid.slice(0, 7)}, origin/${branch} is at ${h.slice(0, 7)}` }
            }
            const no = guardAction(job.guards, { kind: 'git.push' }, { branch, by: job.by })
            if (no) return { ok: false, error: no }
            const up = await run(deps, SCRIPT.push, [wt, branch])
            if (up.code !== 0) return fail(up)
            pushed = true
            continue
          }
        }
        if (!pr) {
          const c = await run(deps, SCRIPT.prClosed, [wt, branch])
          const url = c.code === 0 ? lastLine(c.out) : ''
          if (url) return { ok: false, error: `merge: the PR was closed without being merged (${url}): reopen it, or open a new one` }
        }
        // Conflicting or behind its base: no check runs on it, it needs a catch-up first.
        const stale = { DIRTY: 'conflicts with', BEHIND: 'is behind' }[pr?.mergeStateStatus ?? '']
        if (pr && stale) return { ok: false, error: `merge: the PR ${stale} ${pr.baseRefName}`, catchUp: pr.baseRefName, commit: head.trim() }
        const ready = prReady(pr, head.trim(), a.checks)
        if (!ready.ok) return { ok: false, error: `merge: ${ready.why}`, ...(ready.later ? { later: true } : {}) }
        if (await job.halted?.()) return { ok: false, error: 'merge: the task was stopped' }
        const m = await run(deps, SCRIPT.merge, [wt, pr!.url, head.trim(), a.method ?? ''], undefined, true)
        // Timed out: it may have merged. The PR is read again before any new try.
        if (m.code === null && cut++ < MERGE_RESUMES) continue
        if (m.code === 0) return { ok: true, link: pr!.url, commit: head.trim(), base: pr!.baseRefName, reached: [pr!.baseRefName], ...keptNote(kept) }
        // GitHub's refusal ends with the commands to fix it: those are the agent's (the catch-up), not the error's.
        const stuck = CONFLICT.test(allText(m)) ? 'conflicts with' : /not up to date/i.test(allText(m)) ? 'is behind' : undefined
        return stuck ? { ok: false, error: `merge: the PR ${stuck} ${pr!.baseRefName}`, catchUp: pr!.baseRefName, commit: head.trim() } : fail(m)
      }
    }
    case 'pipeline.watch': return watch(deps, job)
    case 'bitbucket.merge': return bitbucketMerge(deps, job, fail)
  }
}

interface BbPr { id: number, state: string, destination: { branch: { name: string } }, source: { commit: { hash: string } }, links: { html: { href: string } } }

// verify-merged's GitHub check, on Bitbucket Cloud when it has credentials: a
// merged PR from the branch into the target whose source commit is HEAD or holds it.
async function bitbucketMerged(deps: ActionDeps, wt: string, branch: string, target: string): Promise<Done | undefined> {
  const r = await run(deps, SCRIPT.bitbucket, [wt, 'GET', '/pullrequests?state=MERGED&sort=-updated_on&pagelen=50', `q=source.branch.name="${branch}" AND destination.branch.name="${target}"`])
  const lines = r.out.trim().split('\n')
  if (r.code !== 0 || lines.pop() !== '200') return
  let prs: BbPr[]
  try { prs = (JSON.parse(lines.pop() || '{}') as { values?: BbPr[] }).values ?? [] }
  catch { return }
  for (const p of prs) {
    const h = await run(deps, SCRIPT.holds, [wt, p.source.commit.hash])
    if (h.code === 0) return { ok: true, commit: lastLine(h.out), link: p.links.html.href, note: 'merged on Bitbucket' }
  }
}

// As github.merge, through the Bitbucket Cloud API: the task's open PR, its
// guard on the PR's destination, its head pushed when behind, its build
// statuses waited for, then a merge commit unless the step names a method.
// Bitbucket gives a commit's first 12 characters.
async function bitbucketMerge(deps: ActionDeps, job: ActionJob, fail: (r: ShellResult) => ActionResult): Promise<Done> {
  const { action: a, worktree: wt, branch } = job
  const api = async <T>(method: string, path: string, arg: string) => {
    const r = await run(deps, SCRIPT.bitbucket, [wt, method, path, arg])
    if (r.code !== 0) return { error: fail(r) }
    const lines = r.out.trim().split('\n'), status = Number(lines.pop())
    try { return { status, body: JSON.parse(lines.pop() || '{}') as T & { error?: { message?: string } } } }
    catch { return { error: { ok: false, error: 'merge: unreadable Bitbucket answer' } } }
  }
  const refusal = (r: { status: number, body: { error?: { message?: string } } }) => ({ ok: false, error: `merge: ${r.body.error?.message || `Bitbucket answered ${r.status}`}` })
  let pushed = false
  const kept = new Set<string>()
  for (;;) {
    const h = await run(deps, SCRIPT.head, [wt])
    if (h.code !== 0) return fail(h)
    const head = lastLine(h.out)
    const list = await api<{ values?: BbPr[] }>('GET', '/pullrequests?state=OPEN&state=MERGED&sort=-updated_on&pagelen=50', `q=source.branch.name="${branch}"`)
    if ('error' in list) return list.error!
    if (list.status !== 200) return refusal(list)
    const prs = list.body.values ?? [], pr = prs.find(p => p.state === 'OPEN')
    if (!pr) {
      const done = prs.find(p => p.state === 'MERGED' && head.startsWith(p.source.commit.hash))
      if (!done) return { ok: false, error: 'merge: no open PR for this task' }
      const base = done.destination.branch.name
      return { ok: true, link: done.links.html.href, commit: head, base, reached: mayMerge(job.guards, base, job.by) ? [base] : [], note: 'already merged on Bitbucket' }
    }
    const base = pr.destination.branch.name, link = pr.links.html.href
    const refused = guardAction(job.guards, a, { branch, by: job.by, base })
    if (refused) return { ok: false, error: refused }
    const again = await newSinceReview(deps, job, base, head, kept)
    if (again) return again
    if (!head.startsWith(pr.source.commit.hash)) {
      if (pushed) return { ok: false, error: `merge: the PR head ${pr.source.commit.hash.slice(0, 7)} is not the task's commit` }
      const no = guardAction(job.guards, { kind: 'git.push' }, { branch, by: job.by })
      if (no) return { ok: false, error: no }
      const up = await run(deps, SCRIPT.push, [wt, branch])
      if (up.code !== 0) return fail(up)
      pushed = true
      continue
    }
    const st = await api<{ values?: BbStatus[] }>('GET', `/commit/${head}/statuses`, 'pagelen=100')
    if ('error' in st) return st.error!
    if (st.status !== 200) return refusal(st)
    const ready = bbReady(st.body.values ?? [], a.checks)
    if (!ready.ok) return { ok: false, error: `merge: ${ready.why}`, ...(ready.later ? { later: true } : {}) }
    if (await job.halted?.()) return { ok: false, error: 'merge: the task was stopped' }
    const body = JSON.stringify({ type: 'pullrequest', merge_strategy: BB_STRATEGY[a.method ?? 'merge'], close_source_branch: false })
    const m = await api<object>('POST', `/pullrequests/${pr.id}/merge`, body)
    if ('error' in m) return m.error!
    return m.status === 200 ? { ok: true, link, commit: head, base, reached: [base], ...keptNote(kept) } : refusal(m)
  }
}

// After a merge (the engine's, or one the user confirmed): the task's remote
// branch goes when it is safe, else stays. The line for the task's log, or
// none: the project keeps branches, or there is no remote branch.
export async function dropMergedBranch(sh: Shell, j: { worktree: string, branch: string, guards: ResolvedGuards, bases: (string | undefined)[], on: boolean }): Promise<string | undefined> {
  if (!j.on) return
  const kept = (why: string) => `kept the remote branch ${j.branch}: ${why}`
  const no = keepsBranch(j.guards, j.branch, j.bases)
  if (no) return kept(no)
  const r = await sh(SCRIPT.dropBranch, [j.worktree, j.branch])
  if (r.code !== 0) return kept(lastLine(errorText(r)) || `exit code ${r.code}`)
  const out = lastLine(r.out)
  if (out === 'bitbucket') return dropOnBitbucket(sh, j.worktree, j.branch, kept)
  return out === 'deleted' ? `deleted the remote branch ${j.branch}` : out.startsWith('kept: ') ? kept(out.slice(6)) : undefined
}

// As SCRIPT.dropBranch, through the Bitbucket Cloud API: no open PR from or to
// it, a merged PR at its exact head, no delete restriction on it, and not the
// repository's main branch.
async function dropOnBitbucket(sh: Shell, wt: string, branch: string, kept: (why: string) => string) {
  const get = async <T>(path: string, q: string) => {
    const r = await sh(SCRIPT.bitbucket, [wt, 'GET', path, q])
    const lines = r.out.trim().split('\n'), status = Number(lines.pop())
    if (r.code !== 0 || status !== 200) throw new Error(lastLine(errorText(r)) || `exit code ${r.code}`)
    return JSON.parse(lines.pop() || '{}') as T
  }
  const list = async <T>(path: string, q: string) => (await get<{ values?: T[] }>(path, q)).values ?? []
  try {
    const rh = await sh(SCRIPT.remoteHead, [wt, branch])
    if (rh.code !== 0) return kept(lastLine(errorText(rh)))
    const head = lastLine(rh.out)
    if (!head) return
    // One open PR is enough to keep it: asked apart, so no page of merged ones hides it.
    if ((await list('/pullrequests?state=OPEN&pagelen=1', `q=source.branch.name="${branch}"`)).length) return kept('an open PR uses it')
    if ((await list('/pullrequests?state=OPEN&pagelen=1', `q=destination.branch.name="${branch}"`)).length) return kept('an open PR targets it')
    const merged = await list<BbPr>('/pullrequests?state=MERGED&sort=-updated_on&pagelen=50', `q=source.branch.name="${branch}"`)
    if (!merged.length) return kept('no merged PR of it')
    if (!merged.some(p => head.startsWith(p.source.commit.hash))) return kept(`commit ${head.slice(0, 7)} was pushed after its merge`)
    const repo = await get<{ mainbranch?: { name?: string } }>('', 'fields=mainbranch.name')
    if (repo.mainbranch?.name === branch) return kept('it is the repository\'s main branch')
    const rules = await get<{ values?: BbRule[], next?: string }>('/branch-restrictions?kind=delete', 'pagelen=100')
    if (rules.next) return kept('too many Bitbucket branch restrictions to check')
    if (await restricted(rules.values ?? [], branch, () => get<BbModel>('/branching-model', 'fields=development,production,branch_types'))) return kept('a Bitbucket branch restriction forbids deleting it')
    const d = await sh(SCRIPT.deleteRef, [wt, branch, head])
    return d.code === 0 ? `deleted the remote branch ${branch}` : kept(lastLine(errorText(d)))
  }
  catch (e) { return kept(`Bitbucket: ${(e as Error).message}`) }
}

interface BbRule { branch_match_kind?: string, pattern?: string, branch_type?: string }
interface BbModel { development?: { name?: string, branch?: { name?: string } }, production?: { name?: string, branch?: { name?: string } }, branch_types?: { kind: string, prefix: string }[] }

// Does a delete restriction cover the branch? By glob (* matches any run of
// characters), or by the branching model's development or production branch,
// or one of its type prefixes. The model is asked only when a rule needs it.
async function restricted(rules: BbRule[], branch: string, model: () => Promise<BbModel>) {
  const glob = (p: string) => new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$')
  if (rules.some(r => r.branch_match_kind !== 'branching_model' && glob(r.pattern ?? '*').test(branch))) return true
  const typed = rules.filter(r => r.branch_match_kind === 'branching_model')
  if (!typed.length) return false
  const m = await model()
  return typed.some((r) => {
    const t = r.branch_type ?? ''
    if (t === 'development' || t === 'production') return (m[t]?.branch?.name ?? m[t]?.name) === branch
    return (m.branch_types ?? []).some(b => b.kind === t && b.prefix && branch.startsWith(b.prefix))
  })
}

// One poll of a pipeline: done, failed (with which run and job, and the tail
// of the output), or later. An error that passes by itself is a later too.
export async function watch(deps: Pick<ActionDeps, 'sh'>, job: Pick<ActionJob, 'action' | 'worktree'>): Promise<ActionResult> {
  const a = job.action
  if (a.source === 'command') {
    const r = await deps.sh(SCRIPT.watchCommand, [job.worktree, a.command!])
    return commandState(r.code, r.out)
  }
  const r = await deps.sh(SCRIPT.ghRuns, [job.worktree, a.branch ?? '', a.workflow ?? ''])
  if (r.code !== 0) return isTransient(r.code, allText(r)) ? { ok: false, later: true } : { ok: false, error: `pipeline: ${lastLine(errorText(r)) || `exit code ${r.code}`}` }
  let runs: GhRun[]
  try { runs = JSON.parse(r.out.trim().split('\n').pop() || '[]') }
  catch { return { ok: false, later: true } }
  const st = runsState(runs)
  if (st.state === 'running') return { ok: false, later: true }
  if (st.state === 'done') return { ok: true, link: st.link }
  const f = await deps.sh(SCRIPT.ghFailed, [job.worktree, String(st.run.databaseId)])
  const [jobs = '', ...tail] = f.out.split('\n')
  return { ok: false, error: `pipeline: ${st.run.workflowName || 'a run'} failed${jobs.trim() ? ` (${jobs.trim()})` : ''}: ${st.run.url}`, ...(tail.join('\n').trim() ? { detail: tail.join('\n').trim().slice(-2000) } : {}) }
}

// Only after a success: a failed action reached nothing new.
async function leakAlert(deps: ActionDeps, job: ActionJob, result: ActionResult, merged: string[]) {
  const r = await deps.sh(SCRIPT.contains, [job.worktree])
  if (r.code !== 0) return
  const a = job.action
  // What this action itself reached went through its guard; verify-merged only
  // confirms a merge when you said it was done.
  const reached = a.kind === 'git.land' || (a.kind === 'git.verify-merged' && job.by === 'user') ? [a.target!] : []
  const found = leaks(job.guards, r.out.split('\n').map(s => s.trim()).filter(Boolean), [...(job.allowed ?? []), ...reached, ...merged])
  if (found.length) return `${job.task.id}'s commit ${result.commit?.slice(0, 7) || '?'} is on ${found.join(', ')} without a step of yours`
}
