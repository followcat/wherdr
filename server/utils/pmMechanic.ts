// The engine's mechanical moves, every minute (server/plugins/pm.ts): for each
// working or waiting task, the facts (its PR and checks, its agent busy or not,
// a login back), then at most one move (shared/pm/mechanic.ts). A move is
// noted on the task before it runs, so it is never made twice.
import { CODE, SCRIPT, guardAction, taskGuards, type PrInfo } from '../../shared/pm/actions'
import { nextMove, redCiText, type MechFacts, type Move } from '../../shared/pm/mechanic'
import { planSteps } from '../../shared/pm/steps'
import { LABEL, waitOf, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { PATH_SETUP, machineOn } from './coreCreate'
import { actionShell } from './pmActions'
import { stepAction } from './pmBoard'
import { exec, startTask, type PmLaunchDeps } from './pmLaunch'

export const LOGIN_SCRIPT = `export DISABLE_AUTOUPDATER=1; case $1 in claude) claude auth status;; codex) codex login status;; *) exit 2;; esac >/dev/null 2>&1`

const lastLine = (out: string) => out.trim().split('\n').pop()?.trim().slice(0, 300) || ''

const WAITS = { question: 'The agent asks a question', permission: 'The agent asks for a permission', auth: 'The agent is not logged in' } as const

// What each running agent waits for, from its terminal (wherdr.report label or
// a permission prompt): its task waits with that kind, and works again once it is gone.
export async function syncWaits(deps: PmLaunchDeps) {
  const { store } = deps
  const install = await store.install()
  const { terminals } = await deps.call<{ terminals: (LabelledTerminal & { status?: { state?: string } })[] }>('terminal.list', { all: true, labels: { [LABEL.install]: install } }, 8000)
  const runs = await store.runs()
  for (const task of await store.tasks()) {
    const run = runs.find(r => r.id === task.run)
    const term = run?.terminal && run.state !== 'ended' ? terminals.find(x => x.address === run.terminal) : undefined
    if (!term || term.state === 'finished') continue
    const kind = waitOf(term)
    if (task.state === 'working' && kind) await store.saveTask({ ...task, state: 'waiting', waiting: WAITS[kind], waitKind: kind })
    else if (task.state === 'waiting' && (task.waitKind === 'question' || task.waitKind === 'permission') && !kind)
      await store.saveTask({ ...task, state: 'working', waiting: undefined, waitKind: undefined })
  }
}

export async function mechanicTick(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  if (!(await store.enabled())) return []
  await syncWaits(deps).catch(() => {})
  const projects = await store.projects(), runs = await store.runs()
  const made: { task: string, move: Move['kind'] }[] = []
  for (const task of await store.tasks()) {
    if (task.state === 'todo' || task.step?.done) continue
    const p = projects.find(x => x.key === task.project)
    const t = p?.template ? await store.template(p.template) : null
    if (!p || !t) continue
    const run = runs.filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!run) continue
    let on: string | undefined
    try { on = machineOn(deps, p.machine).on } catch { continue }
    const sh = actionShell(deps, on)
    const plan = planSteps(t, { type: task.type, ...(task.prefs ? { prefs: task.prefs } : {}) })
    const facts: MechFacts = { task, plan, guards: taskGuards(t, task.type), branch: run.branch, agentBusy: false }
    if (task.state === 'waiting' && task.waitKind === 'auth') {
      facts.loggedIn = (await exec(deps, on, `${PATH_SETUP}\n${LOGIN_SCRIPT}`, [run.program]).catch(() => null))?.code === 0
    } else if (task.step && plan.slice(0, task.step.at).some(s => s.action?.kind === 'github.pr')) {
      const r = await sh(SCRIPT.prInfo, [run.worktree, run.branch])
      if (r.code !== 0) continue
      const lines = r.out.split('\n')
      try { facts.pr = (JSON.parse(lines.at(-1) || '[]') as PrInfo[])[0] } catch { continue }
      facts.head = lines[0]?.trim()
      const st = run.terminal ? await deps.call<{ status?: string | { state?: string } }>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null) : null
      const s = typeof st?.status === 'string' ? st.status : st?.status?.state
      facts.agentBusy = s === 'working' || s === 'blocked'
    }
    const next = nextMove(facts)
    if (!next) continue
    const noted = await store.saveTask({ ...task, mech: { ...task.mech, [next.key]: now } })
    const text = await perform(deps, noted, run, next.move, facts, sh).catch((e: Error) => `failed: ${e.message}`)
    // Not delivered (the agent's terminal is gone): tried again on a later tick.
    if (text === null) {
      const { [next.key]: _, ...mech } = (await store.task(task.id))!.mech ?? {}
      await store.saveTask({ ...(await store.task(task.id))!, mech })
      continue
    }
    await store.logTask((await store.task(task.id))!, 'engine', `${next.move.kind}: ${text}`)
    made.push({ task: task.id, move: next.move.kind })
  }
  return made
}

async function perform(deps: PmLaunchDeps, task: Task, run: Run, move: Move, f: MechFacts, sh: ReturnType<typeof actionShell>): Promise<string | null> {
  const tell = (text: string) => run.terminal && run.state !== 'ended'
    ? deps.call('terminal.send', { terminal: run.terminal, text }, 30000).then(() => 'sent to the agent', () => null)
    : Promise.resolve(null)
  switch (move.kind) {
    case 'restart':
      // The agent stopped on its login may still sit in its terminal: one agent per task.
      if (run.terminal && run.state !== 'ended') await deps.call('terminal.kill', { terminal: run.terminal }, 15000).catch(() => {})
      await deps.store.saveRun({ ...run, state: 'ended', endedBy: 'exit' })
      await deps.store.saveTask({ ...task, waitKind: undefined })
      return `the login is back; ${(await startTask(deps, task.id)).state}`
    case 'retry-action': case 'merge':
      return `step ${(await stepAction(deps, task.id, 'engine')).step?.yourTurn?.badge ?? 'went on'}`
    case 'fix-base': {
      const refused = guardAction(f.guards, { kind: 'github.pr', base: move.base }, { branch: run.branch, by: 'engine' })
      if (refused) return refused
      const r = await sh(SCRIPT.pr, [run.worktree, run.branch, move.base, `${task.id}: ${task.title}`], task.description || task.title)
      return r.code === 0 ? `PR base set to ${move.base}` : lastLine(r.out)
    }
    case 'catch-up': {
      const r = await sh(SCRIPT.catchUp, [run.worktree, move.base, run.branch])
      if (r.code === CODE.SEND_BACK) return tell(`${lastLine(r.out)}. Merge origin/${move.base} into your branch, fix it, commit, then say you are done.`)
      return r.code === 0 ? `caught up with ${move.base}` : lastLine(r.out)
    }
    case 'rerun-ci': {
      const r = await sh(SCRIPT.rerun, [run.worktree, f.head!])
      return r.code === 0 ? `ran ${move.checks.join(', ')} again` : lastLine(r.out)
    }
    case 'ci-to-agent': return tell(redCiText(move.checks, f.head!))
  }
}
