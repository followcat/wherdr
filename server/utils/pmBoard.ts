// The board's data, and the user's button on a step that waits for them.
import { boardColumns, cardOf, type Board, type Card } from '../../shared/pm/board'
import { initialState, onEvent, planSteps, reviewedCommit, type StepEvent } from '../../shared/pm/steps'
import { taskGuards, type ActionResult } from '../../shared/pm/actions'
import type { MergeBy, Template } from '../../shared/pm/workflow'
import { addShot, isImage, SHOT_TYPES, type Shot } from '../../shared/pm/shots'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { taskPlan, type Task } from '../../shared/pm/run'
import type { Project } from '../../shared/pm/project'
import { shownTaskId } from '../../shared/pm/projectKey'
import { CHOICES, type Choice } from '../../shared/pm/verdict'
import { actionShell, runAction } from './pmActions'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import type { PmStore } from './pmStore'

const planOf = (t: Template | null, task: Task, p?: Project) => (t ? taskPlan(t, task, p) : [])

async function templatesOf(store: PmStore) {
  const out = new Map<string, Template | null>()
  for (const p of await store.projects()) out.set(p.key, p ? await store.workflow(p.key) : null)
  return out
}

// What the mechanic last read of each task's PR (prNow), for the cards' status
// line. In memory: read again within a minute of a restart.
export const prSeen = new Map<string, string>()
const withPr = (c: Card): Card => (prSeen.has(c.id) ? { ...c, prNow: prSeen.get(c.id)! } : c)

export async function board(store: PmStore): Promise<Board> {
  const [projects, templates, tasks, runs] = [await store.projects(), await templatesOf(store), await store.tasks(), await store.runs()]
  return {
    projects: projects.map((p) => {
      const t = templates.get(p.key)
      const plans = t ? Object.keys(t.taskTypes).map(type => ({ id: type, steps: planSteps(t, { type }, p.base) })) : []
      return { key: p.key, ...(p.label ? { label: p.label } : {}), ...(p.aliases ? { aliases: p.aliases } : {}), ...(p.color ? { color: p.color } : {}), name: p.name, columns: boardColumns(plans.map(x => x.steps)), types: plans.map(x => ({ id: x.id, plan: x.steps.map(s => s.id).join(' → ') })) }
    }),
    cards: tasks.map(task => withPr({ ...cardOf(task, planOf(templates.get(task.project) ?? null, task, projects.find(p => p.key === task.project)), runs), shown: shownTaskId(projects, task.id) })),
  }
}

// The step's userLabel button: the same 'user' event as "it is merged" said
// by the user. A step with an action (git.verify-merged) runs it at once,
// started by the user, and its result moves the task on or back to Your turn.
export const userStep = (deps: CoreAdminDeps & { store: PmStore }, id: unknown) => stepAction(deps, id, 'user')

// by 'engine': a failed action tried again, or one entered and not run yet
// (a merge the branch rule gives the engine); its guard is checked again.
// Tasks whose engine action runs now: one at a time (the user's gesture, the engine's pass).
const running = new Set<string>()
export async function stepAction(deps: CoreAdminDeps & { store: PmStore }, id: unknown, by: MergeBy): Promise<Task> {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  if (task.stopped) throw new HerdrError('refused', 'The task is stopped: continue it first')
  if (running.has(task.id)) throw new HerdrError('busy', 'Already checking')
  running.add(task.id)
  try { return await stepActionOf(deps, task, by) } finally { running.delete(task.id) }
}

async function stepActionOf(deps: CoreAdminDeps & { store: PmStore }, task: Task, by: MergeBy): Promise<Task> {
  const { store } = deps
  const p = (await store.projects()).find(x => x.key === task.project)
  const t = p ? await store.workflow(p.key) : null
  if (!p || !t) throw new HerdrError('not_found', 'The project has no template')
  const plan = planOf(t, task, p)
  const cur = task.step ?? initialState()
  const step = plan[cur.at]
  const r = by === 'engine' && cur.acting && step?.action
    ? { state: cur, effects: [{ kind: 'action' as const, step: step.id, action: step.action, attempt: cur.tries?.[step.id] ?? 1 }] }
    : onEvent(plan, cur, { kind: 'user' }, Date.now())
  if ('refused' in r && r.refused) throw new HerdrError('refused', r.refused)
  let state = r.state
  const act = r.effects.find(e => e.kind === 'action')
  if (act?.kind === 'action') {
    await store.saveTask({ ...task, step: state }) // checking, before the action runs
    const run = (await store.runs()).filter(x => x.task === task.id && x.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    const result: ActionResult = run
      ? await runAction({ store, sh: actionShell(deps, machineOn(deps, p.machine).on) }, {
          task, step: act.step, attempt: act.attempt, action: act.action, by, guards: taskGuards(t, task.type), worktree: run.worktree, branch: run.branch,
          reviewed: reviewedCommit(plan, state),
          halted: async () => !!(await store.task(task.id))?.stopped,
        }).catch((e: Error) => ({ ok: false, error: e.message }))
      : { ok: false, error: 'No worktree: the task never started' }
    const evidence = { ...(result.link ? { link: result.link } : {}), ...(result.commit ? { commit: result.commit } : {}) }
    const back = onEvent(plan, state, { kind: 'action-result', ok: result.ok, ...(result.error ? { error: result.error } : {}), ...(result.review ? { review: result.review } : {}), evidence }, Date.now())
    state = back.state
    const log = back.effects.find(e => e.kind === 'log')
    if (log?.kind === 'log') return store.logTask({ ...(await store.task(task.id) ?? task), step: state }, 'engine', log.text)
    const said = [result.note, result.alert].filter(Boolean).join('. ')
    if (said) return store.logTask({ ...(await store.task(task.id) ?? task), step: state }, 'engine', `${act.step}: ${said}`)
  }
  return store.saveTask({ ...(await store.task(task.id) ?? task), step: state })
}

// The user's choice on a review the after-N rule handed to them (Decisions):
// any choice, like the coordinator's `task decide` but not limited to its options.
export async function userDecide(store: PmStore, id: unknown, choice: unknown) {
  if (!CHOICES.includes(choice as Choice)) throw new HerdrError('bad_input', `choice: one of ${CHOICES.join(', ')}`)
  return userEvent(store, id, { kind: 'decide', by: 'user', choice: choice as Choice })
}

// The user sends their step (a visual merge) back to the worker, saying what to change.
export async function userSendBack(store: PmStore, id: unknown, note: unknown) {
  if (typeof note !== 'string' || note.length > 2000) throw new HerdrError('bad_input', 'note: what to change, 2000 characters at most')
  return userEvent(store, id, { kind: 'back', note })
}

async function userEvent(store: PmStore, id: unknown, ev: StepEvent) {
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const p = (await store.projects()).find(x => x.key === task.project)
  const t = p ? await store.workflow(p.key) : null
  if (!t) throw new HerdrError('not_found', 'The project has no template')
  const r = onEvent(planOf(t, task, p), task.step ?? initialState(), ev, Date.now())
  if (r.refused) throw new HerdrError('refused', r.refused)
  return store.logTask({ ...task, step: r.state }, 'user', r.effects.flatMap(e => (e.kind === 'log' ? [e.text] : [])).join('; '))
}

const sameKey = (a: string | undefined, b: unknown) =>
  !!a && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// An agent's screenshot for its current step (POST /api/pm/shot), kept with
// the task's data. `token`: the task's key, written in the agent's instructions file.
export async function uploadShot(store: PmStore, id: unknown, phase: unknown, data: Buffer, ctype: string, token: unknown): Promise<Shot> {
  const task = await store.task(id)
  // An unknown task and a wrong key answer the same.
  if (!task || !sameKey(task.shotToken, token)) throw new HerdrError('forbidden', 'Unknown task or wrong screenshot key')
  const ext = SHOT_TYPES[ctype]
  if (!ext || !isImage(data, ext)) throw new HerdrError('bad_input', 'A PNG, JPEG or WebP image, matching its Content-Type')
  if (phase !== 'before' && phase !== 'after') throw new HerdrError('bad_input', 'phase: before or after')
  const p = (await store.projects()).find(x => x.key === task.project)
  const plan = planOf(p ? await store.workflow(p.key) : null, task, p)
  const shot: Shot = { file: `${randomUUID().replace(/-/g, '').slice(0, 12)}.${ext}`, phase, at: Date.now() }
  await store.addShot(task.id, shot.file, data, (fresh) => {
    const r = addShot(plan, fresh.step, shot)
    if ('refused' in r) throw new HerdrError('refused', r.refused)
    return { ...fresh, step: r.state }
  })
  return shot
}
