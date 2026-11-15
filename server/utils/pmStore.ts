// Project management storage, in DATA_DIR/projects/ (one engine, on the wherdr
// host): pm.json (the on/off switch and this install's id), projects.json,
// templates/<id>.json, template-log/<id>.json (the template library),
// workflows/<KEY>.json, workflow-log/<KEY>.json (each project's own copy, what its tasks follow), project-log/<KEY>.json, tasks/<KEY>-<n>.json, runs/<id>.json, receipts/<id>.json,
// shots/<KEY>-<n>/<file> (a task's screenshots),
// coordinators/<KEY>.json (the hash of the coordinator's token, its current turn, its autopilot),
// wakes.jsonl (the coordinators' wake queue, append-only: the last line of an id wins),
// automations/<KEY>.json (the project's automations and where its tasks stood at the last tick),
// incidents.json (why agents were gone, newest last: shared/pm/incident.ts),
// maps/<WS>.json (a workspace's map: shared/pm/workspaceMap.ts).
// Atomic writes (temp file + rename), one at a time. Switched off, every
// write is refused except turning it back on.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { UiCard } from '../../shared/uiActions'
import { cleanProjectInput, isBranch, isGitBranch, machinesOf, isTemplateId, KEY_RE, type PmOverview, type Project, type ProjectUpdate, type TemplateInfo } from '../../shared/pm/project'
import { defaultColor, keyClash, projectOf, renamed, showIds, shownKey, storedTaskId } from '../../shared/pm/projectKey'
import type { RepoVisibility } from '../../shared/pm/visibility'
import { WEIGHTS, defaultWorkflow, isWeight, startOverFrom, validateTemplate, type Template } from '../../shared/pm/workflow'
import { templateChanges, type LogEntry } from '../../shared/pm/templateText'
import { publicTask, taskPlan, type Run, type Task, type TaskLogEntry } from '../../shared/pm/run'
import { replan } from '../../shared/pm/steps'
import { afterIds } from '../../shared/pm/advance'
import { parseFiles } from '../../shared/pm/files'
import type { Receipt } from '../../shared/pm/actions'
import { SHOT_FILE_RE } from '../../shared/pm/shots'
import { withMark } from '../../shared/pm/times'
import { HerdrError } from './herdr'
import type { FolderOptions } from '../../shared/pm/newProject'
import { MAIN, type CoordinatorAgent, type Proposal, type ProposalAnswer } from '../../shared/pm/coordinator'
import type { Incident } from '../../shared/pm/incident'
import { NEW_AUTOPILOT, type Autopilot, type DayCount, type LastWake, type TaskStatus } from '../../shared/pm/autopilot'
import { readQueue, sinceYesterday, type Wake, type WakeSkip } from '../../shared/pm/wakes'
import type { HealthSent } from '../../shared/pm/health'
import type { Automation, AutomationProposal, Mark } from '../../shared/pm/automations'
import { EXAMPLES } from '../../shared/pm/examples'
import { afterRefusal, subTasks } from '../../shared/pm/feature'
import { cleanWorkspaceFields, effectiveProjects, isWorkspace, memberOverrides, ownWorkflow, workflowOverrides, effectiveWorkflow, workspaceErrors, workspaceOf, workspaceTaskError } from '../../shared/pm/workspace'
import type { MapFile } from '../../shared/pm/workspaceMap'
import { DATA_DIR } from './env'

// A project coordinator: the sha256 of its token, its terminal (herdr-core
// address), where its current turn comes from (said: the user's message), the
// project's default agent, the agent its conversation ran with, and a template
// change waiting for the user.
export interface CoordinatorRecord {
  // cliHash: Alfred's `wherdr alfred` token (the main coordinator's record only).
  project: string, tokenHash: string, cliHash?: string, terminal?: string, turn?: { kind: 'user' | 'wake', at: number, said?: string, look?: true }
  // answers: the last answers to its proposals, oldest first (answered: the one
  // kept before there were several).
  agent?: CoordinatorAgent, ran?: CoordinatorAgent, proposal?: Proposal, answers?: ProposalAnswer[], answered?: ProposalAnswer
  // userAt: the user's last message. seen: each task's status at the last tick; ranAt: the last interval wake.
  userAt?: number, autopilot?: Autopilot, seen?: Record<string, TaskStatus>, ranAt?: number
  atRan?: number // before routines: the last wake at autopilot.at, read as routine 'at''s
  routineRan?: Record<string, number> // each routine's last slot (run or skipped), or when its time was set
  woke?: LastWake // the last wake the engine queued, and where tasks stood then
  quiet?: true // its saved autopilot's old default events dropped, once (quietEvents)
  health?: { at: number, seen: Record<string, TaskStatus>, sent?: HealthSent } // the last scheduled slot's health lines (health.ts): where tasks stood then, the last ones sent
  oneWake?: true // its saved health check interval joined Every, once (oneSchedule)
  skips?: WakeSkip[] // wakes not sent, and why (autopilot show)
  skipped?: DayCount // scheduled wakes skipped that day: nothing to do (or the new work limit reached)
  lookAdded?: DayCount // tasks added that day in the turns of look-for-new-work wakes
  // version: wherdr's when this session started; told: the newer version it was told of.
  version?: string, told?: string
  cards?: UiCard[] // the action buttons it put in its replies (shared/uiActions.ts), newest first
  cardNotes?: string[] // what the user did with its cards while it did not run, said at its next start (cardOutcome.ts)
  visits?: { at: number, by: string, what: string }[] // what other coordinators did on its project since its last wake (reach.ts)
  undelivered?: { texts: string[], why: string, at: number } // first messages its session never got (coordinatorFirst.ts)
}

export interface AutomationsFile { automations: Automation[], seen?: Record<string, Mark>, proposals?: AutomationProposal[] }

// The checks the store cannot make itself: the machine, a git folder there
// (or, with plain, any folder). Resolves to the folder's absolute path, and
// whether it is a git repository (a bare path: it is).
export type FolderCheck = (machine: string, folder: string, opts?: FolderOptions) => Promise<string | { path: string, git: boolean }>

async function readJson<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

async function writeJson(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

// A line of a project's log: a task removed (task), or a contributor's PR
// merged on the user's yes (pr, said: the user's own message), by whom and why.
// adopted: a repository a workspace adopted (repo adopt), listed in its next health check.
export interface ProjectLogEntry extends TaskLogEntry { task?: string, pr?: number, said?: string, adopted?: { project: string, repo: string } }

const TASK_ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/
const badInput = (errors: { path: string, message: string }[]) =>
  new HerdrError('bad_input', errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; '))

export function createPmStore(dir = path.join(DATA_DIR, 'projects')) {
  const files = {
    pm: path.join(dir, 'pm.json'), projects: path.join(dir, 'projects.json'), templates: path.join(dir, 'templates'), templateLog: path.join(dir, 'template-log'), projectLog: path.join(dir, 'project-log'),
    tasks: path.join(dir, 'tasks'), runs: path.join(dir, 'runs'), receipts: path.join(dir, 'receipts'), shots: path.join(dir, 'shots'),
    workflows: path.join(dir, 'workflows'), workflowLog: path.join(dir, 'workflow-log'),
    coordinators: path.join(dir, 'coordinators'), wakes: path.join(dir, 'wakes.jsonl'), automations: path.join(dir, 'automations'),
    incidents: path.join(dir, 'incidents.json'), maps: path.join(dir, 'maps'),
  }
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  const pm = async () => (await readJson<{ enabled?: boolean, install?: string, workflows?: number }>(files.pm)) ?? {}
  const enabled = async () => (await pm()).enabled === true
  const readAll = async <T>(folder: string) => {
    const names = (await fs.readdir(folder).catch(() => [] as string[])).filter(n => n.endsWith('.json')).sort()
    return (await Promise.all(names.map(n => readJson<T>(path.join(folder, n)).catch(() => null)))).filter((x): x is Awaited<T> & {} => !!x)
  }
  // The runs, kept in memory: clients and ticks ask for them all the time, and
  // finished runs pile up. Every save is a rename into the folder, which
  // changes the folder's mtime: while it stays the same, nothing is read; when
  // it changes, only the files whose mtime or size changed are read again.
  let runCache: { at: number, files: Map<string, { mtime: number, size: number, run: Run | null }>, list: Run[] } | null = null
  const runs = async (): Promise<Run[]> => {
    const at = (await fs.stat(files.runs).catch(() => null))?.mtimeMs
    if (at === undefined) return []
    if (runCache?.at === at) return [...runCache.list]
    const names = (await fs.readdir(files.runs).catch(() => [] as string[])).filter(n => n.endsWith('.json')).sort()
    const old = runCache?.files, next = new Map<string, { mtime: number, size: number, run: Run | null }>()
    await Promise.all(names.map(async (n) => {
      const file = path.join(files.runs, n), s = await fs.stat(file).catch(() => null)
      if (!s) return
      const was = old?.get(n)
      const run = was && was.mtime === s.mtimeMs && was.size === s.size ? was.run : await readJson<Run>(file).catch(() => null)
      next.set(n, { mtime: s.mtimeMs, size: s.size, run })
    }))
    runCache = { at, files: next, list: names.flatMap(n => next.get(n)?.run ?? []) }
    return [...runCache.list]
  }
  const tasks = () => readAll<Task>(files.tasks)
  // The project's log: the tasks removed, by whom and why.
  const projectLog = async (key: string) =>
    (TASK_ID_RE.test(`${key}-1`) ? (await readJson<{ entries?: ProjectLogEntry[] }>(path.join(files.projectLog, `${key}.json`)))?.entries : null) ?? []
  const readProjects = async () => (await readJson<{ projects?: Project[] }>(files.projects))?.projects ?? []
  // A list with a workspace mistake (workspace.ts) is never saved.
  const saveProjects = (list: Project[]) => {
    const errors = workspaceErrors(list)
    if (errors.length) throw badInput(errors.map(message => ({ path: 'workspace', message })))
    return writeJson(files.projects, { v: 1, projects: list })
  }
  const workflowFile = (key: string) => path.join(files.workflows, `${key}.json`)
  const workflowLogFile = (key: string) => path.join(files.workflowLog, `${key}.json`)
  const readLog = async (file: string) => (await readJson<{ entries?: LogEntry[] }>(file))?.entries ?? []
  const appendLog = async (file: string, line: LogEntry) => writeJson(file, { v: 1, entries: [...await readLog(file), line].slice(-200) })
  // Saves a versioned template (library or workflow): each save that changes
  // something is a new version and a line of its log. keep: the version stays
  // (a copy into a project that had no workflow yet).
  async function saveVersioned(file: string, logFile: string, t: Template, old: Template | null, by: string, said = '', note = '') {
    const changes = templateChanges(old, t)
    if (old && !changes.length && !note) return old.version ?? 1
    const version = old ? (old.version ?? 1) + 1 : (note ? t.version || 1 : 1)
    await writeJson(file, { ...t, version })
    await appendLog(logFile, { at: Date.now(), by, version, changes: note ? [note, ...(old ? changes : [])] : changes, ...(said ? { said } : {}) })
    return version
  }
  // A copy of library template `t` becomes project `key`'s workflow.
  async function copyTemplate(key: string, t: Template, by: string) {
    const old = await readJson<Template>(workflowFile(key))
    const version = await saveVersioned(workflowFile(key), workflowLogFile(key), { ...t, id: key.toLowerCase() }, old, by, '', `copied from template ${t.id} v${t.version ?? 1}`)
    return { from: { template: t.id, version: t.version ?? 1 }, version }
  }
  // Once: each project that pointed at a template gets its own copy of it, with
  // the template's version and log (so a waiting proposal still applies).
  // Idempotent; nothing is deleted, the templates stay as the library.
  async function migrate() {
    const cur = await pm()
    if (cur.workflows) return
    const list = await readProjects()
    for (const [i, p] of list.entries()) {
      const { template: id, ...rest } = p as Project & { template?: string }
      if (id === undefined) continue
      const t = isTemplateId(id) ? await readJson<Template>(path.join(files.templates, `${id}.json`)) : null
      if (t && !await readJson(workflowFile(p.key))) {
        const log = await readLog(path.join(files.templateLog, `${id}.json`))
        await writeJson(workflowLogFile(p.key), { v: 1, entries: log })
        await saveVersioned(workflowFile(p.key), workflowLogFile(p.key), { ...t, id: p.key.toLowerCase() }, null, 'wherdr', '', `copied from template ${id} v${t.version ?? 1}`)
      }
      list[i] = t ? { ...rest, from: { template: id, version: t.version ?? 1 } } : rest
    }
    if (!list.length) return // nothing to copy: projects added from now on get a workflow
    await saveProjects(list)
    await writeJson(files.pm, { ...await pm(), v: 1, workflows: 1 })
  }
  // Each project's key is its fixed id already (every reference uses it):
  // the projects without a color get one. Idempotent.
  async function migrateColors() {
    const list = await readProjects()
    if (list.every(p => p.color)) return
    const out: Project[] = []
    for (const p of list) out.push(p.color ? p : { ...p, color: defaultColor([...out, ...list.filter(x => x.color)]) })
    await saveProjects(out)
  }
  let migrated: Promise<void> | null = null
  // As stored: what writes change. Readers get effective ones (shown below).
  const projects = async () => { await (migrated ??= migrate().then(migrateColors).catch((e) => { migrated = null; throw e })); return readProjects() }
  async function templates(): Promise<TemplateInfo[]> {
    const names = await fs.readdir(files.templates).catch(() => [] as string[])
    const out: TemplateInfo[] = []
    for (const n of names.filter(n => n.endsWith('.json')).sort()) {
      const t = await readJson<Template>(path.join(files.templates, n)).catch(() => null)
      if (t && isTemplateId(t.id) && `${t.id}.json` === n) out.push({ id: t.id, ...(t.version !== undefined ? { version: t.version } : {}) })
    }
    return out
  }
  // Every write but the switch goes through here.
  const write = <T>(fn: () => Promise<T>) => serial(async () => {
    if (!await enabled()) throw new HerdrError('pm_off', 'Projects are switched off')
    return fn()
  })
  // The task with the marks on disk (a caller's copy may be older) and a new one if its step or turn changed.
  const marked = async (t: Task) => withMark(t, TASK_ID_RE.test(t.id) ? (await readJson<Task>(path.join(files.tasks, `${t.id}.json`)))?.marks ?? t.marks : t.marks, Date.now())
  async function findProject(key: unknown) {
    const list = await projects()
    const i = list.indexOf(projectOf(list, key)!)
    if (i < 0) throw new HerdrError('not_found', 'Unknown project')
    return { list, i }
  }
  // A workflow change moves each started task of the project by its step's id
  // (replan), said in its log. Within the workflow's write.
  // A new task from addTask's input, checked, not saved; pending: those of
  // the same write, not saved yet.
  async function newTask(raw: unknown, pending: Task[] = []): Promise<Task> {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
    const list = await projects(), p = projectOf(list, o.project)
    if (!p) throw new HerdrError('not_found', 'Unknown project')
    const title = str('title'), type = str('type')
    if (!title || title.length > 200) throw badInput([{ path: 'title', message: '1 to 200 characters' }])
    if (!type) throw badInput([{ path: 'type', message: 'is required' }])
    const refused = workspaceTaskError(p, type)
    if (refused) throw badInput([{ path: 'type', message: refused }])
    // A removed task's number is never given again.
    const known = [...await tasks(), ...pending]
    const ids = [...known.filter(t => t.project === p.key).map(t => t.id), ...(await projectLog(p.key)).flatMap(e => (e.task ? [e.task] : []))]
    const n = 1 + Math.max(0, ...ids.map(id => Number(id.slice(p.key.length + 1)) || 0))
    const after = afterIds({ after: str('after') }).map(a => storedTaskId(list, a) ?? a).join(',')
    const outside = afterRefusal(p.key, afterIds({ after }), known, list)
    if (outside) throw badInput([{ path: 'after', message: outside }])
    const mergeAfter = afterIds({ after: str('mergeAfter') }).map(a => storedTaskId(list, a) ?? a).join(',')
    const late = afterRefusal(p.key, afterIds({ after: mergeAfter }), known, list)
    if (late) throw badInput([{ path: 'mergeAfter', message: late }])
    // A member's sub-task names a feature of its workspace.
    const feature = str('feature') && (storedTaskId(list, str('feature')) ?? str('feature'))
    if (feature && !known.some(t => t.id === feature && t.kind === 'feature' && !t.closed && t.project === p.workspace)) throw badInput([{ path: 'feature', message: 'an open feature of the project\'s workspace' }])
    const auto = str('auto'), addedBy = str('addedBy').slice(0, 100), planned = parseFiles(o.files), fromBranch = str('fromBranch')
    if (fromBranch && !isGitBranch(fromBranch)) throw badInput([{ path: 'fromBranch', message: 'a branch name' }])
    if (o.weight !== undefined && o.weight !== '' && !isWeight(o.weight)) throw badInput([{ path: 'weight', message: `one of ${WEIGHTS.join(', ')}` }])
    const weight = isWeight(o.weight) ? o.weight : undefined
    const origin = (['coordinator', 'automation', 'mission'] as const).find(x => x === o.origin) ?? 'user'
    return { id: `${p.key}-${n}`, project: p.key, title, description: str('description').slice(0, 20000), type, state: 'todo', origin, createdAt: Date.now(), ...(isWorkspace(p) ? { kind: 'feature' as const } : {}), ...(feature ? { feature } : {}), ...(after ? { after } : {}), ...(mergeAfter ? { mergeAfter } : {}), ...(auto ? { auto } : {}), ...(addedBy ? { addedBy } : {}), ...(weight ? { weight } : {}), ...(planned.length ? { files: planned } : {}), ...(fromBranch ? { fromBranch } : {}) }
  }

  async function replanTasks(key: string, before: Template, after: Template) {
    const { list, i } = await findProject(key)
    const p = list[i]!
    for (const task of (await tasks()).filter(x => x.project === p.key && x.step)) {
      const moved = replan(taskPlan(before, task, p), taskPlan(after, task, p), task.step!, Date.now())
      if (!moved) continue
      const text = moved.from === moved.to ? `workflow changed: still at ${moved.to}` : `workflow changed: ${moved.from} is gone, on to ${moved.to}`
      const out = await marked({ ...task, step: moved.state, log: [...(task.log ?? []), { at: Date.now(), by: 'engine', text }].slice(-200) })
      await writeJson(path.join(files.tasks, `${task.id}.json`), out)
    }
  }
  // A member's overrides recomputed from its stored form (no change: nothing written).
  async function keepOverrides(i: number, of: (p: Project) => Pick<Project, 'overrides'>, list: Project[]) {
    if (!list[i]!.workspace) return
    const { overrides: old, ...rest } = list[i]!
    const next = of(list[i]!)
    if (JSON.stringify(next.overrides) === JSON.stringify(old)) return
    list[i] = { ...rest, ...next }
    await saveProjects(list)
  }
  async function knownTemplate(id: string) {
    const t = isTemplateId(id) ? await readJson<Template>(path.join(files.templates, `${id}.json`)) : null
    if (!t) throw new HerdrError('not_found', 'Unknown template')
    return t
  }
  // A library template by id, or a built-in example (example:<id>), not saved into the library.
  const sourceOf = async (id: string) => {
    const ex = id.startsWith('example:') ? EXAMPLES.find(e => `example:${e.id}` === id) : undefined
    return ex ? structuredClone(ex) as Template : knownTemplate(id)
  }

  return {
    files,
    async overview(): Promise<PmOverview> {
      return { enabled: await enabled(), projects: effectiveProjects(await projects()), templates: await templates(), tasks: (await tasks()).map(publicTask) }
    },
    setEnabled: (on: boolean) => serial(async () => writeJson(files.pm, { ...await pm(), v: 1, enabled: on })),
    // Marks the terminals this wherdr starts (wherdr.install), so that two
    // instances on one herdr-core never take each other's.
    install: () => serial(async () => {
      const cur = await pm()
      if (cur.install) return cur.install
      const install = randomUUID().slice(0, 8)
      await writeJson(files.pm, { v: 1, ...cur, install })
      return install
    }),
    enabled,
    tasks,
    // Each member with its workspace's settings in force (effectiveProject).
    projects: async () => effectiveProjects(await projects()),
    // A task by its id, or by a key the project had or has now (WD-5 finds WHR-5).
    task: async (id: unknown) => {
      const direct = typeof id === 'string' && TASK_ID_RE.test(id) ? await readJson<Task>(path.join(files.tasks, `${id}.json`)) : null
      const stored = direct ? null : storedTaskId(await projects(), id)
      return direct ?? (stored ? readJson<Task>(path.join(files.tasks, `${stored}.json`)) : null)
    },
    // A project by any of its keys (any case), or undefined.
    project: async (key: unknown) => projectOf(effectiveProjects(await projects()), key),
    template: (id: string) => (isTemplateId(id) ? readJson<Template>(path.join(files.templates, `${id}.json`)) : Promise.resolve(null)),
    templateLog: async (id: string) => (isTemplateId(id) ? readLog(path.join(files.templateLog, `${id}.json`)) : []),
    // The project's own workflow (a Template), what its tasks follow: the
    // minimal default until the user accepts one. saved: the accepted one only (null: none yet).
    // A member without its own runs its workspace's (effectiveWorkflow).
    workflow: async (key: string) => {
      if (!KEY_RE.test(key)) return null
      const list = await projects(), p = list.find(x => x.key === key), ws = p && workspaceOf(p, list)
      return effectiveWorkflow(key, await readJson<Template>(workflowFile(key)), p, ws, ws ? await readJson<Template>(workflowFile(ws.key)) : null)
    },
    savedWorkflow: (key: string) => (KEY_RE.test(key) ? readJson<Template>(workflowFile(key)) : Promise.resolve(null)),
    workflowLog: (key: string) => (KEY_RE.test(key) ? readLog(workflowLogFile(key)) : Promise.resolve([])),
    // by, said: as saveTemplate. Its id is always the project's (lowercased key).
    // A member's first one becomes its own: its tasks followed its workspace's.
    saveWorkflow: (key: string, raw: unknown, { by = 'user', said = '' } = {}) => write(async () => {
      const { list, i } = await findProject(key)
      const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? ownWorkflow(raw as Template) : raw
      const errors = validateTemplate(t)
      if (errors.length) throw badInput(errors)
      const old = await readJson<Template>(workflowFile(key)), ws = workspaceOf(list[i]!, list)
      const shared = ws ? await readJson<Template>(workflowFile(ws.key)) : null
      const version = await saveVersioned(workflowFile(key), workflowLogFile(key), { ...(t as Template), id: key.toLowerCase() }, old, by, said)
      await keepOverrides(i, p => workflowOverrides(p, ws, t as Template), list)
      // Before the first one, the tasks followed the workspace's or the default workflow.
      await replanTasks(key, old ?? (shared && { ...shared, id: key.toLowerCase() }) ?? defaultWorkflow(key), t as Template)
      // A workspace's: the tasks of its members without their own follow it too.
      if (isWorkspace(list[i])) {
        for (const m of list.filter(x => x.workspace === key)) {
          if (!await readJson(workflowFile(m.key))) await replanTasks(m.key, { ...(old ?? defaultWorkflow(m.key)), id: m.key.toLowerCase() }, { ...(t as Template), id: m.key.toLowerCase() })
        }
      }
      return { id: key.toLowerCase(), version }
    }),
    runs,
    saveTask: (t: Task) => write(async () => { const out = await marked(t); await writeJson(path.join(files.tasks, `${t.id}.json`), out); return out }),
    // A screenshot of the task: `change` gives the task with it, from the task
    // read in the same write (refused: it throws, nothing is kept).
    addShot: (id: string, file: string, data: Buffer, change: (t: Task) => Task) => write(async () => {
      const task = TASK_ID_RE.test(id) && SHOT_FILE_RE.test(file) ? await readJson<Task>(path.join(files.tasks, `${id}.json`)) : null
      if (!task) throw new HerdrError('not_found', 'Unknown task')
      const next = await marked(change(task))
      const folder = path.join(files.shots, id)
      await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(folder, file), data, { mode: 0o600 })
      await writeJson(path.join(files.tasks, `${id}.json`), next)
      return next
    }),
    // Where it is on this machine, for the coordinator to open.
    shotPath: (id: string, file: string) => path.join(files.shots, id, file),
    shot: (id: string, file: string) => (TASK_ID_RE.test(id) && SHOT_FILE_RE.test(file) ? fs.readFile(path.join(files.shots, id, file)).catch(() => null) : Promise.resolve(null)),
    // A change made on the task as it is on disk, in one write (with a log line
    // when given): a caller's older copy never undoes what another wrote since
    // (an engine action that ended meanwhile). null: no such task.
    updateTask: (id: string, change: (t: Task) => Task, log?: { by: string, text: string }) => write(async () => {
      const task = TASK_ID_RE.test(id) ? await readJson<Task>(path.join(files.tasks, `${id}.json`)) : null
      if (!task) return null
      const next = change(task)
      const out = await marked(log ? { ...next, log: [...(next.log ?? []), { at: Date.now(), by: log.by, text: showIds(await readProjects(), log.text) }].slice(-200) } : next)
      await writeJson(path.join(files.tasks, `${id}.json`), out)
      return out
    }),
    // A line of the task's log, saved with the task.
    logTask: (t: Task, by: string, text: string) => write(async () => {
      const out = await marked({ ...t, log: [...(t.log ?? []), { at: Date.now(), by, text: showIds(await readProjects(), text) }].slice(-200) })
      await writeJson(path.join(files.tasks, `${t.id}.json`), out)
      return out
    }),
    // A task removed for good (never started: nothing else to clean up), and a
    // line of its project's log, since its own log goes with it.
    removeTask: (t: Task, by: string, text: string) => write(async () => {
      const logFile = path.join(files.projectLog, `${t.project}.json`)
      const entries = await projectLog(t.project)
      await writeJson(logFile, { v: 1, entries: [...entries, { at: Date.now(), by, text: showIds(await readProjects(), text), task: t.id }].slice(-500) })
      await fs.rm(path.join(files.tasks, `${t.id}.json`), { force: true })
    }),
    projectLog,
    logProject: (key: string, entry: Omit<ProjectLogEntry, 'at'>) => write(async () => {
      if (!KEY_RE.test(key)) throw new HerdrError('not_found', 'Unknown project')
      const entries = await projectLog(key)
      await writeJson(path.join(files.projectLog, `${key}.json`), { v: 1, entries: [...entries, { at: Date.now(), ...entry }].slice(-500) })
    }),
    coordinator: (key: string) => readJson<CoordinatorRecord>(path.join(files.coordinators, `${key}.json`)),
    coordinators: () => readAll<CoordinatorRecord>(files.coordinators),
    // Alfred (the main coordinator) also runs with projects off: its record is saved then too.
    saveCoordinator: (c: CoordinatorRecord) => (c.project === MAIN ? serial : write)(() => writeJson(path.join(files.coordinators, `${c.project}.json`), c)),
    // keepMs: ended wakes as old as this (default a day; the file keeps two).
    wakes: async (keepMs?: number) => readQueue((await fs.readFile(files.wakes, 'utf8').catch(() => '')).split('\n'), Date.now(), keepMs),
    // Appends the changed wakes; the file is rewritten (atomically) once it holds many old lines.
    saveWakes: (changed: Wake[]) => write(async () => {
      if (!changed.length) return
      const lines = (await fs.readFile(files.wakes, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      if (lines.length < 500) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 })
        return fs.appendFile(files.wakes, changed.map(w => JSON.stringify(w) + '\n').join(''), { mode: 0o600 })
      }
      const ids = new Set(changed.map(w => w.id))
      const keep = [...readQueue(lines, Date.now(), Date.now() - sinceYesterday(Date.now())).filter(w => !ids.has(w.id)), ...changed]
      const temp = `${files.wakes}.${randomUUID()}.tmp`
      await fs.writeFile(temp, keep.map(w => JSON.stringify(w) + '\n').join(''), { mode: 0o600 })
      await fs.rename(temp, files.wakes)
    }),
    incidents: async () => (await readJson<{ incidents?: Incident[] }>(files.incidents))?.incidents ?? [],
    addIncidents: (list: Omit<Incident, 'id'>[]) => write(async () => {
      if (!list.length) return []
      const added = list.map(i => ({ id: randomUUID().slice(0, 8), ...i }))
      const old = (await readJson<{ incidents?: Incident[] }>(files.incidents))?.incidents ?? []
      await writeJson(files.incidents, { v: 1, incidents: [...old, ...added].slice(-200) })
      return added
    }),
    // A task the incident also holds (its start found the machine out of reach): in its tasks, once.
    linkIncident: (id: string, task: string) => write(async () => {
      const old = (await readJson<{ incidents?: Incident[] }>(files.incidents))?.incidents ?? []
      await writeJson(files.incidents, { v: 1, incidents: old.map(i => (i.id === id && !i.tasks.includes(task) ? { ...i, tasks: [...i.tasks, task] } : i)) })
    }),
    // Their Incident wake queued: never again.
    toldIncidents: (ids: string[], at: number) => write(async () => {
      const old = (await readJson<{ incidents?: Incident[] }>(files.incidents))?.incidents ?? []
      await writeJson(files.incidents, { v: 1, incidents: old.map(i => (ids.includes(i.id) ? { ...i, told: at } : i)) })
    }),
    automations: async (key: string): Promise<AutomationsFile> =>
      ({ automations: [], ...(TASK_ID_RE.test(`${key}-1`) ? await readJson<AutomationsFile>(path.join(files.automations, `${key}.json`)) : null) }),
    // `change` gets the file as it is now, inside the write: no firing is lost to a concurrent save.
    changeAutomations: <T>(key: string, change: (f: AutomationsFile) => { file: AutomationsFile, out: T }) => write(async () => {
      if (!TASK_ID_RE.test(`${key}-1`)) throw new HerdrError('not_found', 'Unknown project')
      const file = path.join(files.automations, `${key}.json`)
      const r = change({ automations: [], ...(await readJson<AutomationsFile>(file)) })
      await writeJson(file, { v: 1, ...r.file })
      return r.out
    }),
    map: async (key: string): Promise<MapFile> =>
      ({ entries: [], ...(TASK_ID_RE.test(`${key}-1`) ? await readJson<MapFile>(path.join(files.maps, `${key}.json`)) : null) }),
    // `change` gets the map as it is now, inside the write.
    changeMap: (key: string, change: (f: MapFile) => MapFile) => write(async () => {
      if (!TASK_ID_RE.test(`${key}-1`)) throw new HerdrError('not_found', 'Unknown project')
      const file = path.join(files.maps, `${key}.json`)
      const next = change({ entries: [], ...(await readJson<MapFile>(file)) })
      await writeJson(file, next)
      return next
    }),
    saveRun: (r: Run) => write(async () => { await writeJson(path.join(files.runs, `${r.id}.json`), r); if (runCache) runCache.at = -1 }),
    receipt: (id: string) => readJson<Receipt>(path.join(files.receipts, `${id}.json`)),
    saveReceipt: (r: Receipt) => write(() => writeJson(path.join(files.receipts, `${r.id}.json`), r)),

    // { project, title, description?, type, after?, mergeAfter?, feature?, auto?, origin?, addedBy? }: a new task, to do (origin: 'user' when unset).
    addTask: (raw: unknown) => write(async () => {
      const task = await newTask(raw)
      await writeJson(path.join(files.tasks, `${task.id}.json`), task)
      return task
    }),
    // A feature's sub-tasks (feature.ts), all added or none: each raw is
    // addTask's, afterIndex naming earlier ones of the same split,
    // mergeAfterIndex any other one; the feature keeps the plan's order.
    splitFeature: (id: string, raws: (Record<string, unknown> & { afterIndex: number[], mergeAfterIndex?: number[] })[], order: string, by: string) => write(async () => {
      const all = await tasks(), feature = all.find(t => t.id === id)
      if (feature?.kind !== 'feature' || feature.closed) throw new HerdrError('refused', `${id} is not an open feature`)
      if (subTasks(feature, all).length) throw new HerdrError('refused', `${id} is already split: add a sub-task with task add --feature ${id}`)
      const added: Task[] = [], at = Date.now()
      for (const { afterIndex, mergeAfterIndex: _, ...raw } of raws) {
        const t = await newTask({ ...raw, feature: id, after: [raw.after, ...afterIndex.map(i => added[i]!.id)].filter(Boolean).join(',') }, added)
        added.push({ ...t, log: [{ at, by, text: `added the task, a sub-task of ${id}${t.after ? `, after ${t.after}` : ''}` }] })
      }
      // Merges may follow any sub-task of the split (parsePlan refused a cycle).
      for (const [i, t] of added.entries()) {
        const mergeAfter = [t.mergeAfter, ...(raws[i]!.mergeAfterIndex ?? []).map(j => added[j]!.id)].filter(Boolean).join(',')
        if (mergeAfter) added[i] = { ...t, mergeAfter, log: [...t.log!, { at, by, text: `merges after ${mergeAfter}` }] }
      }
      for (const t of added) await writeJson(path.join(files.tasks, `${t.id}.json`), t)
      const split = { ...feature, plan: { order }, log: [...(feature.log ?? []), { at, by, text: `split into ${added.map(t => t.id).join(', ')}: ${order}` }].slice(-200) }
      await writeJson(path.join(files.tasks, `${id}.json`), split)
      return { feature: split, tasks: added }
    }),

    addProject: (raw: unknown, check: FolderCheck, opts?: FolderOptions) => write(async () => {
      const { project, errors } = cleanProjectInput(raw)
      const ws = cleanWorkspaceFields(raw)
      if (!project || ws.errors.length) throw badInput([...errors, ...ws.errors])
      const list = await projects()
      const clash = keyClash(list, project.key)
      if (clash) throw new HerdrError('exists', `Project ${clash.name} already has the key ${project.key}`)
      // A member keeps only its key, name, color, machine, path and workspace: the rest comes from the workspace.
      const { template, ...fields } = project
      const source = template && !ws.fields.workspace ? await sourceOf(template) : null
      const checked = await check(project.machine, project.path, ws.fields.kind ? { ...opts, plain: true } : opts)
      const { path: folder, git } = typeof checked === 'string' ? { path: checked, git: true } : checked
      if (list.some(p => p.machine === project.machine && p.path === folder)) throw new HerdrError('exists', 'This folder is already a project')
      // A removed project's workflow and log under the same key are not the new one's.
      await Promise.all([workflowFile(fields.key), workflowLogFile(fields.key)].map(f => fs.rm(f, { force: true })))
      let added: Project = ws.fields.workspace
        ? { key: fields.key, name: fields.name, color: fields.color ?? defaultColor(list), machine: fields.machine, path: folder, workspace: ws.fields.workspace, addedAt: Date.now() }
        : { ...fields, ...ws.fields, color: fields.color ?? defaultColor(list), path: folder, ...(git && !ws.fields.kind ? {} : { git: false as const }), addedAt: Date.now() }
      if (source) added = { ...added, from: (await copyTemplate(added.key, source, 'user')).from }
      await saveProjects([...list, added])
      if (added.workspace) return added // no coordinator of its own: the workspace's runs it
      // A new project's tasks at once: Auto, from its machines (an existing project keeps its number);
      // quiet: its default events (done, stuck) are not the old ones quietEvents drops.
      const coordinator = path.join(files.coordinators, `${added.key}.json`)
      if (!(await readJson(coordinator))) await writeJson(coordinator, { project: added.key, tokenHash: '', autopilot: NEW_AUTOPILOT, quiet: true } satisfies CoordinatorRecord)
      return added
    }),

    // Replaces the project's workflow with a copy of a library template or an
    // example (example:<id>); '' removes it (its log stays). keepGuards: the
    // project's own guards stay (the template's task types may still add theirs).
    setTemplate: (key: unknown, template: unknown, { keepGuards = false, by = 'user' } = {}) => write(async () => {
      const id = typeof template === 'string' ? template : ''
      if (id && !isTemplateId(id.replace(/^example:/, ''))) throw badInput([{ path: 'template', message: 'invalid template id' }])
      let source = id ? await sourceOf(id) : null
      const { list, i } = await findProject(key)
      const { from: _old, ...rest } = list[i]!
      // No workflow yet: nothing to keep, the template's guards come with it.
      if (source && keepGuards) source = startOverFrom(source, await readJson<Template>(workflowFile(rest.key)))
      if (source) list[i] = { ...rest, from: (await copyTemplate(rest.key, source, by)).from }
      else { await fs.rm(workflowFile(rest.key), { force: true }); list[i] = rest }
      await saveProjects(list)
      return list[i]!
    }),

    // update: from cleanProjectUpdate (a base of '' goes back to the repository's current branch).
    // A new key: a key no other project has (any case, former keys too); the old one stays an alias.
    updateProject: (key: unknown, update: ProjectUpdate) => write(async () => {
      const { list, i } = await findProject(key)
      const { base: _base, label: _label, aliases: _aliases, branchName: _bn, deleteBranch: _db, coordinatorName: _cn, reach: _r, ...rest } = list[i]!
      const keepBranch = (update.deleteBranch ?? list[i]!.deleteBranch) === false
      const base = update.base ?? list[i]!.base
      // '' goes back to task/{id}.
      const branchName = update.branchName ?? list[i]!.branchName
      // '' (or the project's own name) goes back to following the project's name.
      const coordinatorName = update.coordinatorName ?? list[i]!.coordinatorName
      // Only other projects that exist, never its own.
      const reach = (update.reach ?? list[i]!.reach ?? []).filter(r => r.project !== rest.key && list.some(x => x.key === r.project))
      const ownName = coordinatorName && coordinatorName !== (update.name ?? rest.name) ? { coordinatorName } : {}
      const next = update.key ?? shownKey(list[i]!)
      const clash = keyClash(list, next, rest.key)
      if (clash) throw new HerdrError('exists', `Project ${clash.name} already has the key ${next}`)
      const { machines: _m, clones: _c, paused: _p, placement: _s, overrides: _o, ...kept } = rest
      const placement = update.placement ?? rest.placement
      const allowed = machinesOf(rest, update)
      if (allowed.errors.length) throw badInput(allowed.errors)
      const overrides = memberOverrides(list[i]!, update)
      list[i] = { ...kept, ...overrides, ...renamed(list[i]!, next), ...(update.name ? { name: update.name } : {}), ...ownName, ...(base ? { base } : {}), ...(branchName ? { branchName } : {}), ...(update.color ? { color: update.color } : {}), ...(allowed.machines ? { machines: allowed.machines, clones: allowed.clones } : {}), ...(allowed.paused ? { paused: allowed.paused } : {}), ...(placement && placement !== 'strongest' ? { placement } : {}), ...(update.archiveAfter !== undefined ? { archiveAfter: update.archiveAfter } : {}), ...(keepBranch ? { deleteBranch: false as const } : {}), ...(reach.length ? { reach } : {}) }
      await saveProjects(list)
      return list[i]!
    }),

    // A public repository's guardrails: its visibility, checked by wherdr or set by the user.
    setVisibility: (key: unknown, v: RepoVisibility) => write(async () => {
      if (!['public', 'private', 'unknown'].includes(v?.value)) throw badInput([{ path: 'value', message: 'public or private' }])
      const { list, i } = await findProject(key)
      list[i] = { ...list[i]!, visibility: v }
      await saveProjects(list)
      return list[i]!
    }),

    // The working branch ('' clears it). Only new starts use it: a running
    // task's worktree and its planned branches stay as they are.
    setBase: (key: unknown, base: unknown) => write(async () => {
      const b = typeof base === 'string' ? base.trim() : ''
      if (b && !isBranch(b)) throw badInput([{ path: 'base', message: 'invalid branch name' }])
      const { list, i } = await findProject(key)
      const { base: _old, overrides: _o, ...rest } = list[i]!
      list[i] = { ...rest, ...(b ? { base: b } : {}), ...memberOverrides(list[i]!, { base: b }) }
      await saveProjects(list)
      return list[i]!
    }),

    removeProject: (key: unknown) => write(async () => {
      const { list, i } = await findProject(key)
      list.splice(i, 1)
      await saveProjects(list)
    }),

    // replace: the caller opened this template and means to change it. Without
    // it, an id already taken is refused: nothing is overwritten by mistake.
    // by, said: who saved it ('user' by default), and the user's sentence behind a coordinator's edit.
    saveTemplate: (t: unknown, { replace = false, by = 'user', said = '' } = {}) => write(async () => {
      const errors = validateTemplate(t)
      const id = (t as Template | null)?.id
      if (!errors.length && !isTemplateId(id)) errors.push({ path: 'id', message: 'lowercase letters, digits, . _ -' })
      if (errors.length) throw badInput(errors)
      const file = path.join(files.templates, `${id}.json`)
      const old = await readJson<Template>(file)
      if (old && !replace) throw new HerdrError('exists', 'A template already has this id')
      return { id: id!, version: await saveVersioned(file, path.join(files.templateLog, `${id}.json`), t as Template, old, by, said) }
    }),

    // A library template gets a new id (its version and log come along). No
    // project depends on it: "Based on" is information only, renamed with it.
    renameTemplate: (id: unknown, to: unknown) => write(async () => {
      if (typeof to !== 'string' || !isTemplateId(to)) throw badInput([{ path: 'to', message: 'lowercase letters, digits, . _ -' }])
      const t = await knownTemplate(typeof id === 'string' ? id : '')
      if (to === t.id) return { id: to }
      const file = path.join(files.templates, `${to}.json`)
      if (await readJson(file)) throw new HerdrError('exists', 'A template already has this id')
      const log = await readLog(path.join(files.templateLog, `${t.id}.json`))
      await writeJson(path.join(files.templateLog, `${to}.json`), { v: 1, entries: [...log, { at: Date.now(), by: 'user', version: t.version ?? 1, changes: [`renamed from ${t.id}`] }].slice(-200) })
      await writeJson(file, { ...t, id: to })
      await Promise.all([files.templates, files.templateLog].map(d => fs.rm(path.join(d, `${t.id}.json`), { force: true })))
      const list = await projects()
      if (list.some(p => p.from?.template === t.id)) await saveProjects(list.map(p => (p.from?.template === t.id ? { ...p, from: { ...p.from, template: to } } : p)))
      return { id: to }
    }),

    // Deletes a library template and its log; projects keep their own copies.
    removeTemplate: (id: unknown) => write(async () => {
      const t = await knownTemplate(typeof id === 'string' ? id : '')
      await Promise.all([files.templates, files.templateLog].map(d => fs.rm(path.join(d, `${t.id}.json`), { force: true })))
    }),
  }
}

export type PmStore = ReturnType<typeof createPmStore>
let store: PmStore | null = null
export const pmStore = () => (store ??= createPmStore())
