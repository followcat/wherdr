// The engine's mechanical moves, every minute (server/plugins/pm.ts): for each
// working or waiting task, the facts (its PR and checks, its agent busy or not,
// a login back), then at most one move (shared/pm/mechanic.ts). A move is
// noted on the task before it runs, so it is never made twice.
import { CODE, SCRIPT, guardAction, taskGuards, type PrInfo } from '../../shared/pm/actions'
import { nextMove, redCiText, type MechFacts, type Move } from '../../shared/pm/mechanic'
import { LABEL, taskPlan, trustPrompt, waitOf, type LabelledTerminal, type Run, type Task } from '../../shared/pm/run'
import { PATH_SETUP, machineOn } from './coreCreate'
import { actionShell } from './pmActions'
import { prSeen, stepAction } from './pmBoard'
import { prNow, requiredChecks } from '../../shared/pm/board'
import { exec, startTask, type PmLaunchDeps } from './pmLaunch'
import { coordinatorStartRefusal } from '../../shared/pm/autopilot'
import { originOf, pacedStart, paceRefusal } from '../../shared/pm/pace'
import { projectPace } from './pmPace'
import { CHAIN_WAIT, chainState } from '../../shared/pm/advance'
import { advanceTick } from './pmAdvance'
import { forgetMemory, memoryHold } from './pmMemory'

export const LOGIN_SCRIPT = `export DISABLE_AUTOUPDATER=1; case $1 in claude) claude auth status;; codex) codex login status;; *) exit 2;; esac >/dev/null 2>&1`

const lastLine = (out: string) => out.trim().split('\n').pop()?.trim().slice(0, 300) || ''

const WAITS = { question: 'The agent asks a question', permission: 'The agent asks for a permission', auth: 'The agent is not logged in' } as const

// What each running agent waits for, from its terminal (wherdr.report label or
// a permission prompt): its task waits with that kind, and works again once it is gone.
const trusted = new Set<string>() // runs whose trust dialog the engine answered
export async function syncWaits(deps: PmLaunchDeps) {
  const { store } = deps
  const install = await store.install()
  const { terminals } = await deps.call<{ terminals: (LabelledTerminal & { status?: { state?: string, msg?: string } })[] }>('terminal.list', { all: true, labels: { [LABEL.install]: install } }, 8000)
  const runs = await store.runs()
  // A new agent stopped on the folder trust dialog of its own worktree (no status yet): "Yes".
  for (const run of runs.filter(r => r.terminal && r.state !== 'ended' && Date.now() - r.startedAt < 10 * 60_000)) {
    const term = terminals.find(x => x.address === run.terminal)
    if (!term || term.state === 'finished' || term.status?.state || trusted.has(run.id)) continue
    const screen = String((await deps.call<{ text?: string }>('terminal.read', { terminal: run.terminal, lines: 30 }, 3000).catch(() => null))?.text || '')
    if (!trustPrompt(screen, run.worktree)) continue
    trusted.add(run.id)
    await deps.call('terminal.keys', { terminal: run.terminal, keys: ['down', 'enter'] }, 10000).catch(() => {})
    const task = await store.task(run.task)
    if (task) await store.logTask(task, 'engine', `trusted the task's worktree for the ${run.role} (${run.worktree})`)
  }
  for (const task of await store.tasks()) {
    const run = runs.find(r => r.id === task.run)
    const term = run?.terminal && run.state !== 'ended' ? terminals.find(x => x.address === run.terminal) : undefined
    if (!term || term.state === 'finished') continue
    const kind = waitOf(term)
    // What herdr-core says is asked ("approve Bash: npm test"), else the kind.
    const msg = typeof term.status === 'object' ? term.status?.msg?.trim().slice(0, 300) : undefined
    if (task.state === 'working' && kind) await store.saveTask({ ...task, state: 'waiting', waiting: (kind === 'permission' && msg) || WAITS[kind], waitKind: kind })
    else if (task.state === 'waiting' && (task.waitKind === 'question' || task.waitKind === 'permission') && !kind)
      await store.saveTask({ ...task, state: 'working', waiting: undefined, waitKind: undefined })
  }
}

// A task with "after" starts once those tasks are done, within its
// coordinator's autopilot limits and hours (one per tick and project): the
// order is the user's. One of them failed or stopped: it waits for the user, with why.
export async function startChained(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const tasks = await store.tasks(), runs = await store.runs(), started: string[] = []
  for (const t of tasks.filter(x => x.after && !x.step?.started)) {
    const c = chainState(t, tasks)
    const held = c && c !== 'go' ? c.wait : undefined
    if (t.state === 'todo' && held) await store.logTask({ ...t, state: 'waiting', waiting: held }, 'engine', held)
    // Held by its chain, and the task before it goes on again: to do, the engine starts it once that one is done.
    else if (t.state === 'waiting' && !held && t.waiting?.includes(CHAIN_WAIT)) await store.logTask({ ...t, state: 'todo', waiting: undefined }, 'engine', 'to do again: the tasks before it go on')
  }
  for (const p of await store.projects()) {
    const ap = (await store.coordinator(p.key))?.autopilot
    const mine = (await store.tasks()).filter(t => t.project === p.key)
    // A chain the coordinator or an automation made is automatic work: held by the pace.
    let next: typeof mine[number] | undefined
    for (const t of mine.filter(x => x.after && x.state === 'todo')) {
      const pace = pacedStart(t, 'engine') ? (await projectPace(store, p.key, t, now))?.verdict : undefined
      if (!coordinatorStartRefusal(ap, t, mine, runs, now, false, { pace, engine: true })) { next = t; break }
    }
    if (!next) continue
    // Short on memory: held, with why on its card, until a later tick finds memory back.
    const held = await memoryHold(deps, p.key)
    if (held) { if (next.held !== held) await store.logTask({ ...next, held }, 'engine', held); continue }
    forgetMemory(p.machine)
    const r = await startTask(deps, next.id).catch((e: Error) => ({ ...next, state: 'waiting' as const, waiting: e.message }))
    await store.logTask((await store.task(next.id))!, 'engine', r.state === 'working' ? `started: ${next.after} done` : `could not start after ${next.after}: ${r.waiting ?? ''}`)
    started.push(next.id)
  }
  return started
}

// Tasks a wake or an automation would have started, held for memory: each
// starts once its machine has memory back, one per machine and tick (the next
// reading counts the new agent). Chained ones are startChained's. A wake's task
// still holds to its autopilot (on, limits, hours, pace), an automation's to
// the pace: over a limit it waits, with why; the autopilot off drops the hold.
export async function startHeld(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  const projects = await store.projects(), runs = await store.runs(), started: string[] = [], machines = new Set<string>()
  for (const t of (await store.tasks()).filter(x => x.held && x.state === 'todo' && !x.after)) {
    const p = projects.find(x => x.key === t.project)
    if (!p || machines.has(p.machine)) continue
    const pace = pacedStart(t, 'wake') ? (await projectPace(store, p.key, t, now))?.verdict : undefined
    const why = originOf(t) === 'automation' ? paceRefusal(pace)
      : coordinatorStartRefusal((await store.coordinator(p.key))?.autopilot, t, (await store.tasks()).filter(x => x.project === p.key), runs, now, true, { pace })
    if (why && /autopilot on/.test(why)) { await store.logTask({ ...t, held: undefined }, 'engine', `no longer held: ${why}`); continue }
    const held = why ? `Waits: ${why}` : await memoryHold(deps, p.key)
    if (held) { if (held !== t.held) await store.saveTask({ ...t, held }); continue }
    machines.add(p.machine)
    forgetMemory(p.machine)
    const r = await startTask(deps, t.id).catch((e: Error) => ({ ...t, state: 'waiting' as const, waiting: e.message }))
    await store.logTask((await store.task(t.id))!, 'engine', r.state === 'working' ? 'started: memory is back' : `could not start: ${r.waiting ?? ''}`)
    started.push(t.id)
  }
  return started
}

export async function mechanicTick(deps: PmLaunchDeps, now = Date.now()) {
  const { store } = deps
  if (!(await store.enabled())) return []
  await syncWaits(deps).catch(() => {})
  await advanceTick(deps, now).catch(() => {})
  await startChained(deps, now).catch(() => {})
  await startHeld(deps, now).catch(() => {})
  const projects = await store.projects(), runs = await store.runs()
  const made: { task: string, move: Move['kind'] }[] = []
  for (const task of await store.tasks()) {
    if (task.state === 'todo' || task.step?.done) { prSeen.delete(task.id); continue }
    const p = projects.find(x => x.key === task.project)
    const t = p ? await store.workflow(p.key) : null
    if (!p || !t) continue
    const run = runs.filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!run) continue
    let on: string | undefined
    try { on = machineOn(deps, p.machine).on } catch { continue }
    const sh = actionShell(deps, on)
    const plan = taskPlan(t, task, p)
    const facts: MechFacts = { task, plan, guards: taskGuards(t, task.type), branch: run.branch, agentBusy: false }
    if (task.state === 'waiting' && task.waitKind === 'auth') {
      facts.loggedIn = (await exec(deps, on, `${PATH_SETUP}\n${LOGIN_SCRIPT}`, [run.program]).catch(() => null))?.code === 0
    } else if (task.step && plan.slice(0, task.step.at).some(s => s.action?.kind === 'github.pr')) {
      const r = await sh(SCRIPT.prInfo, [run.worktree, run.branch])
      if (r.code !== 0) continue
      const lines = r.out.split('\n')
      try { facts.pr = (JSON.parse(lines.at(-1) || '[]') as PrInfo[])[0] } catch { continue }
      facts.head = lines[0]?.trim()
      const seen = prNow(facts.pr, requiredChecks(plan))
      if (seen) prSeen.set(task.id, seen)
      else prSeen.delete(task.id)
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
