// A project coordinator on the server: its token (one per project, scoped to
// it), where its current turn comes from, the `wherdr pm` commands it runs,
// and its role files, written in its own folder on the project's machine.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { COORDINATOR_AGENTS, coordinatorArgs, parseCommand, roleFiles, stepDoneEvent, templateDiff, templateEditRefusal, type CoordinatorAgent, type CoordinatorView, type ProposalOutcome, type Turn } from '../../shared/pm/coordinator'
import { initialState, onEvent, planSteps, currentStep } from '../../shared/pm/steps'
import { templateChanges } from '../../shared/pm/templateText'
import { validateTemplate } from '../../shared/pm/workflow'
import { EXAMPLES } from '../../shared/pm/examples'
import { DEFAULT_AUTOPILOT, USER_ONLY, limitsLeft, tellRefusal } from '../../shared/pm/autopilot'
import { ackWakes } from '../../shared/pm/wakes'
import type { Template } from '../../shared/pm/workflow'
import { waitOf, type Task } from '../../shared/pm/run'
import { HerdrError } from './herdr'
import { PATH_SETUP, homeOf, machineOn, type CoreAdminDeps } from './coreCreate'
import { WRITE_SCRIPT, exec } from './pmLaunch'
import { userStep } from './pmBoard'
import type { PmStore } from './pmStore'

type Deps = CoreAdminDeps & { store: PmStore }
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

// Called by whatever delivers a message to the coordinator: the user's
// message from the interface (with its text) or an engine wake.
export async function noteTurn(store: PmStore, key: string, kind: 'user' | 'wake', said?: string) {
  const c = await store.coordinator(key)
  if (!c) throw new HerdrError('not_found', 'No coordinator for this project')
  const at = Date.now()
  await store.saveCoordinator({ ...c, turn: { kind, at, ...(kind === 'user' && said ? { said: said.slice(0, 500) } : {}) }, ...(kind === 'user' ? { userAt: at } : {}) })
}

const TURN_MS = 3_600_000

// The user's message sent from the interface to a terminal: when that
// terminal is a project coordinator, its turn now comes from the user.
export async function userMessageTo(store: PmStore, terminal: string | undefined, text: string) {
  if (!terminal || !(await store.enabled())) return
  const c = (await store.coordinators()).find(x => x.terminal === terminal)
  if (c) await noteTurn(store, c.project, 'user', text)
}

const planOf = (t: Template, task: Task) => planSteps(t, { type: task.type, ...(task.prefs ? { prefs: task.prefs } : {}) })
const summary = (t: Template | null, task: Task) => {
  const step = t ? currentStep(planOf(t, task), task.step ?? initialState()) : undefined
  return { id: task.id, title: task.title, type: task.type, state: task.state, step: step?.id, holder: step?.holder, yourTurn: task.step?.yourTurn?.badge, tags: task.tags, links: task.links }
}

const unb64 = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('utf8') : v)

// POST /api/pm/cli: { argv, input? } with the coordinator's token, or
// { argv64, input64 } from the folder's `wherdr` script.
export async function runCommand(deps: Deps, token: unknown, body: { argv?: unknown, input?: unknown, argv64?: unknown, input64?: unknown }) {
  const { store } = deps
  const key = await scopeOf(store, token)
  if (!key) throw new HerdrError('forbidden', 'Unknown coordinator token')
  if (Array.isArray(body.argv64)) body = { argv: body.argv64.map(unb64), input: unb64(body.input64) }
  const words = Array.isArray(body.argv) ? body.argv.filter(a => typeof a === 'string' && !a.startsWith('--')) : []
  const userOnly = USER_ONLY[words.slice(0, 2).join(' ')] ?? USER_ONLY[words[0] ?? '']
  if (userOnly) throw new HerdrError('refused', userOnly)
  const cmd = parseCommand(body.argv)
  if ('error' in cmd) throw new HerdrError('bad_input', cmd.error)
  const projects = await store.projects()
  const p = projects.find(x => x.key === key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = p.template ? await store.template(p.template) : null
  const rec = await store.coordinator(key)
  // A turn the server saw start over an hour ago is not trusted any more.
  const turn: Turn = rec?.turn && Date.now() - rec.turn.at < TURN_MS ? rec.turn.kind : 'none'
  const by = `coordinator ${key}`
  // Another project's task reads as unknown: the token sees its project only.
  const taskOf = async (id: string) => {
    const task = await store.task(id)
    if (!task || task.project !== key) throw new HerdrError('not_found', 'Unknown task')
    return task
  }
  const needPlan = () => { if (!t) throw new HerdrError('not_found', 'The project has no template'); return t }

  switch (cmd.name) {
    case 'list': return { tasks: (await store.tasks()).filter(x => x.project === key).map(x => summary(t, x)) }
    case 'show': { const task = await taskOf(cmd.task); return { task: { ...summary(t, task), description: task.description, log: task.log ?? [] }, plan: t ? planOf(t, task) : [] } }
    case 'plan': return { template: t && { id: t.id, version: t.version }, plans: Object.fromEntries(Object.keys(needPlan().taskTypes).map(type => [type, planSteps(t!, { type })])) }
    case 'template show': return {
      template: needPlan(),
      ...(rec?.proposal ? { proposal: 'waiting for the user in wherdr', diff: rec.proposal.diff } : rec?.answered ? { lastProposal: rec.answered.outcome } : {}),
    }
    case 'template edit': {
      let next: Template
      try { next = JSON.parse(String(body.input ?? '')) as Template } catch { throw new HerdrError('bad_input', 'The new template is not valid JSON') }
      await editRefusal(store, key, t, next, turn)
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
      const plan = planOf(needPlan(), task)
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
      const r = ackWakes(await store.wakes(), key, cmd.wakes, Date.now())
      if (r.unknown.length) throw new HerdrError('not_found', `No wake ${r.unknown.join(', ')} was delivered to you`)
      await store.saveWakes(r.changed)
      return { acked: cmd.wakes }
    }
    case 'autopilot show': {
      const ap = rec?.autopilot ?? DEFAULT_AUTOPILOT
      const mine = (await store.tasks()).filter(x => x.project === key)
      return { autopilot: ap, today: limitsLeft(ap, mine, await store.runs(), Date.now()), note: 'Only the user changes these, in wherdr' }
    }
    case 'tell': {
      const task = await taskOf(cmd.task)
      const run = task.run ? (await store.runs()).find(r => r.id === task.run) : undefined
      if (!run?.terminal || run.state === 'ended') throw new HerdrError('not_found', 'The task\'s agent is not running')
      // What the agent waits for now, from its terminal: a permission prompt is never typed into.
      const live = waitOf(await deps.call<Parameters<typeof waitOf>[0]>('terminal.get', { terminal: run.terminal }, 3000).catch(() => null))
      const why = tellRefusal({ state: live ? 'waiting' : task.state, waitKind: live ?? task.waitKind }, turn !== 'user')
      if (why) throw new HerdrError('refused', why)
      await deps.call('terminal.send', { terminal: run.terminal, text: `From the project coordinator: ${cmd.text}` }, 30000)
      const saved = await store.logTask(task.state === 'waiting' && task.waitKind === 'question' ? { ...task, state: 'working', waiting: undefined, waitKind: undefined } : task, by, `told the agent: ${cmd.text.slice(0, 300)}`)
      return { task: saved }
    }
    case 'task decide': {
      const task = await taskOf(cmd.task)
      const r = onEvent(planOf(needPlan(), task), task.step ?? initialState(), { kind: 'decide', by: 'coordinator', choice: cmd.choice, note: cmd.reason }, Date.now())
      if (r.refused) throw new HerdrError('refused', r.refused)
      const line = r.effects.flatMap(e => (e.kind === 'log' ? [e.text] : [])).join('; ')
      return { task: await store.logTask({ ...task, step: r.state }, by, line), effects: r.effects.filter(e => e.kind !== 'log') }
    }
  }
}

// Why the coordinator may not change the template to `next`; the same checks
// when the user accepts it later, against the template as it is then.
async function editRefusal(store: PmStore, key: string, t: Template | null, next: Template, turn: Turn) {
  const why = templateEditRefusal(t, next, turn)
  if (why) throw new HerdrError('refused', why)
  const other = (await store.projects()).find(x => x.key !== key && x.template === t!.id)
  if (other) throw new HerdrError('refused', `Template ${t!.id} is also used by project ${other.key}: the user changes it in Settings › Projects`)
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
  const t = p?.template ? await store.template(p.template) : null
  // Its diff was made against that version: saved over a newer one, it would
  // undo a change the user made since.
  if ((t?.version ?? 1) !== proposal.base) {
    await done('outdated: the template changed since, propose again')
    throw new HerdrError('refused', 'The template changed since this proposal: ask the coordinator to propose again')
  }
  await editRefusal(store, rec.project, t, proposal.template, 'user')
  await store.saveTemplate(proposal.template, { replace: true, by: `coordinator ${rec.project}`, said: proposal.said })
  await done('accepted')
  await writeRoleFiles(deps, rec.project).catch(() => {})
  return { accepted: true }
}

const agentOf = (v: { program?: unknown, model?: unknown }): CoordinatorAgent | null => {
  const program = v.program === 'codex' ? 'codex' : v.program === 'claude' ? 'claude' : null
  return program && typeof v.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,63}$/.test(v.model) ? { program, model: v.model } : null
}

// The project's default coordinator agent, changed in one gesture.
export async function setCoordinatorAgent(store: PmStore, key: unknown, agent: { program?: unknown, model?: unknown }) {
  const a = agentOf(agent)
  if (!a) throw new HerdrError('bad_input', 'program: claude or codex, and a model')
  if (typeof key !== 'string' || !(await store.projects()).some(p => p.key === key)) throw new HerdrError('not_found', 'Unknown project')
  await store.saveCoordinator({ project: key, tokenHash: '', ...(await store.coordinator(key)), agent: a })
  return { agent: a }
}

// Each project's coordinator: who answers, the agent of its kept conversation, its pending change.
export async function coordinatorsView(store: PmStore): Promise<CoordinatorView[]> {
  if (!(await store.enabled())) return []
  return Promise.all((await store.projects()).map(async (p) => {
    const c = await store.coordinator(p.key)
    return {
      project: p.key, name: p.name, agent: c?.agent ?? COORDINATOR_AGENTS[0]!,
      ...(c?.ran ? { ran: c.ran } : {}), ...(c?.terminal ? { terminal: c.terminal } : {}),
      ...(c?.proposal ? { proposal: { diff: c.proposal.diff, at: c.proposal.at, ...(c.proposal.said ? { said: c.proposal.said } : {}) } } : {}),
    }
  }))
}

// The role files (and the `wherdr` script) in the coordinator's own folder,
// ~/.wherdr/pm/coordinators/<KEY> on the project's machine; never ~/.claude
// or ~/.codex.
async function writeRoleFiles(deps: Deps, key: string) {
  const { store } = deps
  const p = (await store.projects()).find(x => x.key === key)
  if (!p) throw new HerdrError('not_found', 'Unknown project')
  const t = p.template ? await store.template(p.template) : null
  const { m, on } = machineOn(deps, p.machine)
  const home = await homeOf(deps, on)
  if (!home) throw new HerdrError('core', 'Home folder not found on the project\'s machine')
  const folder = `${home}/.wherdr/pm/coordinators/${key}`
  for (const [file, text] of Object.entries(roleFiles(p, t, EXAMPLES)))
    if ((await exec(deps, on, WRITE_SCRIPT, [`${folder}/${file}`], text)).code !== 0) throw new HerdrError('core', `Could not write ${file}`)
  await exec(deps, on, 'chmod 755 "$1"', [`${folder}/bin/wherdr`])
  return { p, local: !!m.local, on, folder }
}

// Where the coordinator reaches wherdr: loopback on the wherdr host; from
// another machine, wherdr's published (tailnet) address.
export interface CoordinatorUrls { local: string, remote?: string }

// When a project coordinator starts: its files, a new token, how to start it.
export async function prepareCoordinator(deps: Deps, key: string, agent: { program: 'claude' | 'codex', model: string }, urls: CoordinatorUrls) {
  const { p, local, on, folder } = await writeRoleFiles(deps, key)
  const url = local ? urls.local : urls.remote
  if (!url) throw new HerdrError('unreachable', 'The project\'s machine cannot reach this wherdr: publish it on your tailnet first (Settings › Phone)')
  const token = await issueToken(deps.store, key)
  return { on, folder, argv: coordinatorArgs(agent.program, agent.model, folder, p.path), env: { WHERDR_PM_TOKEN: token, WHERDR_URL: url, DISABLE_AUTOUPDATER: '1' } }
}

// Starts the coordinator in its folder, model pinned, token in its environment,
// its folder's bin/ (the `wherdr` script) first in its PATH.
export async function startCoordinator(deps: Deps, key: unknown, agent: { program?: unknown, model?: unknown }, urls: CoordinatorUrls) {
  if (typeof key !== 'string') throw new HerdrError('not_found', 'Unknown project')
  // No agent given: the project's default.
  const a = agent.program === undefined ? (await deps.store.coordinator(key))?.agent ?? COORDINATOR_AGENTS[0]! : agentOf(agent)
  if (!a) throw new HerdrError('bad_input', 'program: claude or codex, and a model')
  const { program, model } = a
  const before = await deps.store.coordinator(key)
  const c = await prepareCoordinator(deps, key, { program, model }, urls)
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
  const { address } = await deps.call<{ address: string }>('terminal.run', {
    cwd: c.folder, ...(c.on ? { on: c.on } : {}), no_parent: true, wait: false, env: c.env,
    labels: { 'wherdr.install': await deps.store.install(), 'wherdr.coordinator': key },
    line: `${PATH_SETUP}; export PATH=${quote(`${c.folder}/bin`)}:"$PATH"; exec ${c.argv.map(quote).join(' ')}`,
  }, 30000)
  await deps.store.saveCoordinator({ ...(await deps.store.coordinator(key))!, terminal: address, ran: { program, model } })
  // A new conversation replaces the one before (another agent's, or ended).
  if (before?.terminal && before.terminal !== address) await deps.call('terminal.kill', { terminal: before.terminal }, 15000).catch(() => {})
  return { terminal: address, folder: c.folder }
}
