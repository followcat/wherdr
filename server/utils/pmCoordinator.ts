// A project coordinator on the server: its token (one per project, scoped to
// it), where its current turn comes from, the `wherdr pm` commands it runs,
// and its role files, written in its own folder on the project's machine.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { projectPlace } from '../../shared/pm/places'
import { notesStore, runNotes, type NotesStore } from './notesStore'
import { FIRST_REPLY, MAIN, canResume, canRunCoordinator, coordinatorBy, commandList, coordinatorArgs, updateNotice, isCoordinatorProgram, promptAsArg, promptArgOnResume, PROMPT_ARG_FLAG, PROMPT_LEAD, mainRoleFiles, OWN_ROLE_FILES, parseCommand, roleFiles, ROOT_RULE_FILES, isPlainFolder, citedSpecChange, specChangeRefusal, specChangedText, specDiff, tellTarget, stepBackRefusal, stepDoneEvent, templateDiff, templateEditRefusal, type CoordinatorAgent, type CoordinatorProgram, type CoordinatorView, type Proposal, type ProposalAnswer, type ProposalOutcome, type Turn, type NotedTurn, PROPOSAL_ANSWERS, workspaceView } from '../../shared/pm/coordinator'
import { FEATURE, WORKSPACE_FIRST, coordinatorKey, handledBy, isWorkspace, membersOf, ownWorkflow } from '../../shared/pm/workspace'
import { initialState, onEvent, planSteps, currentStep, durationMs, waitStep } from '../../shared/pm/steps'
import { templateChanges } from '../../shared/pm/templateText'
import { changeSummary, workflowChanges } from '../../shared/pm/workflowChanges'
import { MODEL_RE, isDefaultWorkflow, validateTemplate } from '../../shared/pm/workflow'
import { weightOf, weightText, weightsLine } from '../../shared/pm/weight'
import { EXAMPLES } from '../../shared/pm/examples'
import { AUTOPILOT_STARTED, UNCONFIRMED, DEFAULT_AUTOPILOT, LOOK_PER_DAY, USER_ONLY, addRefusal, bump, busyNext, busyQueue, keepsBusy, coordinatorStartRefusal, countFix, limitsLeft, pastLimit, lookAddRefusal, routinesOf, scheduledWake, tellRefusal, today, type Autopilot } from '../../shared/pm/autopilot'
import { ackWakes, sinceYesterday } from '../../shared/pm/wakes'
import { nextWakeAt } from '../../shared/pm/flow'
import { incidentView, isOpen, type Incident } from '../../shared/pm/incident'
import { automationLine, proposalLine, proposeAutomation } from '../../shared/pm/automations'
import type { Template } from '../../shared/pm/workflow'
import { allowedMachines, machineNamed, taskMachine, type Project } from '../../shared/pm/project'
import { projectOf, showIds, shownKey, shownTaskId, storedTaskId } from '../../shared/pm/projectKey'
import { taskPlan, trustKeys, waitOf, type Task } from '../../shared/pm/run'
import { HerdrError } from './herdr'
import { cardNotesMessage, tellCardOutcome } from './cardOutcome'
import { cardNoteOf } from '../../shared/uiActions'
import { answeredTask, clearQuestion } from './pmAnswer'
import { PATH_SETUP, homeOf, machineOn, type CoreAdminDeps } from './coreCreate'
import { deliverFirst, queuedFirst, startTurn } from './coordinatorFirst'
import { CREATE_SCRIPT, WRITE_SCRIPT, exec, launched, startTask } from './pmLaunch'
import { actionShell } from './pmActions'
import { SCRIPT } from '../../shared/pm/actions'
import { PR_FIELDS, prMergeAskRefusal, prMergeRefusal, type ContributorPr } from '../../shared/pm/contributorPr'
import { userEvent, userStep } from './pmBoard'
import { ensureVisibility } from './pmVisibility'
import { boardOrder, orderTasks } from '../../shared/pm/boardOrder'
import { pauseForRoom, removeTask, resumeTask, stopTask } from './pmStop'
import { checkOnGithub } from './pmGhCheck'
import { noteBack } from './pmStall'
import { reviveWorker } from './pmRelease'
import { restartReview } from './pmWatchdog'
import { handFix } from '../../shared/pm/release'
import { CHAIN_WAIT, DONE_CMD, afterIds, mergeAfterIds } from '../../shared/pm/advance'
import { checkTaskContext } from '../../shared/pm/context'
import { READ_LINES, lastWords } from './pmRead'
import { READ_COMMANDS, reachRefusal } from '../../shared/pm/reach'
import { resumeRefusal } from '../../shared/pm/stop'
import { pacedStart, paceGauge, paceLine } from '../../shared/pm/pace'
import { readQuotas } from './quotas'
import { quotaByKey, reviewAccount, reviewQueueLines, runningReviews } from '../../shared/pm/reviewQueue'
import { forgetMemory } from './pmMemory'
import { projectEstimates } from './pmPeaks'
import { goesTo, machineLines, paceOf, pilotOf, placeFor, slotsOf } from './pmPlace'
import { STRATEGY_LABELS } from '../../shared/pm/placement'
import { projectPace } from './pmPace'
import { sameFilesText } from '../../shared/pm/files'
import type { CoordinatorRecord, PmStore } from './pmStore'
import { ALFRED, ALFRED_PROGRAM_FILES, OWN_FILES, alfredFiles, alfredName, isAlfredProgram, startPrompt } from '../../shared/pm/alfred'
import { APP_URL_FILE, DATA_DIR, ENV_APP_URL, HOME } from './env'
import { findDocsDir, readDocs } from './wherdrDocs'
import { projectsDataDir, projectsHome } from '../../bin/lib/userpath.mjs'
import { readV2Projects, type V2Candidate } from './v2Board'
import pkg from '../../package.json'
import { openUi, showUi, uiTargetsList, type UiOpenDeps } from './uiOpen'
import { addAction } from './uiActions'
import { runMap } from './pmMap'
import { adoptRepo } from './pmAdopt'
import { splitFeature } from './pmFeature'
import { readPlanFile } from './pmPlan'
import { openLines, planCloseRefusal } from '../../shared/pm/planRefs'
import { afterRefusal, closeRefusal, featureState } from '../../shared/pm/feature'
import { pmDir } from './pmHome'

// The running build's version (shared/v3Version.ts: package version plus commit),
// so the update notice fires between two builds of one version. Outside Nitro
// (unit tests) there is no runtime config: the package version alone.
function wherdrVersion(): string {
  try { return String(useRuntimeConfig().public.version) } catch { return pkg.version }
}

// A project's incidents (all of them with no project named), oldest first.
const projectIncidents = (list: Incident[], tasks: Task[], key: string) =>
  key ? list.filter(i => i.tasks.some(id => tasks.find(t => t.id === id)?.project === key)) : list
async function lastOpenIncident(store: PmStore, key: string) {
  const tasks = await store.tasks()
  const open = projectIncidents(await store.incidents(), tasks, key).filter(i => isOpen(i, tasks)).at(-1)
  return open ? incidentView(open, tasks) : null
}

// alfredHome: Alfred's home folder (DATA_DIR/alfred by default).
type Deps = CoreAdminDeps & { store: PmStore, alfredHome?: string, clients?: UiOpenDeps['clients'], notes?: NotesStore, settingsFile?: string, startGapMs?: number }
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
// message from the interface (with its text) or an engine wake; relay and
// card (shared/pm/coordinator.ts Turn) are refused by every user-only gate.
// look: a look-for-new-work wake, whose turn counts the tasks it adds.
// The user's message is kept whole (a long one too) for the proposal it may lead to;
// a relay's or a card's, for the log only.
const SAID_MAX = 8000
// tab: the home tab the user has open (Alfred's `groups` and `brief` read it).
export async function noteTurn(store: PmStore, key: string, kind: NotedTurn, said?: string, look = false, tab?: string) {
  const c = await store.coordinator(key)
  if (!c) throw new HerdrError('not_found', 'No coordinator for this project')
  const at = Date.now()
  await store.saveCoordinator({ ...c, turn: { kind, at, ...(kind !== 'wake' && said ? { said: said.slice(0, SAID_MAX) } : {}), ...(kind === 'wake' && look ? { look: true as const } : {}) }, ...(kind !== 'wake' ? { userAt: at } : {}), ...(tab ? { openTab: tab } : {}) })
}

const TURN_MS = 3_600_000

// The task as it is, unless a check made at its write refused the change.
const noCycle = (why: string | undefined, t: Task) => { if (why) throw new HerdrError('refused', why); return t }

// The user's message sent from the interface to a terminal: when that
// terminal is a coordinator, its turn now comes from the user. Alfred's too
// with project management off (it then helps the user switch it on).
export async function userMessageTo(store: PmStore, terminal: string | undefined, text: string, tab?: unknown) {
  if (!terminal) return
  const c = (await store.coordinators()).find(x => x.terminal === terminal)
  const open = c?.project === MAIN && typeof tab === 'string' && tab.length <= 200 ? tab : undefined
  if (c && (c.project === MAIN || await store.enabled())) await noteTurn(store, c.project, 'user', text, false, open)
}

// The branch tasks start from, open their PR to and merge into when a step names none.
const workingBranch = (p?: Project) => p?.base || 'not set: tasks start from the repository\'s current branch, and a step without a branch has none'
const planOf = (t: Template, task: Task, p?: Project) => taskPlan(t, task, p)
const summary = (t: Template | null, task: Task, p?: Project) => {
  const step = t ? currentStep(planOf(t, task, p), task.step ?? initialState()) : undefined
  return { id: p ? shownTaskId([p], task.id) : task.id, title: task.title, type: task.type, state: task.step?.abandoned ? 'abandoned' : task.step?.done ? 'done' : task.stopped ? 'stopped' : task.state, ...(task.stopped ? { stopped: task.stopped } : {}), step: step?.id, holder: step?.holder, yourTurn: task.step?.yourTurn?.badge, tags: task.tags, links: task.links, ...(task.after ? { after: task.after } : {}), ...(task.parked ? { parked: { on: task.parked.on, need: task.parked.need } } : {}), ...(task.mergeAfter ? { mergeAfter: task.mergeAfter } : {}), ...(task.files ? { files: task.files } : {}), ...(task.sameFiles ? { sameFiles: task.sameFiles } : {}), ...(task.plan?.file ? { planFile: task.plan.file } : {}), ...(task.refs ? { refs: task.refs } : {}), ...(task.planTick ? { planTick: task.planTick } : {}) }
}

// The machine a task runs on, by its name; before its first start, none yet.
const machineOf = (task: Task, p: Project | undefined, known: { key: string, label: string }[]) => {
  const on = task.machine ?? (task.run ? p?.machine : undefined)
  return on !== undefined ? known.find(m => m.key === on)?.label ?? on : 'not started: the engine places it at its start (task start --on picks one)'
}

const unb64 = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('utf8') : v)

// POST /api/pm/cli: { argv, input? } with the coordinator's token, or
// { argv64, input64 } from the folder's `wherdr` script. A project's token
// acts on its project only (a workspace's: its members too); the main coordinator's on every project.
// The output and a refusal name tasks by their shown key (CMP-9, not CP-9).
type CliBody = { argv?: unknown, input?: unknown, argv64?: unknown, input64?: unknown }
export async function runCommand(deps: Deps, token: unknown, body: CliBody) {
  const visit: { on?: string, by?: string, what?: string } = {}
  try {
    const out = await command(deps, token, body, visit)
    // A write on another project: its coordinator is told at its next wake (pmWakes.ts).
    const other = visit.on ? await deps.store.coordinator(visit.on) : null
    if (other) await deps.store.saveCoordinator({ ...other, visits: [...(other.visits ?? []), { at: Date.now(), by: visit.by!, what: visit.what! }].slice(-20) })
    return showIds(await deps.store.projects(), out)
  }
  catch (e) {
    if (e instanceof Error) e.message = showIds(await deps.store.projects().catch(() => []), e.message)
    throw e
  }
}

// A token's own scope: its project and, for a workspace, each member (members
// have no coordinator of their own: the workspace's runs every command on them).
export const inScope = (projects: Project[], scope: string, project: string) =>
  project === scope || membersOf(scope, projects).some(m => m.key === project)

async function command(deps: Deps, token: unknown, body: CliBody, visit: { on?: string, by?: string, what?: string } = {}) {
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
  // Another project: only what the user's setting on this project allows (reach.ts).
  const self = projects.find(x => x.key === scope)
  const shown = (k: string) => shownKey(projects.find(x => x.key === k) ?? { key: k })
  const reach = (k: string) => {
    // A workspace's coordinator runs every command on its members as on its own project, under
    // the same rules; template edit never takes --project (a member's own workflow is the user's).
    const why = main || inScope(projects, scope, k) ? undefined : reachRefusal(self, k, cmd.name, { self: shown(scope), other: shown(k) })
    if (why) throw new HerdrError('refused', why)
  }
  if (named && projects.some(x => x.key === named)) reach(named)
  else if (!main && named && named !== scope) throw new HerdrError('refused', `Your token acts on project ${scope} only`)
  const taskOf = async (id: string) => {
    const task = await store.task(id)
    if (!task) throw new HerdrError('not_found', 'Unknown task')
    reach(task.project)
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
  // A task the user asked for, from wherdr or relayed by Alfred: added as theirs.
  const asked = turn === 'user' || turn === 'relay'
  const by = coordinatorBy(scope)
  if (!main && key && !inScope(projects, scope, key) && !READ_COMMANDS.includes(cmd.name)) Object.assign(visit, { on: key, by, what: [cmd.name, 'task' in cmd ? cmd.task : 'title' in cmd ? `"${cmd.title}"` : ''].join(' ').trim() })
  const needProject = () => { if (!p) throw new HerdrError('bad_input', `Name the project: --project <KEY> (${projects.map(shownKey).join(', ')})`); return p }
  // A member: the workflow it runs, its own or its workspace's (never a copy).
  const runsOf = async (x?: Project) => !x?.workspace ? {} : { runs: await store.savedWorkflow(x.key) ? `its own workflow, set by the user (the workspace's guards on top)` : `workspace ${shown(x.workspace)}'s workflow: a change to it reaches ${shown(x.key)}` }
  const needPlan = () => { needProject(); if (!t) throw new HerdrError('not_found', 'The project has no template'); return t }
  // The autopilot that holds the command: the project's own, also for Alfred (which has none);
  // a member's: its workspace's. Another project's tasks: that project's autopilot and limits.
  const pk = key && coordinatorKey(key, projects), held = pk ? handledBy(pk, projects) : projects
  // The tasks the limits count: all those of the autopilot's projects (every task for the main coordinator with no project named).
  const mineOf = async () => (await store.tasks()).filter(x => (main && !key) || held.some(y => y.key === x.project))
  const pilotRec = main || pk !== scope ? (pk ? await store.coordinator(pk) : null) : rec, pilot = pilotRec?.autopilot

  // Alfred has no autopilot: it starts or adds tasks in the user's turns only.
  if (main && turn !== 'user' && (cmd.name === 'task start' || cmd.name === 'task add')) throw new HerdrError('refused', `Alfred runs ${cmd.name} only on a request from the user, sent from wherdr: each project's coordinator runs its own autopilot`)

  switch (cmd.name) {
    case 'help': return { commands: commandList(t) }
    case 'map show': case 'map list': case 'map set': case 'map remove': return runMap(deps, pk ? projects.find(x => x.key === pk) : undefined, projects, cmd)
    case 'repo adopt': {
      const adopted = await adoptRepo(deps, pk ? projects.find(x => x.key === pk) : undefined, projects, cmd, main ? ALFRED : by)
      // Its instructions list the members: written again with the new one.
      await writeRoleFiles(deps, pk).catch(() => {})
      return adopted
    }
    case 'feature add': {
      const ws = projects.find(x => x.key === pk)
      if (!isWorkspace(ws)) throw new HerdrError('bad_input', 'A feature is a workspace\'s: run it from a workspace\'s coordinator, or name one with --project <KEY>')
      const why = addRefusal(pilot, !asked)
      if (why) throw new HerdrError('refused', why)
      const added = await store.addTask({ project: ws!.key, title: cmd.title, type: FEATURE, description: cmd.description ?? '', origin: asked ? 'user' : 'coordinator', addedBy: scope })
      return { task: await store.logTask(added, by, 'added the feature'), next: `Split it into sub-tasks of its repositories: wherdr pm feature split ${added.id} < plan.json` }
    }
    case 'feature split': {
      const why = addRefusal(pilot, turn !== 'user')
      if (why) throw new HerdrError('refused', why)
      const wake = turn !== 'user'
      const split = await splitFeature(deps, p, await taskOf(cmd.task), body.input, { by, origin: wake ? 'coordinator' : 'user', ...(cmd.from ? { from: cmd.from } : {}) }, async (t) => {
        const refused = wake ? coordinatorStartRefusal(pilot, t, await mineOf(), await store.runs(), Date.now(), true, { holds: await slotsOf(store, held) }) : undefined
        if (refused) throw new Error(refused)
        await store.logTask(await startTask(deps, t.id, { by }), by, 'started the task')
      })
      if (split.adopted) await writeRoleFiles(deps, pk).catch(() => {})
      return split
    }
    case 'feature close': {
      const all = await store.tasks(), feature = await taskOf(cmd.task), file = feature.plan?.file
      let why = feature.kind === 'feature' ? closeRefusal(feature, all) : `${feature.id} is not a feature`
      // Lines of its plan file still unticked: the user decides (--anyway).
      if (!why && file && !cmd.anyway && p) {
        const read = await readPlanFile(deps, p, file)
        why = 'text' in read ? planCloseRefusal(file, openLines(read.text)) : undefined
      }
      if (why) throw new HerdrError('refused', why)
      return { task: await store.updateTask(feature.id, x => ({ ...x, closed: { at: Date.now(), by, ...(cmd.reason ? { reason: cmd.reason } : {}) } }), { by, text: `closed the feature${cmd.reason ? `: ${cmd.reason}` : ''}${cmd.anyway && file ? ` (--anyway: plan lines of ${file} may be unticked)` : ''}` }) }
    }
    case 'ui targets': return uiTargetsList()
    case 'ui action': return addAction(store, { scope, turn, by: main ? ALFRED : `${shownKey(p ?? { key: scope })} coordinator`, kind: cmd.action, task: await taskOf(cmd.task) })
    case 'ui show': return showUi({ ...deps, clients: deps.clients ?? (() => []) }, { scope, turn, by: main ? ALFRED : `${shownKey(p ?? { key: scope })} coordinator`, ...(cmd.what === 'file' ? { what: cmd.what, path: cmd.path } : { what: cmd.what, task: await taskOf(cmd.task) }) })
    case 'ui open': return openUi({ ...deps, clients: deps.clients ?? (() => []) }, { scope, main, raw: cmd.link, turn, by: main ? ALFRED : `${scope} coordinator` })
    case 'notes': return runNotes(deps.notes ?? notesStore(), cmd.notes, body.input, main ? { by: ALFRED } : { by, project: needProject() }, deps.settingsFile, deps.machines())
    case 'list': {
      const ts = new Map(await Promise.all(projects.map(async x => [x.key, x ? await store.workflow(x.key) : null] as const)))
      // Archived tasks only with --archived, newest archived first.
      const all = await store.tasks(), tasks = all.filter(x => (!key || x.project === key) && !!x.archived === !!cmd.archived)
      // A feature's state is derived from its sub-tasks.
      return { tasks: (cmd.archived ? tasks.sort((a, b) => b.archived! - a.archived!) : boardOrder(tasks)).map(x => ({ ...summary(ts.get(x.project) ?? null, x, projects.find(y => y.key === x.project)), ...(x.kind === 'feature' ? { state: featureState(x, all) } : {}), ...(x.feature ? { feature: x.feature } : {}) })) }
    }
    case 'show': { const task = await taskOf(cmd.task); return { task: { ...summary(t, task, p), weight: weightText(weightOf(t, task)), machine: machineOf(task, p, deps.machines()), description: task.description, log: task.log ?? [] }, plan: t ? planOf(t, task, p) : [] } }
    case 'docs': return readDocs(findDocsDir(), cmd.page)
    case 'plan': return { template: t && { id: t.id, version: t.version }, ...await runsOf(p), workingBranch: workingBranch(p), plans: Object.fromEntries(Object.keys(needPlan().taskTypes).map(type => [type, planSteps(t!, { type }, p?.base)])) }
    case 'template show': return {
      template: ownWorkflow(needPlan()),
      // A member's: the workspace's guards on top of its own; without its own file, it runs the workspace's.
      ...(t!.workspaceGuards ? { workspaceGuards: t!.workspaceGuards } : {}),
      ...await runsOf(p),
      ...(main ? {} : rec?.proposal ? { proposal: 'waiting for the user in wherdr', diff: rec.proposal.diff } : answersOf(rec).length ? { lastProposal: answersOf(rec).at(-1)!.outcome } : {}),
    }
    case 'template edit': {
      if (main) throw new HerdrError('refused', 'template edit is the project coordinator\'s or the user\'s: add a task or tell the user')
      let next: Template
      try { next = JSON.parse(String(body.input ?? '')) as Template } catch { throw new HerdrError('bad_input', 'The new template is not valid JSON') }
      // Always the project's own workflow, whatever id the JSON names.
      if (t && next && typeof next === 'object') next = { ...next, id: t.id }
      editRefusal(t, next, turn, key)
      const errors = validateTemplate(next)
      if (errors.length) throw new HerdrError('bad_input', errors.map(e => `${e.path}: ${e.message}`).join('; '))
      // The user accepts or refuses it in the interface; nothing is saved yet.
      // by: who proposed it; said, saidAt: the user's message it follows.
      const changes = workflowChanges(t && ownWorkflow(t), next)
      const proposal = { template: next, diff: templateDiff(t, next), at: Date.now(), base: t?.version ?? 1, by: main ? 'main' : scope, changes, ...(rec?.turn?.said ? { said: rec.turn.said, saidAt: rec.turn.at } : {}) }
      // One still waiting is replaced: its card says so.
      await store.saveCoordinator({ ...withAnswer(rec!, rec?.proposal && answerOf(rec.proposal, 'replaced', rec.proposal.by === 'main' ? ALFRED : coordinatorBy(scope))), proposal })
      return { proposed: true, changes: templateChanges(t, next), diff: proposal.diff, next: 'Its card shows at the end of your reply, where the user accepts or refuses it: do not open the Workflow tab (ui open) for it. template show tells you what they chose' }
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
      if (ev.kind === 'user') return { task: await store.logTask(await userStep(deps, task.id, true), by, `${step}: done on the user's message "${(rec?.turn?.said ?? '').slice(0, 500)}"`) }
      const r = onEvent(plan, state, ev, Date.now())
      if (r.refused) throw new HerdrError('refused', r.refused)
      return { task: await store.logTask({ ...task, step: r.state }, by, `${step}: done`) }
    }
    case 'step back': {
      // The sheet's Send back (same event, same screenshot rules), on the user's words.
      const task = await taskOf(cmd.task)
      const why = stepBackRefusal(currentStep(planOf(needPlan(), task, p), task.step ?? initialState()), turn)
      if (why) throw new HerdrError('refused', why)
      return { task: await userEvent(store, task.id, { kind: 'back', note: cmd.text }, by, `on the user's message "${(rec?.turn?.said || cmd.userSaid).slice(0, 500)}"`) }
    }
    case 'step wait': {
      const task = await taskOf(cmd.task)
      const plan = planOf(needPlan(), task, p)
      const r = waitStep(plan, task.step ?? initialState(), cmd.for ? { ms: durationMs(cmd.for) } : { untilUser: true }, Date.now())
      if ('refused' in r) throw new HerdrError('refused', r.refused)
      const step = currentStep(plan, r.state)!.id
      const logged = await store.logTask({ ...task, step: r.state }, by, `${step}: next recheck ${cmd.for ? `in ${cmd.for}` : 'when the user writes or acts on the task'}. ${cmd.reason}`)
      // Its own log line is no news: the backoff does not start over for it.
      const seen = logged.step?.news, at = logged.log?.at(-1)?.at ?? 0
      return { task: seen && at > seen.at ? await store.saveTask({ ...logged, step: { ...logged.step!, news: { ...seen, at } } }) : logged }
    }
    case 'ack': {
      const r = ackWakes(await store.wakes(), scope, cmd.wakes, Date.now())
      if (r.unknown.length) throw new HerdrError('not_found', `No wake ${r.unknown.join(', ')} was delivered to you`)
      await store.saveWakes(r.changed)
      return { acked: cmd.wakes }
    }
    case 'autopilot show': {
      if (main && !key) return { autopilots: Object.fromEntries(await Promise.all(projects.map(async x => [x.key, { on: !!(await store.coordinator(x.key))?.autopilot?.on }]))), note: 'You have no autopilot: each project\'s coordinator runs its own. Add --project <KEY> for one project\'s' }
      const ap = pilot ?? DEFAULT_AUTOPILOT
      const mine = await mineOf()
      const now = Date.now()
      const line = async (k: string) => { const pace = await projectPace(store, k, undefined, now, true); return pace ? paceLine(pace, now) : 'unknown: the project has no template or no worker program' }
      const lines = (x: Project) => machineLines(deps, x).catch(() => ['machines unknown'])
      // Keep the board busy: on or off, and what the engine starts next (or why nothing).
      const busy = async (x: Project) => {
        const { ap: xap, all: tasks, held: xs, holds } = await pilotOf(store, projects, x.key)
        const head = busyQueue(tasks)[0], pace = head ? await paceOf(store, xs.find(z => z.key === head.project)!, head, now).catch(() => undefined) : undefined
        const n = busyNext(xap, tasks, await store.runs(), now, { pace: pace?.verdict, holds })
        return { on: keepsBusy(xap), next: 'task' in n ? `${n.task.id} (${n.task.title}), once a machine has room` : n.why }
      }
      // Each reviewer account with reviews running or waiting: its use and its queue.
      const reviews = async () => {
        const q = await readQuotas().catch(() => null), tasks = await store.tasks()
        const lines = reviewQueueLines(tasks, runningReviews(tasks, await store.runs(), r => reviewAccount(q, r.program, r.machine).key), k => quotaByKey(q, k), now)
        return Object.keys(lines).length ? lines : 'none running or waiting'
      }
      const weights = async (x: Project, tpl: Template | null) => ({ estimates: weightsLine(await projectEstimates(store, x.key)), types: Object.fromEntries(Object.keys(tpl?.taskTypes ?? {}).map(type => [type, weightText(weightOf(tpl, { type }))])) })
      return {
        autopilot: ap, routines: routinesOf(ap), lookForWork: !!ap.lookForWork, lastOpenIncident: await lastOpenIncident(store, key),
        workingBranch: key ? workingBranch(p) : Object.fromEntries(projects.map(x => [x.key, workingBranch(x)])),
        placement: key ? STRATEGY_LABELS[p!.placement ?? 'strongest'] : Object.fromEntries(projects.map(x => [x.key, STRATEGY_LABELS[x.placement ?? 'strongest']])),
        pacing: key ? await line(key) : Object.fromEntries(await Promise.all(projects.map(async x => [x.key, await line(x.key)]))),
        machines: key ? await lines(p!) : Object.fromEntries(await Promise.all(projects.map(async x => [x.key, await lines(x)]))),
        keepBusy: key ? await busy(p!) : Object.fromEntries(await Promise.all(projects.map(async x => [x.key, await busy(x)]))),
        reviews: await reviews(),
        weights: key ? await weights(p!, t) : Object.fromEntries(await Promise.all(projects.map(async x => [x.key, weights(x, await store.workflow(x.key))]))),
        // Wakes not sent, newest first: what and why.
        skippedWakes: [...(pilotRec?.skips ?? [])].slice(-20).reverse().map(x => ({ at: new Date(x.at).toISOString(), what: x.what, why: x.why })),
        today: { ...limitsLeft(ap, mine, await store.runs(), now, await slotsOf(store, held)), skippedWakes: today(pilotRec?.skipped, now), ...(ap.lookForWork ? { newWorkAdded: today(pilotRec?.lookAdded, now), newWorkPerDay: ap.lookPerDay ?? LOOK_PER_DAY } : {}) },
        note: 'Only the user changes these, in wherdr. routines: at each one\'s time (when), a wake Routine: <its goal>, with the health lines, within the hours and the pace (off: none). keepBusy: with it on, the engine itself starts the next to-do task in board order (oldest first) while a machine has room, within the limits, hours and pace; next says which, or why none. With nothing to do and lookForWork off, scheduled wakes are skipped, and so are they while nothing you could act on changed since your last wake (no task startable now, no new block, no answer); unless its health lines say something new (or 12 h passed since they were sent); a question you already answered with tell, and an engine wake for a block that is only an offline or paused machine (the incident covers it; the engine resumes the task itself and wakes you if that fails) are skipped too. skippedWakes lists the last ones, what and why; today.skippedWakes counts today\'s skipped scheduled wakes. Pacing holds automatic work only (wakes, tasks added in wakes, automations): scheduled wakes are skipped and such starts refused while it waits; the user\'s own starts never are. The engine places each start on one of the project\'s allowed machines by its placement strategy (Heavy to the strongest: heavy work on the strongest, light and standard work at home when it fits; Balance the load: each task on the machine with most room; Home first: home until it is full; --on picks one); automatic starts wait while no machine has room (memory, cores, its cap of agents, all projects together) and start by themselves once one has. perDay, atOnce and hours hold automatic work only: a start the user asks for goes past them, and still counts in them. perDay null: no daily limit; atOnce null is Auto: as many tasks as the machines take (both the defaults of a new project). Whatever the counts, pacing and machine room still hold automatic work. machines: each allowed machine, its agents at work by weight, its available hours (automatic starts skip it outside them, heavy work in its last 2 hours) and the heaviest weight it takes now (or why none: offline, away, full…); weights: what placement counts per weight (learned from the measured peaks of the project after 3 runs of that weight, else the default), and the weight each task type gets. lastOpenIncident: the last time agents were gone and why, from facts (wherdr pm incidents lists them all); null when none is open. reviews: each reviewer account with reviews running or waiting, its 5-hour and weekly use, and how many it runs at once; the others wait their turn, oldest first',
      }
    }
    case 'incidents': {
      const since = cmd.since ?? Date.now() - 7 * 86_400_000, tasks = await store.tasks()
      const list = projectIncidents(await store.incidents(), tasks, key).filter(i => i.at >= since).reverse()
      return { incidents: list.map(i => incidentView(i, tasks)), note: 'The cause comes from facts the engine read (herdr-core\'s machines and terminals, the account\'s limit data); unknown means they did not decide. Tell the user this cause, never a guess' }
    }
    case 'automation list': {
      const f = await store.automations(needProject().key)
      return { automations: f.automations.map(automationLine), proposals: (f.proposals ?? []).map(proposalLine), note: 'Propose a new one, a change or a removal with automation propose, in a turn of the user: they accept or refuse it. Only the user switches one on or off' }
    }
    case 'automation propose': {
      if (turn !== 'user') throw new HerdrError('refused', 'automation propose runs only in a turn that comes from the user: tell them what you would propose')
      const k = needProject().key
      let raw: unknown
      if (!cmd.remove) try { raw = JSON.parse(String(body.input ?? '')) } catch { throw new HerdrError('bad_input', 'The automation is not valid JSON (on stdin)') }
      const proposal = await store.changeAutomations(k, (f) => {
        const r = proposeAutomation(f, { ...cmd, raw, types: Object.keys(t?.taskTypes ?? {}) }, { project: k, by: main ? 'main' : scope, said: rec?.turn?.said, now: Date.now() })
        if ('error' in r) throw new HerdrError('bad_input', r.error)
        return { file: { ...f, proposals: r.proposals }, out: r.proposal }
      })
      return { proposed: proposal, next: `The user accepts or refuses it from a card in your reply or in ${projectPlace(k, 'automations', true)}; automation list tells you what they chose` }
    }
    case 'automation show': {
      const a = (await store.automations(needProject().key)).automations.find(x => x.id === cmd.id)
      if (!a) throw new HerdrError('not_found', 'Unknown automation')
      return { automation: a }
    }
    case 'tell': {
      const task = await taskOf(cmd.task)
      const specWhy = cmd.spec ? specChangeRefusal(turn) : undefined
      if (specWhy) throw new HerdrError('refused', specWhy)
      // --spec: the message is also a spec note, for the reviewer's next round.
      const noted = (x: Task) => (cmd.spec ? store.logTask({ ...x, specNotes: [...(x.specNotes ?? []), { at: Date.now(), by, text: cmd.text }] }, by, `spec change: ${cmd.text.slice(0, 300)}`) : x)
      const holder = t && !task.step?.done ? currentStep(planOf(t, task, p), task.step ?? initialState())?.holder : undefined
      const { role, run, released, review } = tellTarget(await store.runs(), task.id, holder, cmd.to, !!cmd.fix, !task.cleanup?.done)
      // A failed step action handed over with a fix: the worker reports it done, then the engine tries it again.
      const fixesAction = !!(cmd.fix && t && handFix(planOf(t, task, p), task.step, cmd.fix, Date.now()))
      const said = `From the ${main ? 'main' : inScope(projects, scope, key) ? 'project' : `${shown(scope)} project`} coordinator: ${cmd.text}${fixesAction ? `\n\nWhen done: ${DONE_CMD}` : ''}`
      const wake = turn !== 'user', fix = cmd.fix && { autopilot: rec?.autopilot, main }
      // A wake's fix counts against the step's; the log keeps its kind and reason.
      const fixed = (x: Task) => (cmd.fix && wake ? { ...x, fixes: countFix(task) } : x)
      const fixNote = cmd.fix ? ` (fix ${cmd.fix}: ${cmd.reason})` : ''
      // A failed step action handed over with a fix: off Your turn while the agent fixes it, then tried again.
      const handed = async (x: Task) => {
        const step = cmd.fix && t ? handFix(planOf(t, x, p), x.step, cmd.fix, Date.now()) : undefined
        return step ? store.logTask({ ...x, step }, by, `${currentStep(planOf(t!, x, p), step)?.id ?? 'step'}: the agent is fixing it, then it is tried again`) : x
      }
      if (released) {
        const why = tellRefusal(task, wake, fix)
        if (why) throw new HerdrError('refused', why)
        const started = await reviveWorker(deps, task.id, cmd.fix ? `a fix of the coordinator: ${cmd.reason}` : 'a message of the coordinator', said)
        if (started?.state !== 'working') throw new HerdrError('refused', 'The task\'s worker could not start again now (short on memory?): try again later')
        const told = await noted(await handed(await store.logTask(fixed(started), by, `told the worker, started again${fixNote}: ${cmd.text.slice(0, 300)}`)))
        return { task: t ? await noteBack(store, told, planOf(t, told, p), by, `the ${by} told the worker`) : told, sentTo: 'worker (started again with your message)' }
      }
      // A reviewer not running at its step, with a fix: the review starts again (the message logged; the new reviewer reads its review file).
      if (review) {
        const why = tellRefusal(task, wake, fix)
        if (why) throw new HerdrError('refused', why)
        const restarted = await restartReview(deps, task.id, by, `the reviewer was not running: the review starts again${fixNote}: ${cmd.text.slice(0, 300)}`)
        const told = await noted(cmd.fix && wake ? await store.saveTask(fixed(restarted)) : restarted)
        return { task: t ? await noteBack(store, told, planOf(t, told, p), by, `the ${by} restarted the review`) : told, sentTo: 'reviewer (the review starts again; your message is in the task\'s log, not sent to it)' }
      }
      if (!run?.terminal) throw new HerdrError('not_found', `The task's ${role} is not running${cmd.to ? '' : ` (--to ${role === 'worker' ? 'reviewer' : 'worker'} picks the other agent)`}`)
      // What the agent waits for now, from its terminal: a permission prompt is never typed into.
      const live = waitOf(await deps.call<Parameters<typeof waitOf>[0]>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null))
      const why = tellRefusal({ ...task, state: live ? 'waiting' : task.state, waitKind: live ?? task.waitKind }, wake, fix)
      if (why) throw new HerdrError('refused', why)
      await deps.call('terminal.send', { terminal: run.terminal, text: said }, 30000)
      // Its question answered: its label goes, the task leaves Your turn at once (pmAnswer.ts).
      if (live === 'question' || task.waitKind === 'question') await clearQuestion(deps, run.terminal)
      const saved = await noted(await handed(await store.logTask(fixed(answeredTask(task)), by, `told the ${role}${fixNote}: ${cmd.text.slice(0, 300)}`)))
      return { task: t ? await noteBack(store, saved, planOf(t, saved, p), by, `the ${by} told the ${role}`) : saved, sentTo: role }
    }
    case 'read': {
      const task = await taskOf(cmd.task)
      // The agent tell reaches (or the one asked), its latest run, ended or not.
      const runs = await store.runs()
      const holder = t && !task.step?.done ? currentStep(planOf(t, task, p), task.step ?? initialState())?.holder : undefined
      const { role } = tellTarget(runs, task.id, holder, cmd.to)
      const run = runs.filter(r => r.task === task.id && r.role === role && r.terminal).sort((a, b) => b.startedAt - a.startedAt)[0]
      if (!run) throw new HerdrError('not_found', `The task has no ${role} yet`)
      const said = await lastWords(deps, run.terminal!, cmd.lines ?? READ_LINES)
      if (!said) throw new HerdrError('unreachable', `Nothing to read from the task's ${run.role}: its conversation and its terminal are out of reach`)
      return { task: p ? shownTaskId([p], task.id) : task.id, agent: run.role, running: run.state !== 'ended', ...(task.state === 'waiting' && task.waitKind ? { waits: task.waitKind } : {}), ...said }
    }
    case 'task start': {
      const task = await taskOf(cmd.task)
      if (task.kind === 'feature') throw new HerdrError('refused', `${task.id} is a feature: it runs no agent, start its sub-tasks`)
      // --on: a machine the project allows, for a task never started (a started one stays on its own).
      const named = cmd.on === undefined ? undefined : machineNamed(p!, deps.machines(), cmd.on)
      const placed = named && ('refused' in named ? named : taskMachine(task, p!, named.machine))
      if (placed && 'refused' in placed) throw new HerdrError('refused', placed.refused)
      const mine = await mineOf()
      const wake = turn !== 'user', who = { who: 'coordinator' as const, wake }, now = Date.now()
      const pace = pacedStart(task, wake ? 'wake' : 'user') ? await paceOf(store, p!, task, now) : undefined
      const runs = await store.runs(), holds = await slotsOf(store, held)
      const why = (task.stopped ? resumeRefusal(task, 'continue', who, undefined) : undefined)
        ?? coordinatorStartRefusal(pilot, task, mine, runs, now, wake, { pace: pace?.verdict, holds })
      if (why) throw new HerdrError('refused', why)
      // The user's start goes past the autopilot's limits, and says so.
      const past = wake ? undefined : pastLimit(pilot, mine, runs, now, holds)
      // No room on any allowed machine: a wake's start waits for it (the engine starts it then); the user's goes, with a word.
      const { on, short } = goesTo(await placeFor(deps, task, { asked: placed?.machine, waits: pace?.waits }))
      // A failed task a wake starts again goes back to do, where the engine starts held tasks.
      if (short && wake && !task.stopped) return { task: await store.logTask({ ...task, state: 'todo', waiting: undefined, waitKind: undefined, autopilot: true, held: short }, by, short), held: `${short}. It starts by itself once there is room` }
      // Started in a wake: the autopilot's own task, which it may stop in a wake.
      if (wake && !task.autopilot) await store.saveTask({ ...(await store.task(task.id) ?? task), autopilot: true })
      const said = { ...(short ? { memory: `${short}: started anyway, as the user asked` } : {}), ...(past ? { note: `started; ${past}` } : {}) }
      if (task.stopped) return { task: await resumeTask(deps, task.id, 'continue', who, by), ...said }
      if (on !== undefined) forgetMemory(on)
      const started = await startTask(deps, task.id, { by, ...(on !== undefined ? { on } : {}) })
      if (started.sameFiles) return { task: started, held: `${sameFilesText(started.sameFiles)}: it starts by itself once that task no longer touches them` }
      return { task: await store.logTask(started, by, started.state === 'working' ? (!wake ? 'started the task' : await launched(store, started) ? AUTOPILOT_STARTED.wake : UNCONFIRMED) : `could not start the task: ${started.waiting ?? ''}`), ...said }
    }
    case 'task edit': case 'task note': {
      if (cmd.name === 'task edit' && cmd.after !== undefined) {
        const task = await taskOf(cmd.task), ids = afterIds({ after: cmd.after }).map(a => storedTaskId(projects, a) ?? a)
        if (turn !== 'user' && !pilot?.on) throw new HerdrError('refused', 'In a wake, after is changed only with the autopilot on')
        const why = (task.step?.started || task.state === 'working') && !task.parked ? `${task.id} has started: after orders only tasks not started yet (or a parked one)` : afterRefusal(task.project, ids, await store.tasks(), projects, task.id)
        if (why) throw new HerdrError('refused', why)
        // No longer held by its chain: to do again, where the engine looks at it.
        // Checked again at the write: another edit may have closed a cycle meanwhile.
        const saved = await store.updateTask(task.id, async (x, all) => ({ ...noCycle(afterRefusal(x.project, ids, await all(), projects, x.id), x), after: ids.join(',') || undefined, ...(x.state === 'waiting' && x.waiting?.includes(CHAIN_WAIT) ? { state: 'todo' as const, waiting: undefined } : {}) }), { by, text: `starts after ${ids.join(', ') || 'no task'} (${cmd.reason})` })
        if (cmd.title === undefined && cmd.description === undefined && cmd.mergeAfter === undefined && cmd.context === undefined) return { task: saved }
      }
      if (cmd.name === 'task edit' && cmd.mergeAfter !== undefined) {
        const task = await taskOf(cmd.task), ids = mergeAfterIds({ mergeAfter: cmd.mergeAfter }).map(a => storedTaskId(projects, a) ?? a)
        if (turn !== 'user' && !pilot?.on) throw new HerdrError('refused', 'In a wake, merge after is changed only with the autopilot on')
        const why = task.step?.done ? `${task.id} is done` : afterRefusal(task.project, ids, await store.tasks(), projects, task.id, 'mergeAfter')
        if (why) throw new HerdrError('refused', why)
        const saved = await store.updateTask(task.id, async (x, all) => ({ ...noCycle(afterRefusal(x.project, ids, await all(), projects, x.id, 'mergeAfter'), x), mergeAfter: ids.join(',') || undefined }), { by, text: `merges after ${ids.join(', ') || 'no task'} (${cmd.reason})` })
        if (cmd.title === undefined && cmd.description === undefined && cmd.context === undefined) return { task: saved }
      }
      if (cmd.name === 'task edit' && cmd.context !== undefined) {
        const task = await taskOf(cmd.task)
        if (turn !== 'user' && !pilot?.on) throw new HerdrError('refused', 'In a wake, context folders are changed only with the autopilot on')
        if (task.step?.done) throw new HerdrError('refused', `${task.id} is done`)
        const checked = cmd.context === null ? { context: undefined } : checkTaskContext(cmd.context, projects.find(x => x.key === task.project)!, projects)
        if ('error' in checked) throw new HerdrError('refused', checked.error)
        const said = checked.context === undefined ? 'its task type\'s' : checked.context === 'all' ? 'all other members' : checked.context.join(', ') || 'none'
        const saved = await store.updateTask(task.id, x => ({ ...x, context: checked.context }), { by, text: `context folders: ${said}, from its next start (${cmd.reason})` })
        if (cmd.title === undefined && cmd.description === undefined) return { task: saved }
      }
      const why = specChangeRefusal(turn)
      if (why) throw new HerdrError('refused', why)
      const task = await taskOf(cmd.task), at = Date.now()
      const next = cmd.name === 'task edit'
        ? { ...task, title: cmd.title ?? task.title, description: cmd.description ?? task.description }
        : { ...task, specNotes: [...(task.specNotes ?? []), { at, by, text: cmd.text }] }
      const saved = cmd.name === 'task edit'
        ? await store.logTask(next, by, `edited the spec (${cmd.reason}):\n${specDiff(task, next)}`)
        : await store.logTask(next, by, `spec change: ${cmd.text.slice(0, 300)}`)
      // Its running agents read it at once; the next ones get it in their instructions.
      const what = cmd.name === 'task note' ? cmd.text
        : [cmd.title !== undefined && `its title is now "${cmd.title}".`, cmd.description !== undefined && `its description is now:\n\n${cmd.description}`].filter(Boolean).join('\n')
      const told: string[] = []
      for (const r of (await store.runs()).filter(r => r.task === task.id && r.state !== 'ended' && r.terminal)) {
        await deps.call('terminal.send', { terminal: r.terminal, text: showIds(projects, specChangedText(what)) }, 30000).then(() => told.push(r.role), () => {})
      }
      return { task: saved, told }
    }
    case 'task check': return checkOnGithub(deps, (await taskOf(cmd.task)).id, by)
    case 'task stop': {
      const task = await taskOf(cmd.task)
      if (cmd.forRoom) return { task: await pauseForRoom(deps, task.id, cmd.reason, by), paused: 'it goes on by itself once its machine has room' }
      return { task: await stopTask(deps, task.id, { who: 'coordinator', wake: turn !== 'user' }, cmd.reason, by) }
    }
    case 'task remove': {
      const task = await taskOf(cmd.task)
      return removeTask(deps, task.id, { who: 'coordinator', wake: turn !== 'user' }, cmd.reason, by)
    }
    case 'task order': {
      if (turn !== 'user' && !pilot?.on) throw new HerdrError('refused', 'In a wake, the board is ordered only with the autopilot on')
      const picked = await Promise.all(cmd.tasks.map(taskOf))
      const mine = (await store.tasks()).filter(x => x.project === key)
      const r = orderTasks(mine, picked.map(x => x.id))
      if ('refused' in r) throw new HerdrError('refused', r.refused)
      // Read again: the engine may have moved it since.
      for (const x of picked) await store.saveTask({ ...(await store.task(x.id)) ?? x, order: r.order[x.id] })
      await store.logProject(key, { by, text: `put first on the board, in this order: ${cmd.tasks.join(', ')}`, ...(rec?.turn?.said ? { said: rec.turn.said } : {}) })
      return { ordered: cmd.tasks, tasks: boardOrder(await store.tasks()).filter(x => x.project === key && !x.step?.done).map(x => x.id) }
    }
    case 'task add': {
      const look = turn === 'wake' && !!rec?.turn?.look
      // Another project's: its own new-work limit and count hold too, beside the acting coordinator's.
      const cross = !main && pk !== scope && pilotRec ? pilotRec : undefined
      const why = addRefusal(pilot, !asked) ?? (look ? lookAddRefusal(pilot, today((cross ?? rec)?.lookAdded, Date.now())) ?? (cross ? lookAddRefusal(rec?.autopilot, today(rec?.lookAdded, Date.now())) : undefined) : undefined)
      if (why) throw new HerdrError('refused', why)
      if (!Object.hasOwn(needPlan().taskTypes, cmd.type)) throw new HerdrError('bad_input', `No task type "${cmd.type}": ${Object.keys(t!.taskTypes).join(', ')}`)
      // Added in the user's turn (or relayed by Alfred): their request, never held by the pace.
      if (cmd.refs?.length && !(await store.task(storedTaskId(projects, cmd.feature!) ?? cmd.feature!))?.plan?.file) throw new HerdrError('bad_input', `--refs: ${cmd.feature} has no plan file: name it when the feature is split ("plan": "<the path of its tasks.md>")`)
      const added = await store.addTask({ project: key, title: cmd.title, type: cmd.type, description: cmd.description ?? '', after: cmd.after ?? '', ...(cmd.mergeAfter ? { mergeAfter: cmd.mergeAfter } : {}), files: cmd.files ?? [], ...(cmd.feature ? { feature: cmd.feature } : {}), ...(cmd.refs?.length ? { refs: cmd.refs } : {}), ...(cmd.weight ? { weight: cmd.weight } : {}), ...(cmd.fromBranch ? { fromBranch: cmd.fromBranch } : {}), ...(cmd.context ? { context: cmd.context } : {}), origin: asked ? 'user' : 'coordinator', addedBy: scope })
      const task = !asked ? { ...added, autopilot: true as const } : added
      if (look) await store.saveCoordinator({ ...rec!, lookAdded: bump(rec!.lookAdded, Date.now()) })
      if (look && cross) { const c = (await store.coordinator(cross.project))!; await store.saveCoordinator({ ...c, lookAdded: bump(c.lookAdded, Date.now()) }) }
      return { task: await store.logTask(task, by, `added the task${cmd.after ? `, after ${cmd.after}` : ''}${cmd.mergeAfter ? `, merging after ${cmd.mergeAfter}` : ''}`) }
    }
    case 'pr merge': {
      if (main) throw new HerdrError('refused', 'pr merge is the project coordinator\'s')
      const proj = needProject()
      if (proj.git === false) throw new HerdrError('refused', 'The project has no git repository')
      const base = { guards: t?.guards, turn, userSaid: cmd.userSaid }
      // No GitHub call in a wake or with the guard off.
      const ask = prMergeAskRefusal(base)
      if (ask) throw new HerdrError('refused', ask)
      const taskLinks = (await store.tasks()).flatMap(x => [...(x.links ?? []).map(l => l.url), ...(x.branch ? [x.branch] : [])])
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
    case 'report back': case 'report close': {
      const task = await taskOf(cmd.task)
      if (!task.report) throw new HerdrError('refused', 'No open report on this task: the user withdrew it, or it is closed')
      if (cmd.name === 'report back') return { task: await userEvent(store, task.id, { kind: 'back', note: cmd.text }, by) }
      return { task: await store.logTask({ ...task, report: undefined }, by, `closed the reported problem: ${cmd.text.slice(0, 300)}`) }
    }
    case 'task decide': {
      const task = await taskOf(cmd.task), now = Date.now()
      // A pass the engine does not offer: only on a spec change its reason cites.
      const y = task.step?.yourTurn, onSpec = cmd.choice === 'pass' && y?.reason === 'rounds' && !y.advice?.options.includes('pass')
      const cited = onSpec ? citedSpecChange(task, cmd.reason) : undefined
      if (cited && 'refused' in cited) throw new HerdrError('refused', cited.refused)
      const plan = planOf(needPlan(), task, p), state = task.step ?? initialState(), step = currentStep(plan, state)?.id ?? ''
      const r = onEvent(plan, state, { kind: 'decide', by: 'coordinator', choice: cmd.choice, note: cmd.reason, ...(cited ? { spec: true as const } : {}) }, now)
      if (r.refused) throw new HerdrError('refused', r.refused)
      const line = r.effects.flatMap(e => (e.kind === 'log' ? [e.text] : [])).join('; ')
      const next = { ...task, step: r.state }
      return { task: await store.logTask(next, by, line), effects: r.effects.filter(e => e.kind !== 'log'),
        ...(cited ? { tellUser: `In your next message, tell the user you passed ${step} of ${task.id} on the spec change of ${new Date(cited.at).toISOString().slice(0, 10)}: ${cmd.reason}` } : {}) }
    }
  }
}

// Why the coordinator may not change the template to `next`; the same checks
// when the user accepts it later, against the template as it is then.
function editRefusal(t: Template | null, next: Template, turn: Turn, key?: string) {
  const why = templateEditRefusal(t, next, turn, key)
  if (why) throw new HerdrError('refused', why)
}

// What became of a proposal; summary: its own changes (an older proposal,
// without them, against the workflow as it is now).
const answerOf = (p: Proposal, outcome: ProposalOutcome, by: string, t?: Template | null): ProposalAnswer =>
  ({ outcome, at: Date.now(), by, proposedAt: p.at, summary: changeSummary(p.changes ?? workflowChanges(t ?? null, p.template)) })
const answersOf = (rec?: CoordinatorRecord | null) => rec?.answers ?? (rec?.answered ? [rec.answered] : [])
// The record with one more answer, the oldest dropped past PROPOSAL_ANSWERS.
function withAnswer<R extends CoordinatorRecord>(rec: R, a?: ProposalAnswer | false): R {
  if (!a) return rec
  const { answered: _old, ...rest } = rec
  return { ...rest, answers: [...answersOf(rec), a].slice(-PROPOSAL_ANSWERS) } as R
}

// The user's answer to the coordinator's template change. Accepted: saved,
// written to the workflow's log (by the coordinator, with the user's sentence),
// and the role files show the new plans at once.
export async function answerProposal(deps: Deps, key: unknown, accept: unknown) {
  const { store } = deps
  const rec = typeof key === 'string' ? await store.coordinator(key) : null
  if (!rec?.proposal) throw new HerdrError('not_found', 'No template change waits for you')
  const { proposal, ...rest } = rec
  const p = (await store.projects()).find(x => x.key === rec.project)
  const t = p ? await store.workflow(p.key) : null
  // The proposer learns the answer in its conversation (cardOutcome.ts).
  const done = async (outcome: ProposalOutcome) => {
    const a = answerOf(proposal, outcome, 'user', t)
    await store.saveCoordinator(withAnswer(rest, a))
    const what = `Workflow change${a.summary?.length ? ` (${a.summary.join('; ')})` : ''}`
    const said = outcome === 'accepted' ? 'Applied' : outcome === 'refused' ? 'Cancelled' : 'Not applied'
    await tellCardOutcome(deps, proposal.by === 'main' ? MAIN : rec.project, `${said}: ${what}${said === 'Not applied' ? `: ${outcome}` : ''}`).catch(() => {})
  }
  if (accept !== true) { await done('refused'); return { accepted: false } }
  // Its diff was made against that version: saved over a newer one, it would
  // undo a change the user made since.
  if ((t?.version ?? 1) !== proposal.base) {
    await done('outdated: the template changed since, propose again')
    throw new HerdrError('refused', 'The template changed since this proposal: ask the coordinator to propose again')
  }
  // The project's own workflow (a proposal made before workflows names the template it was copied from).
  const next = t ? { ...proposal.template, id: t.id } : proposal.template
  editRefusal(t, next, 'user', rec.project)
  await store.saveWorkflow(rec.project, next, { by: coordinatorBy(proposal.by === 'main' ? MAIN : rec.project), said: proposal.said })
  await done('accepted')
  await writeRoleFiles(deps, rec.project).catch(() => {})
  return { accepted: true }
}

// A program, and its model when one is given (Claude, Codex and omp take one).
const agentOf = (v: { program?: unknown, model?: unknown }): CoordinatorAgent | null => (isCoordinatorProgram(v.program)
  ? { program: v.program, ...(typeof v.model === 'string' && MODEL_RE.test(v.model) && (v.program === 'claude' || v.program === 'codex' || v.program === 'omp') ? { model: v.model } : {}) }
  : null)
const BAD_AGENT = 'program: an agent that can coordinate (claude, codex, omp…)'
const BAD_PROJECT_AGENT = 'program: claude, codex or omp (a project coordinator needs one that is kept out of the repository: by wherdr for Claude and Codex, by its tool list for omp)'
// No agent chosen yet: Claude, as before (the client sends the user's first agent).
const FALLBACK: CoordinatorAgent = { program: 'claude' }

// A project's key, or the main coordinator's.
export const isCoordinatorKey = async (store: PmStore, key: unknown) =>
  key === MAIN || (typeof key === 'string' && (await store.projects()).some(p => p.key === key))

// The project's default coordinator agent, changed in one gesture.
export async function setCoordinatorAgent(store: PmStore, key: unknown, agent: { program?: unknown, model?: unknown }) {
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

// The autopilot's own starts since `since`, oldest first, from the task log (written
// once the worker runs): Keep the board busy's, a wake's, and a task held by a
// wake for room that the engine started once there was some. Never the user's.
const autopilotStart = (t: Task, text: string) =>
  text.startsWith(AUTOPILOT_STARTED.busy) || text === AUTOPILOT_STARTED.wake || (text === AUTOPILOT_STARTED.room && !!t.autopilot)
function startsSince(projects: Project[], tasks: Task[], since: number) {
  return tasks.flatMap(t => (t.log ?? []).filter(e => e.at >= since && autopilotStart(t, e.text)).map(e => ({ task: shownTaskId(projects, t.id), title: t.title, at: e.at })))
    .sort((a, b) => a.at - b.at)
}

// Each project's coordinator: who answers, the agent of its kept conversation, its pending change.
export async function coordinatorsView(store: PmStore): Promise<CoordinatorView[]> {
  if (!(await store.enabled())) return []
  const now = Date.now(), [tasks, runs] = [await store.tasks(), await store.runs()]
  const projects = await store.projects(), holds = await slotsOf(store, projects)
  // The timeline's start: yesterday's local midnight.
  const since = sinceYesterday(now), wakes = await store.wakes(now - since)
  // The automation proposals, for the card in the conversation of the one that made them.
  const byOf = (k: string) => (k === MAIN ? 'main' : k)
  const autoProps = (await Promise.all(projects.map(async x => (await store.automations(x.key)).proposals ?? []))).flat()
  // The main coordinator first; it has no autopilot (each project's coordinator runs its own).
  // A workspace's member has none: its workspace's coordinator handles its tasks.
  const own = projects.filter(p => coordinatorKey(p.key, projects) === p.key)
  return Promise.all([{ key: MAIN, name: await readAlfredName({}) }, ...own].map(async (p) => {
    const c = await store.coordinator(p.key)
    const current = c?.proposal ? await store.workflow(p.key) : null
    const changes = c?.proposal ? c.proposal.changes ?? workflowChanges(current, c.proposal.template) : undefined
    const held = handledBy(p.key, projects), autopilot = c?.autopilot ?? DEFAULT_AUTOPILOT, mine = tasks.filter(t => held.some(x => x.key === t.project))
    const next = nextWakeAt(c?.autopilot, c?.ranAt, { ...(c?.atRan ? { at: c.atRan } : {}), ...c?.routineRan }, now)
    const paused = 'paused' in p ? p.paused ?? [] : []
    const busy = paused.filter(m => runs.some(r => r.state !== 'ended' && r.machine === m && mine.some(t => t.id === r.task)))
    return {
      ...(p.key === MAIN
        ? { main: true }
        : {
            autopilot, limits: limitsLeft(autopilot, mine, runs, now, holds),
            ...asleepOf(autopilot, mine, c, now), skippedToday: today(c?.skipped, now),
            ...(c?.woke?.at ? { wokeAt: c.woke.at } : {}),
            ...(next ? { nextWake: next } : {}),
            wakes: wakes.filter(w => w.coordinator === p.key && w.createdAt >= since).sort((a, b) => b.createdAt - a.createdAt),
            skips: (c?.skips ?? []).filter(x => x.at >= since), started: startsSince(projects, mine, since),
            ...await projectPace(store, p.key, undefined, now).then(s => (s ? { pace: paceGauge(s, now) } : {}), () => ({})),
          }),
      project: p.key, name: p.name, ...('coordinatorName' in p && p.coordinatorName ? { coordinatorName: p.coordinatorName } : {}), ...('machine' in p ? { machines: allowedMachines(p) } : {}), ...(paused.length ? { paused } : {}), ...(busy.length ? { busy } : {}), ...('git' in p && p.git === false ? { git: false as const } : {}), ...(c?.agent ? { agent: agentOf(c.agent) ?? FALLBACK } : {}), ...('from' in p && p.from ? { template: p.from.template } : {}),
      ...(c?.ran ? { ran: agentOf(c.ran) ?? FALLBACK } : {}), ...(c?.terminal ? { terminal: c.terminal } : {}),
      ...(c?.undelivered && !c.undelivered.queued ? { undelivered: { why: c.undelivered.why, at: c.undelivered.at } } : {}),
      ...(c?.proposal ? { proposal: { diff: c.proposal.diff, at: c.proposal.at, changes, template: c.proposal.template, by: c.proposal.by ?? (p.key === MAIN ? 'main' : p.key), ...(c.proposal.said ? { said: c.proposal.said } : {}), ...(c.proposal.saidAt ? { saidAt: c.proposal.saidAt } : {}) } } : {}),
      ...('label' in p && p.label ? { label: p.label } : {}), ...('color' in p && p.color ? { color: p.color } : {}),
      ...(answersOf(c).length ? { answers: answersOf(c) } : {}),
      ...('kind' in p && isWorkspace(p) ? { workspace: workspaceView(p, projects, tasks) } : {}),
      ...(autoProps.some(x => x.by === byOf(p.key)) ? { automationProposals: autoProps.filter(x => x.by === byOf(p.key)) } : {}),
    }
  }))
}

// The role files (and the `wherdr` script) in the coordinator's own folder,
// ~/.wherdr/pm/coordinators/<KEY> (pmHome.ts) on the project's machine; never ~/.claude
// or ~/.codex.
// The main coordinator's: Alfred's home (writeAlfredHome).
// program: the harness that runs it — its own files land there too (alfred.ts).
export async function writeRoleFiles(deps: Deps, key: string, program?: CoordinatorProgram) {
  const { store } = deps
  if (key === MAIN) return { p: undefined, local: true, on: undefined, ...await writeAlfredHome(deps, program) }
  const projects = await store.projects()
  const found = projects.find(x => x.key === key)
  const p = found && await ensureVisibility(deps, found)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = p ? await store.workflow(p.key) : null
  const { m, on } = machineOn(deps, p.machine)
  const home = await homeOf(deps, on)
  if (!home) throw new HerdrError('core', 'Home folder not found on the project\'s machine')
  const folder = `${home}/${pmDir()}/coordinators/${key}`
  // A workspace: its members' folders (rewritten at each start, so an adopted member is
  // covered from the next one) and the root's own instructions, read on its machine.
  const ws = isWorkspace(p) ? {
    members: membersOf(key, projects).map(x => ({ key: shownKey(x), path: x.path })),
    rules: (await Promise.all(ROOT_RULE_FILES.map(async file => {
      const r = await exec(deps, on, '[ -f "$1" ] && cat "$1"', [`${p.path.replace(/\/$/, '')}/${file}`])
      return r.code === 0 && r.out ? { file, text: r.out } : undefined
    }))).filter(r => !!r),
  } : {}
  for (const [file, text] of Object.entries(roleFiles(p, t, EXAMPLES, m.local ? docsDir() : undefined, k => { const x = projects.find(y => y.key === k); return x && shownKey(x) }, ws)))
    if ((await exec(deps, on, WRITE_SCRIPT, [`${folder}/${file}`], text)).code !== 0) throw new HerdrError('core', `Could not write ${file}`)
  for (const [file, text] of Object.entries(OWN_ROLE_FILES))
    if ((await exec(deps, on, CREATE_SCRIPT, [`${folder}/${file}`], text)).code !== 0) throw new HerdrError('core', `Could not create ${file}`)
  await exec(deps, on, 'chmod 755 "$1"', [`${folder}/bin/wherdr`])
  return { p, local: !!m.local, on, folder, first: false, v2: false, none: false }
}

// Lines added to the end of a project coordinator's memory.md, on the
// project's machine (created first when missing, with a line break before them).
const APPEND_SCRIPT = 'mkdir -p "$(dirname "$1")" && { [ -e "$1" ] || printf \'%s\' "$2" > "$1"; } && { [ -z "$(tail -c 1 "$1")" ] || echo >> "$1"; } && cat >> "$1"'
export async function appendCoordinatorMemory(deps: Deps, key: string, lines: string[]) {
  const p = (await deps.store.projects()).find(x => x.key === key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const { on } = machineOn(deps, p.machine)
  const home = await homeOf(deps, on)
  if (!home) throw new HerdrError('core', 'Home folder not found on the project\'s machine')
  const file = `${home}/${pmDir()}/coordinators/${key}/memory.md`
  if ((await exec(deps, on, APPEND_SCRIPT, [file, OWN_ROLE_FILES['memory.md']!], `${lines.join('\n')}\n`)).code !== 0) throw new HerdrError('core', 'Could not write memory.md')
  return { file, added: lines.length }
}

// wherdr's docs on its own machine: the running build's, so an update brings new ones.
const docsDir = () => findDocsDir()

// At wherdr's start (an update included): every running coordinator's role
// files rewritten, Alfred's home too. Nothing else: no message, no wake; each
// one learns of an update on its next command (takeUpdateNotice).
export async function rewriteRoleFiles(deps: Deps) {
  for (const c of await deps.store.coordinators())
    if (c.terminal) await writeRoleFiles(deps, c.project, (c.ran ?? c.agent)?.program).catch(() => {})
}

// The line the coordinator's next command starts with, once, when wherdr was
// updated since its session started; then it counts as told.
export async function takeUpdateNotice(store: PmStore, key: string | null) {
  const rec = key ? await store.coordinator(key) : null
  const line = updateNotice(rec, wherdrVersion())
  if (line) await store.saveCoordinator({ ...rec!, told: wherdrVersion() })
  return line
}

const alfredAgent = (program: unknown): CoordinatorAgent | null => (isAlfredProgram(program) ? { program } : null)
const readAlfredName = (deps: { alfredHome?: string }) => fs.readFile(path.join(homeOfAlfred(deps), 'identity.md'), 'utf8').then(alfredName, () => alfredName(''))

// The v2 projects, read now from herdr-projects' board on this machine (read
// only): HERDR_PROJECTS_HOME and HERDR_PROJECTS_DATA_DIR, as herdr-projects finds them.
export async function v2Projects(store: PmStore, hpDir?: string): Promise<V2Candidate[]> {
  return readV2Projects(hpDir ?? projectsHome(process.env, HOME), await store.projects(), undefined, hpDir ? undefined : projectsDataDir(process.env, HOME))
}

// Alfred's home, on wherdr's own machine: wherdr's files rewritten at each
// start (an update ships new ones), its own files created once.
// first: identity.md was just created, so this is its very first start.
// v2: the user comes from wherdr v2: its herdr-projects board has projects.
export async function writeAlfredHome(deps: Deps, program?: CoordinatorProgram) {
  const folder = homeOfAlfred(deps)
  const projects = await deps.store.projects()
  const docs = docsDir()
  const docFiles = (await fs.readdir(docs).catch(() => [] as string[])).filter(n => n.endsWith('.md')).sort()
  const main = mainRoleFiles(projects)
  const v2 = (await v2Projects(deps.store)).length > 0
  const files = { ...main, ...alfredFiles({ home: folder, version: wherdrVersion(), docs, docFiles, address: coordinatorUrls(new URL('http://127.0.0.1')), pm: await deps.store.enabled(), projects, v2 }, main['AGENTS.md']!.split('\n')), ...(program ? ALFRED_PROGRAM_FILES[program] : undefined) }
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
  return { folder, first, v2, none: !projects.length }
}

// The sidebar's Alfred row: its name (identity.md), the program the user chose
// (none yet: the sheet asks before its first start), the one running, and its conversation.
// withV2: also the number of wherdr v2 projects not set up in v3 yet (Home says so).
export async function alfredView(deps: { store: PmStore, alfredHome?: string, herdrProjects?: string }, withV2 = false) {
  const c = await deps.store.coordinator(MAIN)
  const made = withV2 ? await deps.store.projects() : []
  const v2 = withV2 ? (await v2Projects(deps.store, deps.herdrProjects).catch(() => [])).filter(x => !made.some(p => p.path === x.path || p.name === x.name)).length : 0
  return { name: await readAlfredName(deps), ...(c?.agent ? { program: c.agent.program } : {}), ...(c?.ran ? { ran: c.ran.program } : {}), ...(c?.terminal ? { terminal: c.terminal } : {}), ...(v2 ? { v2 } : {}) }
}

// Where the coordinator reaches wherdr: loopback on the wherdr host; from
// another machine, wherdr's published (tailnet) address.
export interface CoordinatorUrls { local: string, remote?: string }
const LOOPBACK = /^(localhost|127\.|\[::1\])/
// here: the address the request came to (used when wherdr has no published one).
// The port this server listens on, as Nitro's node server picks it: 3000
// when nothing sets it (.output/server/index.mjs started directly; the
// wherdr command and npm start always set PORT).
export const serverPort = (env: NodeJS.ProcessEnv = process.env) => env.NITRO_PORT || env.PORT || '3000'
export function coordinatorUrls(here: URL): CoordinatorUrls {
  const port = serverPort()
  let published = ''
  try { published = JSON.parse(fsSync.readFileSync(APP_URL_FILE, 'utf8'))?.url || '' } catch {}
  const remote = published || ENV_APP_URL || (LOOPBACK.test(here.hostname) ? '' : here.origin)
  return { local: `http://127.0.0.1:${port}`, ...(remote ? { remote: remote.replace(/\/$/, '') } : {}) }
}

// When a project coordinator starts: its files, a new token, how to start it.
export async function prepareCoordinator(deps: Deps, key: string, program: CoordinatorProgram, urls: CoordinatorUrls, resume = false, model?: string) {
  const { p, local, on, folder, first, v2, none } = await writeRoleFiles(deps, key, program)
  const url = local ? urls.local : urls.remote
  if (!url) throw new HerdrError('unreachable', 'The project\'s machine cannot reach this wherdr: publish it on your tailnet first (Settings › Phone)')
  const token = await issueToken(deps.store, key)
  if (key === MAIN) await issueAlfredToken(deps.store, folder!)
  // Alfred starts with its greeting (startPrompt); a resumed conversation had it already.
  const prompt = key === MAIN && !resume ? [startPrompt(first, await readAlfredName(deps), v2, none)] : []
  return { on, folder, argv: coordinatorArgs(program, folder, p?.path, isPlainFolder(p), resume, model), prompt, machine: p?.machine || '', env: { WHERDR_PM_TOKEN: token, WHERDR_URL: url, DISABLE_AUTOUPDATER: '1' } }
}

// Starts the coordinator in its folder, with its model (else its harness's default), token in its environment,
// its folder's bin/ (the `wherdr` script) first in its PATH.
// first: messages it gets once ready, after its own start prompt.
// resume: its last conversation again (after its machine restarted, say), with
// the agent that ran it, instead of a new one.
export async function startCoordinator(deps: Deps, key: unknown, agent: { program?: unknown, model?: unknown, resume?: unknown }, urls: CoordinatorUrls, first: string[] = []) {
  if (typeof key !== 'string') throw new HerdrError('not_found', 'Unknown project')
  const projects = await deps.store.projects()
  const ws = coordinatorKey(key, projects)
  if (ws !== key) throw new HerdrError('refused', `${key} is a member of workspace ${ws}, whose coordinator handles its tasks: it has none of its own`)
  const before = await deps.store.coordinator(key)
  const resume = agent.resume === true
  if (resume && !before?.ran) throw new HerdrError('bad_input', 'No conversation to resume: start a new one')
  // No agent given: the project's default. Alfred: a program only, with its own default model.
  const a = resume ? agentOf(before!.ran!) : key === MAIN ? alfredAgent(agent.program ?? before?.agent?.program)
    : agentOf(agent.program === undefined ? before?.agent ?? FALLBACK : agent)
  if (!a) throw new HerdrError('bad_input', BAD_AGENT)
  if (!canRunCoordinator(a.program, key)) throw new HerdrError('bad_input', BAD_PROJECT_AGENT)
  const { program } = a
  if (resume && !canResume(program, key)) throw new HerdrError('bad_input', `Only a Claude, Codex, Devin, Cursor or Antigravity conversation${key === MAIN ? '' : ", or omp's for a project coordinator,"} can be resumed: start a new one`)
  const c = await prepareCoordinator(deps, key, program, urls, resume, a.model)
  // What the user applied on its cards while it did not run, said once (a resume too).
  const notes = cardNotesMessage(before)
  // Its very first start on a git project with no accepted workflow: its first reply proposes one.
  const git = key !== MAIN && projects.find(x => x.key === key)?.git !== false
  // A new workspace's: its first reply offers to build the map.
  const fresh = !resume && !before?.ran
  const proposes = fresh && isWorkspace(projects.find(x => x.key === key)) ? [WORKSPACE_FIRST]
    : git && fresh && isDefaultWorkflow(await deps.store.workflow(key)) ? [FIRST_REPLY] : []
  // First messages its last session never got (coordinatorFirst.ts): given again, once.
  // Alfred's start prompt is made anew at each start: an old one is not given again.
  const pending = c.prompt.length ? [] : (before?.undelivered?.texts ?? []).filter(x => !c.prompt.includes(x) && !first.includes(x) && !proposes.includes(x))
  const prompt = [...(PROMPT_LEAD[program] ? [PROMPT_LEAD[program]!] : []), ...c.prompt, ...first, ...proposes, ...pending, ...notes]
  // A resumed Codex reads a word after `resume --last` as a session: its messages are
  // typed. Devin's go on the resume line too, after `--` (PROMPT_ARG_FLAG).
  const asArg = promptAsArg(program, key) && (!resume || promptArgOnResume(program))
  // Codex takes one [PROMPT] argument: its messages go as one.
  const argv = [...c.argv, ...(asArg && prompt.length ? [...(PROMPT_ARG_FLAG[program] ? [PROMPT_ARG_FLAG[program]!] : []), prompt.join('\n\n')] : [])]
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  // A resumed Devin or Antigravity refuses to start while its old session
  // lives ("already open in another process" / "Conversation already open"):
  // it is ended before the new one runs, not after.
  if (resume && (program === 'devin' || program === 'agy') && before?.terminal) await deps.call('terminal.kill', { terminal: before.terminal }, 15000).catch(() => {})
  // One start at a time (coordinatorFirst.ts): the one before is up first.
  const up = await startTurn(deps)
  let address: string
  try {
    address = (await deps.call<{ address: string }>('terminal.run', {
      cwd: c.folder, ...(c.on ? { on: c.on } : {}), no_parent: true, wait: false, env: { ...c.env, ...await deps.proxyEnv?.(c.machine) },
      labels: { 'wherdr.install': await deps.store.install(), 'wherdr.coordinator': key },
      line: `${PATH_SETUP}; export PATH=${quote(`${c.folder}/bin`)}:"$PATH"; exec ${argv.map(quote).join(' ')}`,
    }, 30000)).address
  } catch (e) { up(); throw e }
  // Its folder is wherdr's own, new at its first start: its trust dialog is answered here.
  void answerOwnTrust(deps, address, c.folder).catch(() => {})
  // Alfred keeps the agent the user picked as its own (a project coordinator keeps its default).
  // version: what this session knows (takeUpdateNotice tells it of an update).
  // Typed messages stay queued on its record until each is sent (a restart delivers the rest).
  const { told: _told, cardNotes: _said, undelivered: _lost, ...rec } = (await deps.store.coordinator(key))!
  await deps.store.saveCoordinator({ ...rec, terminal: address, ran: a, version: wherdrVersion(), ...(key === MAIN ? { agent: a } : {}), ...(!asArg && prompt.length ? { undelivered: queuedFirst(prompt) } : {}) })
  // Its turn follows the user's clicks (issueToken cleared it): it may propose the next card.
  // Its first reply's workflow proposal follows the user's start. A replayed message
  // keeps no more than it can show it came with (WHR-512): the start's own proposal,
  // the user's; card notes, a card's; anything else (a relay, a report), a relay's.
  const said = [...proposes, ...pending, ...notes]
  const startProposal = (x: string) => x === FIRST_REPLY || x === WORKSPACE_FIRST
  const kind = [...proposes, ...pending].some(startProposal) ? 'user' : pending.every(x => cardNoteOf(x) !== null) ? 'card' : 'relay'
  if (said.length) await noteTurn(deps.store, key, kind, said.join('\n\n'))
  // Typed one after another once the program is ready (in the background: it may wait
  // on a dialog), each outcome logged; saved first, so that a failure stays on its record.
  // The start queue (startTurn) moves on once its session is up.
  // A fresh Claude, Codex or omp has them on its command line: watched until its session is up.
  void deliverFirst(deps, key, address, prompt, up, asArg).catch(() => up())
  // This conversation replaces the one before (another agent's, or ended).
  if (before?.terminal && before.terminal !== address) await deps.call('terminal.kill', { terminal: before.terminal }, 15000).catch(() => {})
  return { terminal: address, folder: c.folder }
}

// The folder trust dialog (Claude's, Codex's) on the coordinator's own folder,
// which wherdr made: answered once, so a first start does not stop on it.
// Watches until the agent is ready or gone, at most readyWatchMs (30 s).
export async function answerOwnTrust(deps: CoreAdminDeps, address: string, folder: string) {
  const end = Date.now() + (deps.readyWatchMs ?? 30_000)
  while (Date.now() < end) {
    const t = await deps.call<{ state?: string, status?: string | { state?: string } | null }>('terminal.get', { terminal: address }, 3000).catch(() => null)
    const state = typeof t?.status === 'string' ? t.status : t?.status?.state
    if (!t?.state || t.state === 'finished' || state === 'idle' || state === 'working') return false
    const screen = String((await deps.call<{ text?: string }>('terminal.read', { terminal: address, lines: 30 }, 3000).catch(() => null))?.text || '')
    const keys = trustKeys(screen, folder)
    if (keys) return deps.call('terminal.keys', { terminal: address, keys }, 10000).then(() => true)
    // A `done` status is where Antigravity sits on its trust box too: the
    // screen said whether it was asked, one read was enough.
    if (state === 'done') return false
    await new Promise(r => setTimeout(r, deps.pollMs ?? 500))
  }
  return false
}
