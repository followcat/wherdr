// Runs one engine action in a task's worktree, on its project's machine:
// guard first, receipt before, transient errors tried again (1, 2, 4, 8 min),
// then the alert when the task's commit sits on a protected branch that no
// step of the user and no guarded action put it on.
import { PATH_SETUP, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import type { PmStore } from './pmStore'
import { mayMerge } from '../../shared/pm/guards'
import { CODE, RETRY_MS, SCRIPT, guardAction, isTransient, leaks, prReady, receiptId, type ActionResult, type PrInfo } from '../../shared/pm/actions'
import type { ResolvedGuards } from '../../shared/pm/guards'
import type { MergeBy, StepAction } from '../../shared/pm/workflow'

type Shell = (script: string, args: string[], input?: string) => Promise<{ code: number | null, out: string }>
export interface ActionDeps {
  store: Pick<PmStore, 'receipt' | 'saveReceipt'>
  sh: Shell
  sleep?: (ms: number) => Promise<void>
}
export interface ActionJob {
  task: { id: string, title: string, description: string }
  step: string
  attempt: number // from the step engine's action effect
  action: StepAction
  by: MergeBy // 'user' when the user's gesture started it
  guards: ResolvedGuards
  worktree: string
  branch: string
  allowed?: string[] // protected branches the task already reached through you
  reviewed?: string // github.merge: the commit the last review passed
  halted?: () => Promise<boolean> // the task was stopped meanwhile: no merge
}

// The shell of a project's machine, through herdr-core. stderr is kept: a
// transient error is often only there.
export const actionShell = (deps: Pick<CoreAdminDeps, 'call'>, on: string | undefined): Shell =>
  async (script, args, input) => {
    const r = await exec(deps, on, `${PATH_SETUP}\n${script}`, args, input)
    return { code: r.code, out: [r.out, r.err].filter(Boolean).join('\n') }
  }

const lastLine = (out: string) => out.trim().split('\n').pop()?.trim().slice(0, 300) || ''
const pause = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

export async function runAction(deps: ActionDeps, job: ActionJob): Promise<ActionResult> {
  const { store } = deps
  const id = receiptId(job.task.id, job.step, job.attempt)
  const base = { id, task: job.task.id, step: job.step, action: job.action }
  const prev = await store.receipt(id)
  if (prev?.state === 'done') return prev.result!
  if (prev) {
    await store.saveReceipt({ ...prev, state: 'uncertain' })
    return { ok: false, error: `${job.action.kind} was interrupted before its result was known: check by hand, then try again` }
  }
  const refused = guardAction(job.guards, job.action, { branch: job.branch, by: job.by })
  if (refused) return finish({ ok: false, error: refused })
  await store.saveReceipt({ ...base, state: 'pending', at: Date.now() })
  return finish(await perform(deps, job))

  async function finish({ reached, ...result }: Done) {
    if (result.ok) {
      const alert = await leakAlert(deps, job, result, reached ?? []).catch(() => undefined)
      if (alert) result = { ...result, alert: [result.alert, alert].filter(Boolean).join('. ') }
    }
    await store.saveReceipt({ ...base, state: 'done', result, at: Date.now() })
    return result
  }
}

// Runs a script in the worktree; a transient error is tried again.
async function run(deps: ActionDeps, script: string, args: string[], input?: string) {
  for (let i = 0; ; i++) {
    const r = await deps.sh(script, args, input)
    if (r.code === 0 || !isTransient(r.code, r.out) || i >= RETRY_MS.length) return r
    await (deps.sleep ?? pause)(RETRY_MS[i]!)
  }
}

// reached: the protected branch a guarded merge put the commit on.
type Done = ActionResult & { reached?: string[] }

async function perform(deps: ActionDeps, job: ActionJob): Promise<Done> {
  const { action: a, worktree: wt, branch } = job
  const name = a.kind.split('.')[1]
  const fail = (r: { code: number | null, out: string }): ActionResult =>
    ({ ok: false, error: `${name}: ${r.code === null ? 'timed out' : lastLine(r.out) || `exit code ${r.code}`}`, ...(r.code === CODE.SEND_BACK ? { toAgent: true } : {}) })
  const commit = async (script: string, args: string[]) => {
    const r = await run(deps, script, [wt, ...args])
    return r.code === 0 ? { ok: true, commit: lastLine(r.out) } : fail(r)
  }
  switch (a.kind) {
    case 'git.land': return commit(SCRIPT.land, [a.target!])
    case 'git.push': return commit(SCRIPT.push, [branch])
    case 'git.verify-merged': return commit(SCRIPT.verify, [a.target!, branch])
    case 'github.pr': {
      const r = await run(deps, SCRIPT.pr, [wt, branch, a.base!, `${job.task.id}: ${job.task.title}`], job.task.description || job.task.title)
      return r.code === 0 ? { ok: true, link: lastLine(r.out) } : fail(r)
    }
    case 'github.merge': {
      let pushed = false
      for (let i = 0; ; i++) {
        const r = await run(deps, SCRIPT.prInfo, [wt, branch])
        if (r.code !== 0) return fail(r)
        const lines = r.out.split('\n'), head = lines[0] ?? ''
        let pr: PrInfo | undefined
        try { pr = (JSON.parse(lines.at(-1) || '[]') as PrInfo[])[0] }
        catch { return { ok: false, error: 'merge: unreadable PR details' } }
        // Merged on GitHub already (by hand, or a merge answered with an error): done.
        // Its base counts as reached only where this step could have merged:
        // a protected branch merged outside your gesture still raises the alert.
        if (pr?.merged) {
          const reached = mayMerge(job.guards, pr.baseRefName, job.by) ? [pr.baseRefName] : []
          if (!pr.stray) return { ok: true, link: pr.url, commit: head.trim(), reached, note: 'already merged on GitHub' }
          // Merged at a head without the task's commit: what GitHub merged is recorded, and what it left out is said.
          const h = head.trim().slice(0, 7), m = pr.headRefOid.slice(0, 7)
          return { ok: true, link: pr.url, commit: pr.headRefOid, reached, note: `already merged on GitHub at ${m}, without the task's commit ${h}`,
            alert: `${job.task.id}'s commit ${h} was not merged: its PR was merged on GitHub at ${m} without it. Its later commits need a new branch` }
        }
        const refused = pr && guardAction(job.guards, a, { branch, by: job.by, base: pr.baseRefName })
        if (refused) return { ok: false, error: refused }
        if (pr) {
          const h = head.trim(), at = await run(deps, SCRIPT.headOf, [wt, pr.headRefOid])
          if (at.code !== 0) return fail(at)
          const where = lastLine(at.out)
          if (where === 'foreign') return { ok: false, error: `merge: the PR head ${pr.headRefOid.slice(0, 7)} has commits the task's worktree never had (pushed from elsewhere): bring them into the worktree, or merge by hand` }
          // The head moved after the review (catch-up, conflict, CI fix): reviewed again first.
          if (job.reviewed && job.reviewed !== h) return { ok: false, error: `merge: new commits since the review (${job.reviewed.slice(0, 7)}..${h.slice(0, 7)})`, review: { since: job.reviewed, head: h }, commit: h }
          if (where === 'behind') {
            if (pushed) return { ok: false, error: 'merge: the push did not move the PR head' }
            const no = guardAction(job.guards, { kind: 'git.push' }, { branch, by: job.by })
            if (no) return { ok: false, error: no }
            const up = await run(deps, SCRIPT.push, [wt, branch])
            if (up.code !== 0) return fail(up)
            pushed = true
            continue
          }
        }
        const ready = prReady(pr, head.trim(), a.checks)
        if (!ready.ok && ready.later && i < RETRY_MS.length) { await (deps.sleep ?? pause)(RETRY_MS[i]!); continue }
        if (!ready.ok) return { ok: false, error: `merge: ${ready.why}` }
        if (await job.halted?.()) return { ok: false, error: 'merge: the task was stopped' }
        const m = await run(deps, SCRIPT.merge, [wt, pr!.url, head.trim(), a.method ?? ''])
        return m.code === 0 ? { ok: true, link: pr!.url, commit: head.trim(), reached: [pr!.baseRefName] } : fail(m)
      }
    }
  }
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
