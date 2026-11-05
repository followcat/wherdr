// Runs one engine action in a task's worktree, on its project's machine:
// guard first, receipt before, transient errors tried again (1, 2, 4, 8 min),
// then the alert when the task's commit sits on a protected branch that no
// step of the user and no guarded action put it on.
import { PATH_SETUP, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import type { PmStore } from './pmStore'
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
      if (alert) result = { ...result, alert }
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
      for (let i = 0; ; i++) {
        const r = await run(deps, SCRIPT.prInfo, [wt, branch])
        if (r.code !== 0) return fail(r)
        const lines = r.out.split('\n'), head = lines[0] ?? ''
        let pr: PrInfo | undefined
        try { pr = (JSON.parse(lines.at(-1) || '[]') as PrInfo[])[0] }
        catch { return { ok: false, error: 'merge: unreadable PR details' } }
        const refused = pr && guardAction(job.guards, a, { branch, by: job.by, base: pr.baseRefName })
        if (refused) return { ok: false, error: refused }
        const ready = prReady(pr, head.trim())
        if (!ready.ok && ready.later && i < RETRY_MS.length) { await (deps.sleep ?? pause)(RETRY_MS[i]!); continue }
        if (!ready.ok) return { ok: false, error: `merge: ${ready.why}` }
        const m = await run(deps, SCRIPT.merge, [wt, pr!.url, head.trim()])
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
