// A project coordinator on the server: its token (one per project, scoped to
// it), where its current turn comes from, the `wherdr pm` commands it runs,
// and its role files, written in its own folder on the project's machine.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { MAIN, canRunCoordinator, coordinatorArgs, isCoordinatorProgram, promptAsArg, mainRoleFiles, parseCommand, roleFiles, stepDoneEvent, templateDiff, templateEditRefusal, type CoordinatorAgent, type CoordinatorProgram, type CoordinatorView, type ProposalOutcome, type Turn } from '../../shared/pm/coordinator'
import { initialState, onEvent, planSteps, currentStep } from '../../shared/pm/steps'
import { templateChanges } from '../../shared/pm/templateText'
import { validateTemplate } from '../../shared/pm/workflow'
import { EXAMPLES } from '../../shared/pm/examples'
import { DEFAULT_AUTOPILOT, LOOK_PER_DAY, USER_ONLY, addRefusal, bump, coordinatorStartRefusal, limitsLeft, lookAddRefusal, scheduledWake, tellRefusal, today, type Autopilot } from '../../shared/pm/autopilot'
import { ackWakes } from '../../shared/pm/wakes'
import { automationLine } from '../../shared/pm/automations'
import type { Template } from '../../shared/pm/workflow'
import type { Project } from '../../shared/pm/project'
import { projectOf, shownKey, shownTaskId } from '../../shared/pm/projectKey'
import { taskPlan, waitOf, type Task } from '../../shared/pm/run'
import { HerdrError } from './herdr'
import { PATH_SETUP, homeOf, machineOn, sendAfterDialog, sendFirstMessage, type CoreAdminDeps } from './coreCreate'
import { WRITE_SCRIPT, exec, startTask } from './pmLaunch'
import { actionShell } from './pmActions'
import { SCRIPT } from '../../shared/pm/actions'
import { PR_FIELDS, prMergeAskRefusal, prMergeRefusal, type ContributorPr } from '../../shared/pm/contributorPr'
import { userStep } from './pmBoard'
import { ensureVisibility } from './pmVisibility'
import { removeTask, resumeTask, stopTask } from './pmStop'
import { resumeRefusal } from '../../shared/pm/stop'
import { pacedStart, paceLine } from '../../shared/pm/pace'
import { memoryHold, memoryState } from './pmMemory'
import { projectPace } from './pmPace'
import type { CoordinatorRecord, PmStore } from './pmStore'
import { OWN_FILES, alfredFiles, alfredName, isAlfredProgram, startPrompt } from '../../shared/pm/alfred'
import { APP_URL_FILE, DATA_DIR, ENV_APP_URL } from './env'
import pkg from '../../package.json'

// alfredHome: Alfred's home folder (DATA_DIR/alfred by default).
type Deps = CoreAdminDeps & { store: PmStore, alfredHome?: string }
const homeOfAlfred = (deps: { alfredHome?: string }) => deps.alfredHome ?? path.join(DATA_DIR, 'alfred')
const sha = (s: string) => createHash('sha256').update(s).digest()

// A new token for the project's coordinator; the one before stops working.
export async function issueToken(store: PmStore, key: string) {
  const token = randomBytes(32).toString('hex')
  // Its settings stay (default agent, autopilot, pending change…); its turn,
  // terminal and agent that ran are the old conversation's.
  const { turn: _turn, terminal: _terminal, ran: _ran, tokenHash: _hash, ...keep } = (await store.coordinator(key)) ?? {}
  await store.saveCoordinator({ ...keep, project: key, tokenHash: sha(token).toString('hex') })
  return token
}

// The project a token belongs to, or null.
export async function scopeOf(store: PmStore, token: unknown) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null
  const h = sha(token)
  for (const c of await store.coordinators())
    if (/^[0-9a-f]{64}$/.test(c.tokenHash) && timingSafeEqual(Buffer.from(c.tokenHash, 'hex'), h)) return c.project
  return null
}

// Alfred's token for `wherdr alfred` (server/utils/alfredCli.ts): a new one
// in a file of its home (mode 600) at each start, the one before stops working.
export const ALFRED_TOKEN_FILE = '.alfred-token'
export async function issueAlfredToken(store: PmStore, home: string) {
  const token = randomBytes(32).toString('hex'), file = path.join(home, ALFRED_TOKEN_FILE)
  await fs.writeFile(file, `${token}\n`, { mode: 0o600 })
  await fs.chmod(file, 0o600)
  await store.saveCoordinator({ project: MAIN, tokenHash: '', ...(await store.coordinator(MAIN)), cliHash: sha(token).toString('hex') })
}
export async function alfredTokenOk(store: PmStore, token: unknown) {
  const h = (await store.coordinator(MAIN))?.cliHash
  return typeof token === 'string' && /^[0-9a-f]{64}$/.test(token) && /^[0-9a-f]{64}$/.test(h ?? '') && timingSafeEqual(Buffer.from(h!, 'hex'), sha(token))
}

// Called by whatever delivers a message to the coordinator: the user's
// message from the interface (with its text) or an engine wake.
// look: a look-for-new-work wake, whose turn counts the tasks it adds.
export async function noteTurn(store: PmStore, key: string, kind: 'user' | 'wake', said?: string, look = false) {
  const c = await store.coordinator(key)
  if (!c) throw new HerdrError('not_found', 'No coordinator for this project')
  const at = Date.now()
  await store.saveCoordinator({ ...c, turn: { kind, at, ...(kind === 'user' && said ? { said: said.slice(0, 500) } : {}), ...(kind === 'wake' && look ? { look: true as const } : {}) }, ...(kind === 'user' ? { userAt: at } : {}) })
}

const TURN_MS = 3_600_000

// The user's message sent from the interface to a terminal: when that
// terminal is a project coordinator, its turn now comes from the user.
export async function userMessageTo(store: PmStore, terminal: string | undefined, text: string) {
  if (!terminal || !(await store.enabled())) return
  const c = (await store.coordinators()).find(x => x.terminal === terminal)
  if (c) await noteTurn(store, c.project, 'user', text)
}

// The branch tasks start from, open their PR to and merge into when a step names none.
const workingBranch = (p?: Project) => p?.base || 'not set: tasks start from the repository\'s current branch, and a step without a branch has none'
const planOf = (t: Template, task: Task, p?: Project) => taskPlan(t, task, p)
const summary = (t: Template | null, task: Task, p?: Project) => {
  const step = t ? currentStep(planOf(t, task, p), task.step ?? initialState()) : undefined
  return { id: p ? shownTaskId([p], task.id) : task.id, title: task.title, type: task.type, state: task.step?.abandoned ? 'abandoned' : task.step?.done ? 'done' : task.stopped ? 'stopped' : task.state, ...(task.stopped ? { stopped: task.stopped } : {}), step: step?.id, holder: step?.holder, yourTurn: task.step?.yourTurn?.badge, tags: task.tags, links: task.links, ...(task.after ? { after: task.after } : {}) }
}

const unb64 = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('utf8') : v)

// POST /api/pm/cli: { argv, input? } with the coordinator's token, or
// { argv64, input64 } from the folder's `wherdr` script. A project's token
// acts on its project only; the main coordinator's on every project.
export async function runCommand(deps: Deps, token: unknown, body: { argv?: unknown, input?: unknown, argv64?: unknown, input64?: unknown }) {
  const { store } = deps
  const scope = await scopeOf(store, token)
  if (!scope) throw new HerdrError('forbidden', 'Unknown coordinator token')
  const main = scope === MAIN
  if (Array.isArray(body.argv64)) body = { argv: body.argv64.map(unb64), input: unb64(body.input64) }
  const words = Array.isArray(body.argv) ? body.argv.filter(a => typeof a === 'string' && !a.startsWith('--')) : []
  const userOnly = USER_ONLY[words.slice(0, 2).join(' ')] ?? USER_ONLY[words[0] ?? '']
  if (userOnly) throw new HerdrError('refused', userOnly)
  const cmd = parseCommand(body.argv)
  if ('error' in cmd) throw new HerdrError('bad_input', cmd.error)
  const projects = await store.projects()
  // A project named by any of its keys (WD, or WHR before its rename).
  const named = cmd.project ? projectOf(projects, cmd.project)?.key ?? cmd.project : undefined
  if (!main && named && named !== scope) throw new HerdrError('refused', `Your token acts on project ${scope} only`)
  // Another project's task reads as unknown to a project's token.
  const taskOf = async (id: string) => {
    const task = await store.task(id)
    if (!task || (!main && task.project !== scope)) throw new HerdrError('not_found', 'Unknown task')
    return task
  }
  // The command's project: its task's, the one named, or the token's.
  const key = 'task' in cmd ? (await taskOf(cmd.task)).project : named ?? (main ? '' : scope)
  const p = projects.find(x => x.key === key)
  if (key && !p) throw new HerdrError('not_found', 'Unknown project')
  const t = p ? await store.workflow(p.key) : null
  const rec = await store.coordinator(scope)
  // A turn the server saw start over an hour ago is not trusted any more.
  const turn: Turn = rec?.turn && Date.now() - rec.turn.at < TURN_MS ? rec.turn.kind : 'none'
  const by = main ? 'main coordinator' : `coordinator ${key}`
  const needProject = () => { if (!p) throw new HerdrError('bad_input', `Name the project: --project <KEY> (${projects.map(shownKey).join(', ')})`); return p }
  const needPlan = () => { needProject(); if (!t) throw new HerdrError('not_found', 'The project has no template'); return t }
  // The tasks the token's limits count: its project's, or every task for the main coordinator.
  const mineOf = async () => (await store.tasks()).filter(x => main || x.project === key)

  switch (cmd.name) {
    case 'list': {
      const ts = new Map(await Promise.all(projects.map(async x => [x.key, x ? await store.workflow(x.key) : null] as const)))
      return { tasks: (await store.tasks()).filter(x => !key || x.project === key).map(x => summary(ts.get(x.project) ?? null, x, projects.find(y => y.key === x.project))) }
    }
    case 'show': { const task = await taskOf(cmd.task); return { task: { ...summary(t, task, p), description: task.description, log: task.log ?? [] }, plan: t ? planOf(t, task, p) : [] } }
    case 'plan': return { template: t && { id: t.id, version: t.version }, workingBranch: workingBranch(p), plans: Object.fromEntries(Object.keys(needPlan().taskTypes).map(type => [type, planSteps(t!, { type }, p?.base)])) }
    case 'template show': return {
      template: needPlan(),
      ...(main ? {} : rec?.proposal ? { proposal: 'waiting for the user in wherdr', diff: rec.proposal.diff } : rec?.answered ? { lastProposal: rec.answered.outcome } : {}),
    }
    case 'template edit': {
      if (main) throw new HerdrError('refused', 'template edit is the project coordinator\'s or the user\'s: add a task or tell the user')
      let next: Template
      try { next = JSON.parse(String(body.input ?? '')) as Template } catch { throw new HerdrError('bad_input', 'The new template is not valid JSON') }
      // Always the project's own workflow, whatever id the JSON names.
      if (t && next && typeof next === 'object') next = { ...next, id: t.id }
      editRefusal(t, next, turn)
      const errors = validateTemplate(next)
      if (errors.length) throw new HerdrError('bad_input', errors.map(e => `${e.path}: ${e.message}`).join('; '))
      // The user accepts or refuses it in the interface; nothing is saved yet.
      const proposal = { template: next, diff: templateDiff(t, next), at: Date.now(), base: t!.version ?? 1, ...(rec?.turn?.said ? { said: rec.turn.said } : {}) }
      await store.saveCoordinator({ ...rec!, proposal })
      return { proposed: true, changes: templateChanges(t, next), diff: proposal.diff, next: 'The user accepts or refuses this diff in wherdr; template show tells you what they chose' }
    }
    case 'task tag': {
      const task = await taskOf(cmd.task)
      if ((task.tags ?? []).includes(cmd.text)) return { task }
      return { task: await store.logTask({ ...task, tags: [...(task.tags ?? []), cmd.text].slice(-20) }, by, `tag ${cmd.text}`) }
    }
    case 'task link': {
      const task = await taskOf(cmd.task)
      const links = [...(task.links ?? []).filter(l => l.url !== cmd.url), { label: cmd.label, url: cmd.url }].slice(-20)
      return { task: await store.logTask({ ...task, links }, by, `link ${cmd.label} ${cmd.url}`) }
    }
    case 'step done': {
      const task = await taskOf(cmd.task)
      const plan = planOf(needPlan(), task, p)
      const state = task.step ?? initialState()
      const ev = stepDoneEvent(currentStep(plan, state), cmd, turn)
      if ('refused' in ev) throw new HerdrError('refused', ev.refused)
      const step = currentStep(plan, state)!.id
      // The user's words: the same path as the step's button (runs its check).
      // The log keeps the user's own message (the turn's), not the coordinator's quote.
      if (ev.kind === 'user') return { task: await store.logTask(await userStep(deps, task.id), by, `${step}: done on the user's message "${rec?.turn?.said ?? ''}"`) }
      const r = onEvent(plan, state, ev, Date.now())
      if (r.refused) throw new HerdrError('refused', r.refused)
      return { task: await store.logTask({ ...task, step: r.state }, by, `${step}: done`) }
    }
    case 'ack': {
      const r = ackWakes(await store.wakes(), scope, cmd.wakes, Date.now())
      if (r.unknown.length) throw new HerdrError('not_found', `No wake ${r.unknown.join(', ')} was delivered to you`)
      await store.saveWakes(r.changed)
      return { acked: cmd.wakes }
    }
    case 'autopilot show': {
      const ap = rec?.autopilot ?? DEFAULT_AUTOPILOT
      const mine = await mineOf()
      const now = Date.now()
      const line = async (k: string) => { const pace = await projectPace(store, k, undefined, now, true); return pace ? paceLine(pace, now) : 'unknown: the project has no template or no worker program' }
      const mem = (machine: string) => memoryState(deps, machine).then(s => `${s.label}: ${s.line}`, () => 'memory unknown')
      return {
        autopilot: ap, lookForWork: !!ap.lookForWork,
        workingBranch: key ? workingBranch(p) : Object.fromEntries(projects.map(x => [x.key, workingBranch(x)])),
        pacing: key ? await line(key) : Object.fromEntries(await Promise.all(projects.map(async x => [x.key, await line(x.key)]))),
        memory: key ? await mem(p!.machine) : await Promise.all([...new Set(projects.map(x => x.machine))].map(mem)),
        today: { ...limitsLeft(ap, mine, await store.runs(), now), skippedWakes: today(rec?.skipped, now), ...(ap.lookForWork ? { newWorkAdded: today(rec?.lookAdded, now), newWorkPerDay: ap.lookPerDay ?? LOOK_PER_DAY } : {}) },
        note: 'Only the user changes these, in wherdr. With nothing to do and lookForWork off, scheduled wakes are skipped. Pacing holds automatic work only (wakes, tasks added in wakes, automations): scheduled wakes are skipped and such starts refused while it waits; the user\'s own starts never are. Memory holds automatic starts too, on a machine short on memory or at its cap of agents (all projects together): such a task waits and starts by itself once memory is back',
      }
    }
    case 'automation list': return { automations: (await store.automations(needProject().key)).automations.map(automationLine), note: 'Only the user adds or changes automations, in wherdr' }
    case 'automation show': {
      const a = (await store.automations(needProject().key)).automations.find(x => x.id === cmd.id)
      if (!a) throw new HerdrError('not_found', 'Unknown automation')
      return { automation: a }
    }
    case 'tell': {
      const task = await taskOf(cmd.task)
      const run = task.run ? (await store.runs()).find(r => r.id === task.run) : undefined
      if (!run?.terminal || run.state === 'ended') throw new HerdrError('not_found', 'The task\'s agent is not running')
      // What the agent waits for now, from its terminal: a permission prompt is never typed into.
      const live = waitOf(await deps.call<Parameters<typeof waitOf>[0]>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null))
      const why = tellRefusal({ state: live ? 'waiting' : task.state, waitKind: live ?? task.waitKind }, turn !== 'user')
      if (why) throw new HerdrError('refused', why)
      await deps.call('terminal.send', { terminal: run.terminal, text: `From the ${main ? 'main' : 'project'} coordinator: ${cmd.text}` }, 30000)
      const saved = await store.logTask(task.state === 'waiting' && task.waitKind === 'question' ? { ...task, state: 'working', waiting: undefined, waitKind: undefined } : task, by, `told the agent: ${cmd.text.slice(0, 300)}`)
      return { task: saved }
    }
    case 'task start': {
      const task = await taskOf(cmd.task)
      const mine = await mineOf()
      const wake = turn !== 'user', who = { who: 'coordinator' as const, wake }, now = Date.now()
      const pace = pacedStart(task, wake ? 'wake' : 'user') ? (await projectPace(store, key, task, now))?.verdict : undefined
      const why = (task.stopped ? resumeRefusal(task, 'continue', who, undefined) : undefined)
        ?? coordinatorStartRefusal(rec?.autopilot, task, mine, await store.runs(), now, wake, { pace })
      if (why) throw new HerdrError('refused', why)
      // Short on memory: a wake's start waits for it (the engine starts it then); the user's goes, with a word.
      const short = await memoryHold(deps, key)
      // A failed task a wake starts again goes back to do, where the engine starts held tasks.
      if (short && wake && !task.stopped) return { task: await store.logTask({ ...task, state: 'todo', waiting: undefined, waitKind: undefined, autopilot: true, held: short }, by, short), held: `${short}. It starts by itself once memory is back` }
      // Started in a wake: the autopilot's own task, which it may stop in a wake.
      if (wake && !task.autopilot) await store.saveTask({ ...task, autopilot: true })
      const memory = short ? { memory: `${short}: started anyway, as the user asked` } : {}
      if (task.stopped) return { task: await resumeTask(deps, task.id, 'continue', who, by), ...memory }
      const started = await startTask(deps, task.id)
      return { task: await store.logTask(started, by, started.state === 'working' ? 'started the task' : `could not start the task: ${started.waiting ?? ''}`), ...memory }
    }
    case 'task stop': {
      const task = await taskOf(cmd.task)
      return { task: await stopTask(deps, task.id, { who: 'coordinator', wake: turn !== 'user' }, cmd.reason, by) }
    }
    case 'task remove': {
      const task = await taskOf(cmd.task)
      return removeTask(deps, task.id, { who: 'coordinator', wake: turn !== 'user' }, cmd.reason, by)
    }
    case 'task add': {
      const look = turn === 'wake' && !!rec?.turn?.look
      const why = addRefusal(rec?.autopilot, turn !== 'user') ?? (look ? lookAddRefusal(rec?.autopilot, today(rec?.lookAdded, Date.now())) : undefined)
      if (why) throw new HerdrError('refused', why)
      if (!Object.hasOwn(needPlan().taskTypes, cmd.type)) throw new HerdrError('bad_input', `No task type "${cmd.type}": ${Object.keys(t!.taskTypes).join(', ')}`)
      // Added in the user's turn: their request, never held by the pace.
      const added = await store.addTask({ project: key, title: cmd.title, type: cmd.type, description: cmd.description ?? '', after: cmd.after ?? '', origin: turn === 'user' ? 'user' : 'coordinator' })
      const task = turn !== 'user' ? { ...added, autopilot: true as const } : added
      if (look) await store.saveCoordinator({ ...rec!, lookAdded: bump(rec!.lookAdded, Date.now()) })
      return { task: await store.logTask(task, by, `added the task${cmd.after ? `, after ${cmd.after}` : ''}`) }
    }
    case 'pr merge': {
      if (main) throw new HerdrError('refused', 'pr merge is the project coordinator\'s')
      const proj = needProject()
      if (proj.git === false) throw new HerdrError('refused', 'The project has no git repository')
      const base = { guards: t?.guards, turn, userSaid: cmd.userSaid }
      // No GitHub call in a wake or with the guard off.
      const ask = prMergeAskRefusal(base)
      if (ask) throw new HerdrError('refused', ask)
      const taskLinks = (await store.tasks()).flatMap(x => (x.links ?? []).map(l => l.url))
      const sh = actionShell(deps, machineOn(deps, proj.machine).on)
      const view = await sh(`cd "$1" || exit 1; gh pr view "$2" --json ${PR_FIELDS}`, [proj.path, String(cmd.pr)])
      let pr: ContributorPr | null = null
      if (view.code === 0) try { pr = JSON.parse(view.out.trim().split('\n').find(l => l.startsWith('{')) ?? '') as ContributorPr } catch { throw new HerdrError('failed', 'Unreadable PR details') }
      else if (!/could not resolve|not found/i.test(view.out)) throw new HerdrError('failed', `gh pr view: ${view.out.trim().split('\n').pop() ?? ''}`)
      const why = prMergeRefusal({ ...base, pr, taskLinks })
      if (why) throw new HerdrError('refused', why)
      const m = await sh(SCRIPT.merge, [proj.path, pr!.url, pr!.headRefOid, cmd.method ?? ''])
      if (m.code !== 0) throw new HerdrError('failed', `gh pr merge: ${m.out.trim().split('\n').pop() ?? ''}`)
      await store.logProject(proj.key, { by, pr: pr!.number, text: `merged contributor PR #${pr!.number} into ${pr!.baseRefName}${cmd.method ? ` (${cmd.method})` : ''} on the user's yes: "${cmd.userSaid}"`, ...(rec?.turn?.said ? { said: rec.turn.said } : {}) })
      return { merged: pr!.url, into: pr!.baseRefName }
    }
    case 'task decide': {
      const task = await taskOf(cmd.task)
      const r = onEvent(planOf(needPlan(), task, p), task.step ?? initialState(), { kind: 'decide', by: 'coordinator', choice: cmd.choice, note: cmd.reason }, Date.now())
      if (r.refused) throw new HerdrError('refused', r.refused)
      const line = r.effects.flatMap(e => (e.kind === 'log' ? [e.text] : [])).join('; ')
      return { task: await store.logTask({ ...task, step: r.state }, by, line), effects: r.effects.filter(e => e.kind !== 'log') }
    }
  }
}

// Why the coordinator may not change the template to `next`; the same checks
// when the user accepts it later, against the template as it is then.
function editRefusal(t: Template | null, next: Template, turn: Turn) {
  const why = templateEditRefusal(t, next, turn)
  if (why) throw new HerdrError('refused', why)
}

// The user's answer to the coordinator's template change. Accepted: saved,
// written to the template's log (by the coordinator, with the user's sentence),
// and the role files show the new plans at once.
export async function answerProposal(deps: Deps, key: unknown, accept: unknown) {
  const { store } = deps
  const rec = typeof key === 'string' ? await store.coordinator(key) : null
  if (!rec?.proposal) throw new HerdrError('not_found', 'No template change waits for you')
  const { proposal, ...rest } = rec
  const done = (outcome: ProposalOutcome) => store.saveCoordinator({ ...rest, answered: { outcome, at: Date.now() } })
  if (accept !== true) { await done('refused'); return { accepted: false } }
  const p = (await store.projects()).find(x => x.key === rec.project)
  const t = p ? await store.workflow(p.key) : null
  // Its diff was made against that version: saved over a newer one, it would
  // undo a change the user made since.
  if ((t?.version ?? 1) !== proposal.base) {
    await done('outdated: the template changed since, propose again')
    throw new HerdrError('refused', 'The template changed since this proposal: ask the coordinator to propose again')
  }
  // The project's own workflow (a proposal made before workflows names the template it was copied from).
  const next = t ? { ...proposal.template, id: t.id } : proposal.template
  editRefusal(t, next, 'user')
  await store.saveWorkflow(rec.project, next, { by: `coordinator ${rec.project}`, said: proposal.said })
  await done('accepted')
  await writeRoleFiles(deps, rec.project).catch(() => {})
  return { accepted: true }
}

// A program only (a model sent by an older client is ignored).
const agentOf = (v: { program?: unknown }): CoordinatorAgent | null => (isCoordinatorProgram(v.program) ? { program: v.program } : null)
const BAD_AGENT = 'program: an agent that can coordinate (claude, codex, omp…)'
const BAD_PROJECT_AGENT = 'program: claude or codex (a project coordinator needs one wherdr can keep out of the repository)'
// No agent chosen yet: Claude, as before (the client sends the user's first agent).
const FALLBACK: CoordinatorAgent = { program: 'claude' }

// A project's key, or the main coordinator's.
export const isCoordinatorKey = async (store: PmStore, key: unknown) =>
  key === MAIN || (typeof key === 'string' && (await store.projects()).some(p => p.key === key))

// The project's default coordinator agent, changed in one gesture.
export async function setCoordinatorAgent(store: PmStore, key: unknown, agent: { program?: unknown }) {
  const a = agentOf(agent)
  if (!a) throw new HerdrError('bad_input', BAD_AGENT)
  if (typeof key === 'string' && !canRunCoordinator(a.program, key)) throw new HerdrError('bad_input', BAD_PROJECT_AGENT)
  if (typeof key !== 'string' || !(await isCoordinatorKey(store, key))) throw new HerdrError('not_found', 'Unknown project')
  await store.saveCoordinator({ project: key, tokenHash: '', ...(await store.coordinator(key)), agent: a })
  return { agent: a }
}

// Asleep: its scheduled wakes are skipped, nothing to do or the new work limit of today reached.
function asleepOf(ap: Autopilot, tasks: Task[], c: CoordinatorRecord | null | undefined, now: number) {
  const k = ap.on ? scheduledWake(ap, tasks, c?.woke ?? {}, c?.userAt, today(c?.lookAdded, now)) : 'send'
  return k === 'idle' || k === 'limit' ? { asleep: k } : {}
}

// Each project's coordinator: who answers, the agent of its kept conversation, its pending change.
export async function coordinatorsView(store: PmStore): Promise<CoordinatorView[]> {
  if (!(await store.enabled())) return []
  const [tasks, runs, wakes, now] = [await store.tasks(), await store.runs(), await store.wakes(), Date.now()]
  // The main coordinator first: every project's tasks are its own.
  return Promise.all([{ key: MAIN, name: await readAlfredName({}) }, ...await store.projects()].map(async (p) => {
    const c = await store.coordinator(p.key)
    const autopilot = c?.autopilot ?? DEFAULT_AUTOPILOT, mine = tasks.filter(t => p.key === MAIN || t.project === p.key)
    return {
      ...(p.key === MAIN ? { main: true } : {}),
      autopilot, limits: limitsLeft(autopilot, mine, runs, now),
      ...asleepOf(autopilot, mine, c, now), skippedToday: today(c?.skipped, now),
      ...(c?.woke?.at ? { wokeAt: c.woke.at } : {}),
      wakes: wakes.filter(w => w.coordinator === p.key).sort((a, b) => b.createdAt - a.createdAt).slice(0, 5),
      project: p.key, name: p.name, ...('git' in p && p.git === false ? { git: false as const } : {}), ...(c?.agent ? { agent: agentOf(c.agent) ?? FALLBACK } : {}), ...('from' in p && p.from ? { template: p.from.template } : {}),
      ...(c?.ran ? { ran: agentOf(c.ran) ?? FALLBACK } : {}), ...(c?.terminal ? { terminal: c.terminal } : {}),
      ...(c?.proposal ? { proposal: { diff: c.proposal.diff, at: c.proposal.at, ...(c.proposal.said ? { said: c.proposal.said } : {}) } } : {}),
    }
  }))
}

// The role files (and the `wherdr` script) in the coordinator's own folder,
// ~/.wherdr/pm/coordinators/<KEY> on the project's machine; never ~/.claude
// or ~/.codex.
// The main coordinator's: Alfred's home (writeAlfredHome).
export async function writeRoleFiles(deps: Deps, key: string) {
  const { store } = deps
  if (key === MAIN) return { p: undefined, local: true, on: undefined, ...await writeAlfredHome(deps) }
  const projects = await store.projects()
  const found = projects.find(x => x.key === key)
  const p = found && await ensureVisibility(deps, found)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = p ? await store.workflow(p.key) : null
  const { m, on } = machineOn(deps, p.machine)
  const home = await homeOf(deps, on)
  if (!home) throw new HerdrError('core', 'Home folder not found on the project\'s machine')
  const folder = `${home}/.wherdr/pm/coordinators/${key}`
  for (const [file, text] of Object.entries(roleFiles(p, t, EXAMPLES)))
    if ((await exec(deps, on, WRITE_SCRIPT, [`${folder}/${file}`], text)).code !== 0) throw new HerdrError('core', `Could not write ${file}`)
  await exec(deps, on, 'chmod 755 "$1"', [`${folder}/bin/wherdr`])
  return { p, local: !!m.local, on, folder, first: false }
}

const alfredAgent = (program: unknown): CoordinatorAgent | null => (isAlfredProgram(program) ? { program } : null)
const readAlfredName = (deps: { alfredHome?: string }) => fs.readFile(path.join(homeOfAlfred(deps), 'identity.md'), 'utf8').then(alfredName, () => alfredName(''))

// Alfred's home, on wherdr's own machine: wherdr's files rewritten at each
// start (an update ships new ones), its own files created once.
// first: identity.md was just created, so this is its very first start.
export async function writeAlfredHome(deps: Deps) {
  const folder = homeOfAlfred(deps)
  const projects = await deps.store.projects()
  const docs = path.join(process.env.WHERDR_ROOT || process.cwd(), 'docs')
  const docFiles = (await fs.readdir(docs).catch(() => [] as string[])).filter(n => n.endsWith('.md')).sort()
  const main = mainRoleFiles(projects)
  const files = { ...main, ...alfredFiles({ home: folder, version: pkg.version, docs, docFiles, pm: await deps.store.enabled(), projects }, main['AGENTS.md']!.split('\n')) }
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(folder, file)), { recursive: true, mode: 0o700 })
    await fs.writeFile(path.join(folder, file), text, { mode: 0o600 })
  }
  await fs.chmod(path.join(folder, 'bin/wherdr'), 0o755)
  let first = false
  for (const [file, text] of Object.entries(OWN_FILES)) {
    try { await fs.writeFile(path.join(folder, file), text, { flag: 'wx', mode: 0o600 }); if (file === 'identity.md') first = true }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
  }
  return { folder, first }
}

// The sidebar's Alfred row: its name (identity.md), the program the user chose
// (none yet: the sheet asks before its first start), the one running, and its conversation.
export async function alfredView(deps: { store: PmStore, alfredHome?: string }) {
  const c = await deps.store.coordinator(MAIN)
  return { name: await readAlfredName(deps), ...(c?.agent ? { program: c.agent.program } : {}), ...(c?.ran ? { ran: c.ran.program } : {}), ...(c?.terminal ? { terminal: c.terminal } : {}) }
}

// Where the coordinator reaches wherdr: loopback on the wherdr host; from
// another machine, wherdr's published (tailnet) address.
export interface CoordinatorUrls { local: string, remote?: string }
const LOOPBACK = /^(localhost|127\.|\[::1\])/
// here: the address the request came to (used when wherdr has no published one).
export function coordinatorUrls(here: URL): CoordinatorUrls {
  const port = process.env.NITRO_PORT || process.env.PORT || '7683'
  let published = ''
  try { published = JSON.parse(fsSync.readFileSync(APP_URL_FILE, 'utf8'))?.url || '' } catch {}
  const remote = published || ENV_APP_URL || (LOOPBACK.test(here.hostname) ? '' : here.origin)
  return { local: `http://127.0.0.1:${port}`, ...(remote ? { remote: remote.replace(/\/$/, '') } : {}) }
}

// When a project coordinator starts: its files, a new token, how to start it.
export async function prepareCoordinator(deps: Deps, key: string, program: CoordinatorProgram, urls: CoordinatorUrls) {
  const { p, local, on, folder, first } = await writeRoleFiles(deps, key)
  const url = local ? urls.local : urls.remote
  if (!url) throw new HerdrError('unreachable', 'The project\'s machine cannot reach this wherdr: publish it on your tailnet first (Settings › Phone)')
  const token = await issueToken(deps.store, key)
  if (key === MAIN) await issueAlfredToken(deps.store, folder!)
  // Alfred starts with its greeting (startPrompt).
  const prompt = key === MAIN ? [startPrompt(first, await readAlfredName(deps))] : []
  return { on, folder, argv: coordinatorArgs(program, folder, p?.path, p?.git === false), prompt, env: { WHERDR_PM_TOKEN: token, WHERDR_URL: url, DISABLE_AUTOUPDATER: '1' } }
}

// Starts the coordinator in its folder, its harness's default model, token in its environment,
// its folder's bin/ (the `wherdr` script) first in its PATH.
export async function startCoordinator(deps: Deps, key: unknown, agent: { program?: unknown }, urls: CoordinatorUrls) {
  if (typeof key !== 'string') throw new HerdrError('not_found', 'Unknown project')
  // No agent given: the project's default. Alfred: a program only, with its own default model.
  const a = key === MAIN ? alfredAgent(agent.program ?? (await deps.store.coordinator(key))?.agent?.program)
    : agentOf(agent.program === undefined ? (await deps.store.coordinator(key))?.agent ?? FALLBACK : agent)
  if (!a) throw new HerdrError('bad_input', BAD_AGENT)
  if (!canRunCoordinator(a.program, key)) throw new HerdrError('bad_input', BAD_PROJECT_AGENT)
  const { program } = a
  const before = await deps.store.coordinator(key)
  const c = await prepareCoordinator(deps, key, program, urls)
  const argv = [...c.argv, ...(promptAsArg(program) ? c.prompt : [])]
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const { address } = await deps.call<{ address: string }>('terminal.run', {
    cwd: c.folder, ...(c.on ? { on: c.on } : {}), no_parent: true, wait: false, env: c.env,
    labels: { 'wherdr.install': await deps.store.install(), 'wherdr.coordinator': key },
    line: `${PATH_SETUP}; export PATH=${quote(`${c.folder}/bin`)}:"$PATH"; exec ${argv.map(quote).join(' ')}`,
  }, 30000)
  // Typed once the program is ready (in the background: it may wait on a dialog).
  if (!promptAsArg(program)) for (const text of c.prompt) void sendFirstMessage(deps, address, text).then(r => (r === 'dialog' ? sendAfterDialog(deps, address, text) : r)).catch(() => {})
  // Alfred keeps the agent the user picked as its own (a project coordinator keeps its default).
  await deps.store.saveCoordinator({ ...(await deps.store.coordinator(key))!, terminal: address, ran: { program }, ...(key === MAIN ? { agent: a } : {}) })
  // A new conversation replaces the one before (another agent's, or ended).
  if (before?.terminal && before.terminal !== address) await deps.call('terminal.kill', { terminal: before.terminal }, 15000).catch(() => {})
  return { terminal: address, folder: c.folder }
}
