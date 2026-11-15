// `wherdr alfred …` on the server: Alfred's token, kept in a file of its home
// (never in its environment, never sent off this machine), and its commands.
// A change is only described unless the call says --apply; Alfred applies it
// after the user's yes. Nothing here removes data.
import path from 'node:path'
import { CHANGES, SETTING_TARGETS, SETTING_VALUES, alfredCommandList, dryRun, memoryLines, parseAlfredCommand, workflowEditRefusal, type AlfredPlan } from '../../shared/pm/alfredCli'
import { GUARDED_PROGRAMS, MAIN, templateDiff, type CoordinatorAgent } from '../../shared/pm/coordinator'
import { validateTemplate, type Template } from '../../shared/pm/workflow'
import { templateChanges } from '../../shared/pm/templateText'
import { ALFRED } from '../../shared/pm/alfred'
import { offeredAgents, readAgentOrder, readHiddenAgents } from '../../shared/agentList'
import { allowedMachines, cleanProjectInput, cleanProjectUpdate, machinesOf } from '../../shared/pm/project'
import { keyClash, projectOf as findProject, shownKey } from '../../shared/pm/projectKey'
import { HerdrError } from './herdr'
import { alfredTokenOk, appendCoordinatorMemory, coordinatorsView, noteTurn, startCoordinator, v2Projects, type CoordinatorUrls } from './pmCoordinator'
import type { V2Candidate } from './v2Board'
import type { CoreAdminDeps } from './coreCreate'
import { resendFirst } from './coordinatorFirst'
import { lastWords } from './pmRead'
import type { FolderCheck, PmStore } from './pmStore'
import { readSettings } from './settings'
import { addChangeCard, addSettingCard } from './uiActions'
import { CHANGE_PLACES, choiceArgv, type CardChoice } from '../../shared/uiActions'
import { UI_TARGETS } from '../../shared/uiTargets'
import { saveProjectGuards } from './pmProject'
import { checkMachine } from './pmReady'
import { projectPlace } from '../../shared/pm/places'
import { EXAMPLES } from '../../shared/pm/examples'
import { DATA_DIR } from './env'
import { openUi, uiTargetsList, type UiOpenDeps } from './uiOpen'
import { notesStore, runNotes, type NotesStore } from './notesStore'

type Deps = CoreAdminDeps & { store: PmStore, check: FolderCheck, urls: CoordinatorUrls, settingsFile?: string, dataDir?: string, notes?: NotesStore, herdrProjects?: string, clients?: UiOpenDeps['clients'] }

// The command a card keeps: without --propose; a card with checkboxes, without --only and --start too.
function cardArgv(argv: string[], picks: boolean) {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--propose') continue
    if (picks && (argv[i] === '--only' || argv[i] === '--start')) { i++; continue }
    out.push(argv[i]!)
  }
  return out
}

// A turn the server saw start over an hour ago is not trusted any more (as a coordinator's).
const TURN_MS = 3_600_000

const unb64 = (v: unknown) => (typeof v === 'string' ? Buffer.from(v, 'base64').toString('utf8') : v)

// POST /api/alfred/cli: { argv } (or { argv64 } from Alfred's `wherdr` script).
export async function runAlfredCommand(deps: Deps, token: unknown, body: { argv?: unknown, argv64?: unknown, input?: unknown, input64?: unknown }) {
  if (!(await alfredTokenOk(deps.store, token))) throw new HerdrError('forbidden', 'Unknown Alfred token')
  const argv = Array.isArray(body.argv64) ? body.argv64.map(unb64) : body.argv
  return alfredCommand(deps, argv, body.input64 !== undefined ? unb64(body.input64) : body.input)
}

// The user's Apply on a change Alfred proposed (POST /api/ui/act): the same
// command, made only while its dry run still shows the card's lines (null:
// it no longer does); its outcome's lines, one per project of a `v2 import`.
export async function applyProposedChange(deps: Deps, argv: string[], lines: string[], choice?: CardChoice): Promise<string[] | null> {
  const out = await alfredCommand(deps, choiceArgv(argv, choice), undefined, lines) as { applied?: boolean, result?: { outcome?: string[] } }
  return out.applied === true ? out.result?.outcome ?? [] : null
}

// card: the lines of the proposal the user applies (no token: their click).
async function alfredCommand(deps: Deps, argv: unknown, input: unknown, card?: string[]) {
  const cmd = parseAlfredCommand(argv)
  if ('error' in cmd) throw new HerdrError('bad_input', cmd.error)
  const { store } = deps
  const projects = await store.projects()
  const machines = deps.machines()
  const projectOf = (key: string) => {
    const p = findProject(projects, key)
    if (!p) throw new HerdrError('not_found', `Unknown project ${key}: ${projects.map(shownKey).join(', ') || 'none yet'}`)
    return p
  }
  const machineName = (key: string) => (key ? machines.find(m => m.key === key)?.label ?? key : 'this machine')
  const remoteOf = (key: string) => (key && !machines.find(m => m.key === key)?.local ? machineName(key) : undefined)
  const needPm = async () => { if (!(await store.enabled())) throw new HerdrError('pm_off', `Projects are off: the user switches them on in ${projectPlace(undefined, 'general', true)}`) }
  const knownTemplate = async (id: string) => {
    if (id && !EXAMPLES.some(e => `example:${e.id}` === id) && !(await store.overview()).templates.some(t => t.id === id)) throw new HerdrError('not_found', `No template ${id} (see wherdr alfred templates)`)
  }
  // A project coordinator's agent: its default while the user offers it, else
  // their first offered agent that can run it (Settings › Agents), else Claude.
  const projectAgent = async (key: string): Promise<CoordinatorAgent> => {
    const s = await readSettings(deps.settingsFile)
    const offered = offeredAgents(GUARDED_PROGRAMS, readHiddenAgents(s.hiddenAgents ?? null), readAgentOrder(s.agentOrder ?? null)) as CoordinatorAgent['program'][]
    const own = (await coordinatorsView(store)).find(x => x.project === key)?.agent
    return own && offered.includes(own.program) ? own : { program: offered[0] ?? 'claude' }
  }
  // Its conversation runs: its terminal is a live pane. stopped: it ended (its
  // machine restarted, say), and `coordinator start --resume` takes it up again.
  const runState = (terminal?: string) => (!terminal ? { running: false } : deps.panes().some(p => p.coreAddress === terminal) ? { running: true } : { running: false, stopped: true })
  // Alfred's own turn: from the user's message, or a wake (or too old to know).
  const alfredTurn = async () => {
    const t = (await store.coordinator(MAIN))?.turn
    return t && Date.now() - t.at < TURN_MS ? t : undefined
  }
  // The project coordinator's terminal, when it runs.
  const coordinatorPane = async (key: string) => {
    const c = await store.coordinator(key)
    return c?.terminal ? deps.panes().find(p => p.coreAddress === c.terminal) : undefined
  }
  // A change: its plan, then (with --apply, or the user's Apply on its card
  // while the plan is the same) the change itself; --propose: the card.
  // picks, on, start: a card with a checkbox per line (v2 import); the click
  // gives --only and --start again, so the card's argv leaves them out.
  const change = async (plan: AlfredPlan & { picks?: (string | null)[], on?: string[], start?: boolean, pm?: true }, make: () => Promise<unknown>) => {
    if (card) return plan.change.join('\n') === card.join('\n') ? { applied: true, change: plan.change, result: await make() } : { stale: true }
    if ('apply' in cmd && cmd.apply) return { applied: true, change: plan.change, result: await make() }
    if (!('propose' in cmd && cmd.propose)) return dryRun(argv as string[], plan)
    const key = 'input' in cmd ? cmd.input.key : 'key' in cmd ? cmd.key : '', place = CHANGE_PLACES[cmd.name]!, turn = await alfredTurn()
    const target = cmd.name === 'project add' ? undefined : place.target
    return addChangeCard(store, { turn: turn?.kind ?? 'none', by: ALFRED, label: place.label(key), change: { argv: cardArgv(argv as string[], !!plan.picks), lines: plan.change, project: key, ...(plan.picks ? { picks: plan.picks, ...(plan.on ? { on: plan.on } : {}), start: plan.start, ...(plan.pm ? { pm: plan.pm } : {}) } : {}), ...(turn?.said ? { said: turn.said } : {}), ...(target ? { target } : {}) } })
  }

  switch (cmd.name) {
    case 'help': return { commands: alfredCommandList(), note: `Changes (${CHANGES.join(', ')}) are only shown without --apply` }
    case 'projects': return { enabled: await store.enabled(), projects: projects.map(p => ({ ...p, machineName: machineName(p.machine) })) }
    case 'project': {
      const p = projectOf(cmd.key)
      const c = (await coordinatorsView(store)).find(x => x.project === p.key)
      const tasks: Record<string, number> = {}
      for (const t of await store.tasks()) if (t.project === p.key) tasks[t.state] = (tasks[t.state] ?? 0) + 1
      return { project: { ...p, machineName: machineName(p.machine) }, coordinator: c && { agent: (await projectAgent(p.key)).program, ...runState(c.terminal), ...(c.proposal ? { proposalWaits: { by: c.proposal.by === 'main' ? ALFRED : 'the coordinator', at: c.proposal.at } } : {}) }, tasks }
    }
    case 'templates': return { templates: (await store.overview()).templates, examples: EXAMPLES.map(e => ({ id: `example:${e.id}`, instructions: e.instructions, taskTypes: Object.keys(e.taskTypes), guards: e.guards })) }
    case 'v2': {
      const candidates = await v2Projects(store, deps.herdrProjects)
      if (!candidates.length) return { fromV2: false }
      // The v3 project made from each: same folder (on any machine) or same name.
      const made = (c: V2Candidate) => projects.find(p => p.path === c.path || p.name === c.name)?.key ?? null
      return {
        fromV2: true, report: path.join(deps.dataDir ?? DATA_DIR, 'migration-report.md'),
        projects: candidates.map(c => ({ ...c, project: made(c) })),
        note: 'Read now from the herdr-projects board of this machine (read only). Folders are those of the machine v2 ran on (this one). Bring them over with wherdr alfred v2 import --propose (one card); add tasks again with wherdr pm task add once the project is added',
      }
    }
    case 'v2 import': {
      // Projects off: the card turns them on with its own checkbox; the change itself needs them on.
      const off = !(await store.enabled())
      // Each v2 project not made yet, on this machine (where v2 ran), its folder checked now (read only).
      const rows = await Promise.all((await v2Projects(store, deps.herdrProjects))
        .filter(c => !projects.some(p => p.path === c.path || p.name === c.name))
        .map(async (c) => {
          const why = await deps.check('', c.path).then(() => '', (e: Error) => e.message)
          return { c, why, line: `${c.key} "${c.name}" on this machine, folder ${c.path}${why ? `: cannot be added: ${why}` : ''}` }
        }))
      if (!rows.length) throw new HerdrError('not_found', 'No v2 project left to bring over (see wherdr alfred v2)')
      const only = cmd.only && new Set(cmd.only)
      return change({ change: rows.map(r => r.line), picks: rows.map(r => (r.why ? null : r.c.key)), ...(cmd.only ? { on: cmd.only } : {}), start: cmd.start, ...(off ? { pm: true as const } : {}) }, async () => {
        await needPm()
        // One project failing does not stop the others: each line says what happened.
        const outcome: string[] = []
        for (const { c, why } of rows) {
          if (why || (only && !only.has(c.key))) continue
          try { await store.addProject({ key: c.key, name: c.name, machine: '', path: c.path, ...(c.base ? { base: c.base } : {}) }, deps.check) }
          catch (e) { outcome.push(`${c.key}: not added: ${(e as Error).message}`); continue }
          if (!cmd.start) { outcome.push(`${c.key}: added`); continue }
          // No workflow needed: the minimal default; its first reply proposes one (startCoordinator).
          try { await startCoordinator(deps, c.key, await projectAgent(c.key), deps.urls); outcome.push(`${c.key}: added, coordinator started (its first message is typed once it is ready)`) }
          catch (e) { outcome.push(`${c.key}: added; coordinator not started: ${(e as Error).message}`) }
        }
        return { outcome }
      })
    }
    case 'machines': return { machines: machines.map(m => ({ key: m.key, label: m.label, local: m.local, status: m.status })) }
    case 'coordinators': return { coordinators: await Promise.all((await coordinatorsView(store)).map(async c => ({ project: c.project, name: c.name, agent: c.main ? c.agent?.program : (await projectAgent(c.project)).program, ...runState(c.terminal), ...(c.undelivered ? { firstMessage: `not delivered: ${c.undelivered.why}; tell the user, and send it again with wherdr alfred coordinator resend ${c.project}` } : {}) }))) }
    case 'coordinator resend': {
      const k = findProject(projects, cmd.key)?.key ?? cmd.key
      return { ...await resendFirst(deps, k, async () => startCoordinator(deps, k, await projectAgent(k), deps.urls)), next: `wherdr alfred coordinators says whether it got it` }
    }
    case 'coordinator open': {
      const c = (await coordinatorsView(store)).find(x => x.project === (findProject(projects, cmd.key)?.key ?? cmd.key))
      const pane = c?.terminal ? deps.panes().find(p => p.coreAddress === c.terminal) : undefined
      if (!pane) throw new HerdrError('not_found', `The coordinator of ${cmd.key} is not running: start it with wherdr alfred coordinator start ${cmd.key}`)
      return { link: `${deps.urls.remote ?? deps.urls.local}/#/a/${encodeURIComponent(pane.id)}`, note: 'Give the user this link; the sidebar shows it too' }
    }
    case 'ui targets': return uiTargetsList()
    case 'notes': return runNotes(deps.notes ?? notesStore(path.join(deps.dataDir ?? DATA_DIR, 'notes')), cmd.notes, input, { by: ALFRED }, deps.settingsFile, machines)
    case 'ui open': return openUi({ ...deps, clients: deps.clients ?? (() => []) }, { scope: MAIN, main: true, raw: cmd.link, turn: (await alfredTurn())?.kind ?? 'none', by: ALFRED })
    case 'settings': return { settings: await readSettings(deps.settingsFile), values: SETTING_VALUES, note: 'Alfred changes only the settings listed in values, to one of their values (1 = on, 0 = off)' }
    case 'setting set': {
      const old = (await readSettings(deps.settingsFile))[cmd.key]
      if (old === cmd.value) return { unchanged: true, [cmd.key]: old }
      const line = `setting ${cmd.key}: ${old === undefined ? '(default)' : JSON.stringify(old)} → ${JSON.stringify(cmd.value)}`
      if (!cmd.propose) return { dryRun: true, change: [line], next: `To propose it, run the same command with --propose: the user applies it from the card in your reply` }
      const turn = await alfredTurn(), target = SETTING_TARGETS[cmd.key]
      return addSettingCard(store, { turn: turn?.kind ?? 'none', by: ALFRED, label: target ? UI_TARGETS[target].label : cmd.key, change: { key: cmd.key, ...(old === undefined ? {} : { before: old }), after: cmd.value, ...(turn?.said ? { said: turn.said } : {}), ...(target ? { target } : {}) } })
    }
    case 'project add': {
      await needPm()
      // The machine by its key or its label.
      const m = machines.find(x => x.key === cmd.input.machine) ?? machines.find(x => x.label === cmd.input.machine)
      if (!m && cmd.input.machine) throw new HerdrError('not_found', `Unknown machine ${cmd.input.machine} (see wherdr alfred machines)`)
      const { project, errors } = cleanProjectInput({ ...cmd.input, machine: m?.key ?? '' })
      if (!project) throw new HerdrError('bad_input', errors.map(e => `${e.path}: ${e.message}`).join('; '))
      if (keyClash(projects, project.key)) throw new HerdrError('exists', 'A project already has this key')
      await knownTemplate(project.template ?? '')
      // The folder checks --apply makes (inside the home folder, a git
      // repository, not already a project): read-only, so run before the
      // user's yes on this machine; on another, only once the user asked.
      const remote = remoteOf(project.machine)
      const checked = remote ? project.path : await deps.check(project.machine, project.path)
      const folder = typeof checked === 'string' ? checked : checked.path
      const same = projects.find(p => p.machine === project.machine && p.path === folder)
      if (same) throw new HerdrError('exists', `This folder is already a project: ${shownKey(same)}`)
      return change({
        change: [`add project ${project.key} "${project.name}"`,
          remote ? `folder ${folder} on ${machineName(project.machine)} (checked when applied: inside the home folder, a git repository, not already a project)` : `folder ${folder} on ${machineName(project.machine)} (checked: a git repository)`,
          `template ${project.template ?? 'none'}`],
        remote,
      }, () => store.addProject(project, deps.check))
    }
    case 'project template': {
      await needPm()
      const p = projectOf(cmd.key)
      await knownTemplate(cmd.template)
      if (!cmd.template && !p.from) return { unchanged: true, project: p.key, template: 'none' }
      return change({ change: [`project ${p.key} template: ${p.from?.template ?? 'none'} → ${cmd.template || 'none'}`] }, () => store.setTemplate(p.key, cmd.template))
    }
    case 'project memory': {
      await needPm()
      const p = projectOf(cmd.key)
      const lines = memoryLines(input)
      if ('error' in lines) throw new HerdrError('bad_input', lines.error)
      return change({ change: [`add to the end of the memory.md of ${p.key}'s coordinator, on ${machineName(p.machine)}:`, ...lines], remote: remoteOf(p.machine) }, () => appendCoordinatorMemory(deps, p.key, lines))
    }
    case 'project workflow edit': {
      await needPm()
      const p = projectOf(cmd.key)
      const old = await store.workflow(p.key)
      let next: Template
      try { next = JSON.parse(String(input ?? '')) as Template } catch { throw new HerdrError('bad_input', 'The new workflow is not valid JSON (give it on stdin)') }
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new HerdrError('bad_input', 'The new workflow is a JSON object')
      // Always the project's own workflow, whatever id the JSON names.
      if (old) next = { ...next, id: old.id }
      const turn = await alfredTurn()
      const why = workflowEditRefusal(old, next, turn?.kind ?? 'none', p.key)
      if (why) throw new HerdrError('refused', why)
      const errors = validateTemplate(next)
      if (errors.length) throw new HerdrError('bad_input', errors.map(e => `${e.path}: ${e.message}`).join('; '))
      // Saved where the coordinator's proposal waits: the user answers it in the same review.
      const rec = await store.coordinator(p.key)
      const proposal = { template: next, diff: templateDiff(old, next), at: Date.now(), base: old!.version ?? 1, by: 'main', ...(turn?.said ? { said: turn.said, saidAt: turn.at } : {}) }
      await store.saveCoordinator({ project: p.key, tokenHash: '', ...rec, proposal })
      return {
        proposed: true, changes: templateChanges(old, next), diff: proposal.diff,
        ...(rec?.proposal ? { replaced: `the change proposed by ${rec.proposal.by === 'main' ? 'you' : 'the coordinator'} that waited` } : {}),
        next: `The user accepts or refuses it in ${projectPlace(p.key, 'workflow', true)}; wherdr alfred project ${p.key} shows whether it still waits`,
      }
    }
    case 'tell': {
      await needPm()
      const p = projectOf(cmd.key)
      const pane = await coordinatorPane(p.key)
      const started = !pane
      // Alfred's text may already start with it: never "From Alfred: From Alfred:".
      const said = cmd.text.replace(new RegExp(`^\\s*From ${ALFRED}:\\s*`, 'i'), '')
      const text = `From ${ALFRED}: ${said}`
      // Not running: started with the message, typed once it is ready (coordinatorFirst.ts).
      const terminal = pane?.coreAddress ?? (await startCoordinator(deps, p.key, await projectAgent(p.key), deps.urls, [text])).terminal
      // The coordinator's turn is the user's when Alfred relays the user's message; a wake's otherwise.
      const turn = await alfredTurn()
      await noteTurn(store, p.key, turn?.kind === 'user' ? 'user' : 'wake', turn?.said)
      if (!started) await deps.call('terminal.send', { terminal, text }, 30000)
      await store.logProject(p.key, { by: ALFRED, text: `told the coordinator: ${said.slice(0, 300)}`, ...(turn?.said ? { said: turn.said } : {}) })
      return { told: p.key, ...(started ? { started: `its coordinator was not running: started on ${machineName(p.machine)}, the message goes once it is ready` } : {}), next: `Read its answer later with wherdr alfred last ${p.key}` }
    }
    case 'last': {
      const p = projectOf(cmd.key)
      const pane = await coordinatorPane(p.key)
      if (!pane) throw new HerdrError('not_found', `The coordinator of ${p.key} is not running: wherdr alfred tell ${p.key} "<text>" starts it`)
      const said = await lastWords(deps, pane.coreAddress!)
      if (!said) throw new HerdrError('unreachable', `Nothing to read from the coordinator of ${p.key}: its conversation and its terminal are out of reach`)
      return { project: p.key, working: pane.status === 'working', ...said }
    }
    case 'project guards': {
      await needPm()
      const p = projectOf(cmd.key)
      const t = await store.workflow(p.key)
      if (!t) throw new HerdrError('not_found', `Project ${p.key} has no workflow: give it a template first`)
      const old = t.guards ?? {}, { protect, mergeProtected, mergeOthers, contributorPrs } = cmd.change
      if (!protect && !mergeProtected && !mergeOthers && !contributorPrs) return { project: p.key, guards: old }
      const merge = { ...old.merge, ...(mergeProtected ? { protected: mergeProtected } : {}), ...(mergeOthers ? { others: mergeOthers } : {}) }
      const branches = protect ?? old.protected
      const cp = contributorPrs ? (contributorPrs === 'off' ? undefined : contributorPrs) : old.contributorPrs
      const guards = { ...(branches ? { protected: branches } : {}), ...(Object.keys(merge).length ? { merge } : {}), ...(cp ? { contributorPrs: cp } : {}) }
      return change({ change: [`project ${p.key} guards: ${JSON.stringify(old)} → ${JSON.stringify(guards)}`] }, () => saveProjectGuards(store, p.key, guards, 'Alfred', deps))
    }
    case 'project machine': {
      await needPm()
      const p = projectOf(cmd.key)
      const allowed = allowedMachines(p).slice(1)
      // The machine by its key or its label; one no longer known is removed by its key.
      const m = machines.find(x => x.key === cmd.machine) ?? machines.find(x => x.label === cmd.machine)
      const mk = m?.key ?? (cmd.action === 'remove' && allowed.includes(cmd.machine) ? cmd.machine : undefined)
      if (mk === undefined) throw new HerdrError('not_found', `Unknown machine ${cmd.machine} (see wherdr alfred machines)`)
      if (mk === p.machine) throw new HerdrError('bad_input', `${machineName(mk)} is the project's own machine`)
      if (cmd.action === 'remove') {
        if (!allowed.includes(mk)) return { unchanged: true, project: p.key, machines: allowedMachines(p).map(machineName) }
        return change({ change: [`project ${p.key}: its tasks no longer start on ${machineName(mk)} (tasks already there stay)`] },
          () => store.updateProject(p.key, { machines: allowed.filter(x => x !== mk) }))
      }
      const { update, errors } = cleanProjectUpdate({ machines: [...allowed.filter(x => x !== mk), mk], clones: { [mk]: cmd.clone } })
      const bad = update ? machinesOf(p, update).errors : errors
      if (!update || bad.length) throw new HerdrError('bad_input', bad.map(e => `${e.path}: ${e.message}`).join('; '))
      return change({
        change: [`project ${p.key}: its tasks may run on ${machineName(mk)}, in its clone ${update.clones![mk]}`, `then the readiness check of ${machineName(mk)} runs (read-only)`],
        remote: remoteOf(mk),
      }, async () => {
        const project = await store.updateProject(p.key, update)
        const ready = await checkMachine(deps, p.key, mk).catch((e: Error) => ({ refused: e.message }))
        return { project, ready }
      })
    }
    case 'coordinator start': {
      await needPm()
      const p = projectOf(cmd.key)
      const rec = await store.coordinator(p.key)
      if (cmd.resume && !rec?.ran) throw new HerdrError('bad_input', `The coordinator of ${p.key} has no conversation to resume: start a new one without --resume`)
      const agent = cmd.resume ? rec!.ran! : cmd.program ? { program: cmd.program } : await projectAgent(p.key)
      const running = runState(rec?.terminal).running
      return change({
        change: cmd.resume
          ? [`resume the last conversation of the coordinator of ${p.key} with ${agent.program} on ${machineName(p.machine)}`, ...(running ? ['its running terminal is stopped and replaced'] : [])]
          : [`start the coordinator of ${p.key} with ${agent.program} on ${machineName(p.machine)}`, ...(running ? ['its running conversation is stopped and replaced by a new one'] : [])],
        remote: remoteOf(p.machine),
      }, () => startCoordinator(deps, p.key, cmd.resume ? { resume: true } : agent, deps.urls))
    }
  }
}
