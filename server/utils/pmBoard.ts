// The board's data, and the user's button on a step that waits for them.
import { boardColumns, cardOf, type Board } from '../../shared/pm/board'
import { initialState, onEvent, planSteps } from '../../shared/pm/steps'
import { taskGuards, type ActionResult } from '../../shared/pm/actions'
import type { Template } from '../../shared/pm/workflow'
import { addShot, isImage, SHOT_TYPES, type Shot } from '../../shared/pm/shots'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Task } from '../../shared/pm/run'
import { actionShell, runAction } from './pmActions'
import { machineOn, type CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import type { PmStore } from './pmStore'

const planOf = (t: Template | null, task: Task) => (t ? planSteps(t, { type: task.type, ...(task.prefs ? { prefs: task.prefs } : {}) }) : [])

async function templatesOf(store: PmStore) {
  const out = new Map<string, Template | null>()
  for (const p of await store.projects()) out.set(p.key, p.template ? await store.template(p.template) : null)
  return out
}

export async function board(store: PmStore): Promise<Board> {
  const [projects, templates, tasks, runs] = [await store.projects(), await templatesOf(store), await store.tasks(), await store.runs()]
  return {
    projects: projects.map((p) => {
      const t = templates.get(p.key)
      return { key: p.key, name: p.name, columns: t ? boardColumns(Object.keys(t.taskTypes).map(type => planSteps(t, { type }))) : [] }
    }),
    cards: tasks.map(task => cardOf(task, planOf(templates.get(task.project) ?? null, task), runs)),
  }
}

// The step's userLabel button: the same 'user' event as "it is merged" said
// by the user. A step with an action (git.verify-merged) runs it at once,
// started by the user, and its result moves the task on or back to Your turn.
export async function userStep(deps: CoreAdminDeps & { store: PmStore }, id: unknown): Promise<Task> {
  const { store } = deps
  const task = await store.task(id)
  if (!task) throw new HerdrError('not_found', 'Unknown task')
  const p = (await store.projects()).find(x => x.key === task.project)
  const t = p?.template ? await store.template(p.template) : null
  if (!p || !t) throw new HerdrError('not_found', 'The project has no template')
  const plan = planOf(t, task)
  const r = onEvent(plan, task.step ?? initialState(), { kind: 'user' }, Date.now())
  if (r.refused) throw new HerdrError('refused', r.refused)
  let state = r.state
  const act = r.effects.find(e => e.kind === 'action')
  if (act?.kind === 'action') {
    await store.saveTask({ ...task, step: state }) // checking, before the action runs
    const run = (await store.runs()).filter(x => x.task === task.id && x.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]
    const result: ActionResult = run
      ? await runAction({ store, sh: actionShell(deps, machineOn(deps, p.machine).on) }, {
          task, step: act.step, attempt: act.attempt, action: act.action, by: 'user', guards: taskGuards(t, task.type), worktree: run.worktree, branch: run.branch,
        }).catch((e: Error) => ({ ok: false, error: e.message }))
      : { ok: false, error: 'No worktree: the task never started' }
    const evidence = { ...(result.link ? { link: result.link } : {}), ...(result.commit ? { commit: result.commit } : {}) }
    state = onEvent(plan, state, { kind: 'action-result', ok: result.ok, ...(result.error ? { error: result.error } : {}), evidence }, Date.now()).state
  }
  return store.saveTask({ ...task, step: state })
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
  const plan = planOf(p?.template ? await store.template(p.template) : null, task)
  const shot: Shot = { file: `${randomUUID().replace(/-/g, '').slice(0, 12)}.${ext}`, phase, at: Date.now() }
  await store.addShot(task.id, shot.file, data, (fresh) => {
    const r = addShot(plan, fresh.step, shot)
    if ('refused' in r) throw new HerdrError('refused', r.refused)
    return { ...fresh, step: r.state }
  })
  return shot
}
