// Each task's TL;DR (shared/pm/summary.ts), written again on a significant
// change only (its key moved): one task at a time, by Claude Haiku through the
// claude CLI on this machine. While the pace of its Claude account holds
// automatic work it waits, the task marked (tldrHeld: To do shows the notes).
// Every minute (plugins/pm.ts), one task per pass. An agent's question first
// (questionTldr, once per question): the user waits on it.
import { spawn } from 'node:child_process'
import { accountFor } from '../../shared/quotaAccount'
import { DEFAULT_PACE, paceVerdict, type PaceVerdict } from '../../shared/pm/pacing'
import { accountQuota } from '../../shared/pm/pace'
import { taskPlan } from '../../shared/pm/run'
import { cleanTldr, questionKey, questionPrompt, tldrPrompt, tldrSource, TLDR_VERSION } from '../../shared/pm/summary'
import { PATH_SETUP } from './coreCreate'
import type { PmStore } from './pmStore'
import { readQuotas } from './quotas'
import { policyIn, readPolicies } from './pacingPolicies'

export type Summarize = (prompt: string) => Promise<string>
export interface SummaryDeps { store: PmStore, summarize?: Summarize, pace?: (now: number) => Promise<PaceVerdict> }

// A task whose last report or verdict is older keeps its TL;DR as it is, unless
// it was written with an older prompt and the task is still open.
const STALE = 86_400_000
const failed = new Map<string, string>() // task → the key that failed: not tried again until the next one

export async function summaryTick(deps: SummaryDeps, now = Date.now()) {
  if (!(await deps.store.enabled())) return
  const projects = await deps.store.projects(), tasks = await deps.store.tasks()
  let go: boolean | undefined
  const paced = async () => (go ??= (await (deps.pace ?? claudePace)(now)).go)
  for (const task of tasks) {
    const key = task.state === 'waiting' && task.waitKind === 'question' && task.question ? questionKey(task.question) : undefined
    if (!key || task.questionTldr?.key === key || failed.get(task.id) === key) continue
    // Held by the pace: the whole question shows alone meanwhile.
    if (!(await paced())) break
    const text = await (deps.summarize ?? haiku)(questionPrompt(task.title, task.question!)).then(cleanTldr, () => '')
    const fresh = await deps.store.task(task.id)
    if (!text) failed.set(task.id, key)
    else if (fresh?.question && questionKey(fresh.question) === key) await deps.store.saveTask({ ...fresh, questionTldr: { key, text, at: now } })
    return
  }
  for (const task of tasks) {
    const p = projects.find(x => x.key === task.project)
    const t = p ? await deps.store.workflow(p.key) : null
    if (!t) continue
    const src = tldrSource(task, taskPlan(t, task, p))
    if (!src || task.tldr?.key === src.key || failed.get(task.id) === src.key) continue
    const oldPrompt = !!task.tldr && !task.tldr.key.startsWith(`${TLDR_VERSION}|`) && !task.step?.done
    if (now - src.last > STALE && !oldPrompt) continue
    if (!(await paced())) { if (!task.tldrHeld) await deps.store.saveTask({ ...task, tldrHeld: true }); continue }
    const text = await (deps.summarize ?? haiku)(tldrPrompt(src.input)).then(cleanTldr, () => '')
    const fresh = await deps.store.task(task.id)
    if (!text) failed.set(task.id, src.key)
    if (fresh) await deps.store.saveTask({ ...fresh, ...(text ? { tldr: { key: src.key, text, at: now } } : {}), tldrHeld: undefined })
    return // one per pass: the next waits for the next minute
  }
}

// The pace of this machine's Claude account, the one Haiku runs on.
async function claudePace(now: number): Promise<PaceVerdict> {
  const q = await readQuotas().catch(() => null)
  const account = accountFor(q?.accounts, '', 'claude')
  const policy = account ? policyIn(await readPolicies(), account.key) : DEFAULT_PACE
  return paceVerdict(policy, q && account ? accountQuota(q, account) : null, now)
}

// `claude -p` with Haiku, the prompt on its standard input, no tools, no
// session kept; safe mode: the user's CLAUDE.md, hooks and plugins stay out.
const haiku: Summarize = prompt => new Promise((resolve, reject) => {
  const child = spawn('sh', ['-c', `${PATH_SETUP}; exec claude -p --safe-mode --model haiku --tools "" --no-session-persistence`], {
    env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, stdio: ['pipe', 'pipe', 'ignore'],
  })
  let out = ''
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
  child.stdout.on('data', (b: Buffer) => { if (out.length < 20_000) out += b.toString('utf8') })
  child.on('error', reject)
  child.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`claude exited with ${code}`)) })
  child.stdin.on('error', () => {})
  child.stdin.end(prompt)
})
