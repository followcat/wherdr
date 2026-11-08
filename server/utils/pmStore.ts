// Project management storage, in DATA_DIR/projects/ (one engine, on the wherdr
// host): pm.json (the on/off switch and this install's id), projects.json,
// templates/<id>.json, template-log/<id>.json (the template library),
// workflows/<KEY>.json, workflow-log/<KEY>.json (each project's own copy, what its tasks follow), project-log/<KEY>.json, tasks/<KEY>-<n>.json, runs/<id>.json, receipts/<id>.json,
// shots/<KEY>-<n>/<file> (a task's screenshots),
// coordinators/<KEY>.json (the hash of the coordinator's token, its current turn, its autopilot),
// wakes.jsonl (the coordinators' wake queue, append-only: the last line of an id wins),
// automations/<KEY>.json (the project's automations and where its tasks stood at the last tick).
// Atomic writes (temp file + rename), one at a time. Switched off, every
// write is refused except turning it back on.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cleanProjectInput, isBranch, isTemplateId, KEY_RE, type PmOverview, type Project, type ProjectUpdate, type TemplateInfo } from '../../shared/pm/project'
import { defaultColor, keyClash, projectOf, renamed, shownKey, storedTaskId } from '../../shared/pm/projectKey'
import type { RepoVisibility } from '../../shared/pm/visibility'
import { startOverFrom, validateTemplate, type Template } from '../../shared/pm/workflow'
import { templateChanges, type LogEntry } from '../../shared/pm/templateText'
import { publicTask, type Run, type Task, type TaskLogEntry } from '../../shared/pm/run'
import { afterIds } from '../../shared/pm/advance'
import type { Receipt } from '../../shared/pm/actions'
import { SHOT_FILE_RE } from '../../shared/pm/shots'
import { HerdrError } from './herdr'
import type { FolderOptions } from '../../shared/pm/newProject'
import { MAIN, type CoordinatorAgent, type Proposal, type ProposalOutcome } from '../../shared/pm/coordinator'
import type { Autopilot, DayCount, LastWake, TaskStatus } from '../../shared/pm/autopilot'
import { readQueue, type Wake } from '../../shared/pm/wakes'
import type { Automation, Mark } from '../../shared/pm/automations'
import { EXAMPLES } from '../../shared/pm/examples'
import { DATA_DIR } from './env'

// A project coordinator: the sha256 of its token, its terminal (herdr-core
// address), where its current turn comes from (said: the user's message), the
// project's default agent, the agent its conversation ran with, and a template
// change waiting for the user.
export interface CoordinatorRecord {
  // cliHash: Alfred's `wherdr alfred` token (the main coordinator's record only).
  project: string, tokenHash: string, cliHash?: string, terminal?: string, turn?: { kind: 'user' | 'wake', at: number, said?: string, look?: true }
  agent?: CoordinatorAgent, ran?: CoordinatorAgent, proposal?: Proposal, answered?: { outcome: ProposalOutcome, at: number }
  // userAt: the user's last message. seen: each task's status at the last tick; ranAt: the last interval wake.
  userAt?: number, autopilot?: Autopilot, seen?: Record<string, TaskStatus>, ranAt?: number
  atRan?: number // the last scheduled wake at fixed times (autopilot.at), or when it was set
  woke?: LastWake // the last wake the engine queued, and where tasks stood then
  skipped?: DayCount // scheduled wakes skipped that day: nothing to do (or the new work limit reached)
  lookAdded?: DayCount // tasks added that day in the turns of look-for-new-work wakes
}

export interface AutomationsFile { automations: Automation[], seen?: Record<string, Mark> }

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
export interface ProjectLogEntry extends TaskLogEntry { task?: string, pr?: number, said?: string }

const TASK_ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/
const badInput = (errors: { path: string, message: string }[]) =>
  new HerdrError('bad_input', errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; '))

export function createPmStore(dir = path.join(DATA_DIR, 'projects')) {
  const files = {
    pm: path.join(dir, 'pm.json'), projects: path.join(dir, 'projects.json'), templates: path.join(dir, 'templates'), templateLog: path.join(dir, 'template-log'), projectLog: path.join(dir, 'project-log'),
    tasks: path.join(dir, 'tasks'), runs: path.join(dir, 'runs'), receipts: path.join(dir, 'receipts'), shots: path.join(dir, 'shots'),
    workflows: path.join(dir, 'workflows'), workflowLog: path.join(dir, 'workflow-log'),
    coordinators: path.join(dir, 'coordinators'), wakes: path.join(dir, 'wakes.jsonl'), automations: path.join(dir, 'automations'),
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
  const tasks = () => readAll<Task>(files.tasks)
  // The project's log: the tasks removed, by whom and why.
  const projectLog = async (key: string) =>
    (TASK_ID_RE.test(`${key}-1`) ? (await readJson<{ entries?: ProjectLogEntry[] }>(path.join(files.projectLog, `${key}.json`)))?.entries : null) ?? []
  const readProjects = async () => (await readJson<{ projects?: Project[] }>(files.projects))?.projects ?? []
  const saveProjects = (list: Project[]) => writeJson(files.projects, { v: 1, projects: list })
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
    const version = old ? (old.version ?? 1) + 1 : (note ? t.version ?? 1 : 1)
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
  async function findProject(key: unknown) {
    const list = await projects()
    const i = list.indexOf(projectOf(list, key)!)
    if (i < 0) throw new HerdrError('not_found', 'Unknown project')
    return { list, i }
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
      return { enabled: await enabled(), projects: await projects(), templates: await templates(), tasks: (await tasks()).map(publicTask) }
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
    projects,
    // A task by its id, or by a key the project had or has now (WD-5 finds WHR-5).
    task: async (id: unknown) => {
      const direct = typeof id === 'string' && TASK_ID_RE.test(id) ? await readJson<Task>(path.join(files.tasks, `${id}.json`)) : null
      const stored = direct ? null : storedTaskId(await projects(), id)
      return direct ?? (stored ? readJson<Task>(path.join(files.tasks, `${stored}.json`)) : null)
    },
    // A project by any of its keys (any case), or undefined.
    project: async (key: unknown) => projectOf(await projects(), key),
    template: (id: string) => (isTemplateId(id) ? readJson<Template>(path.join(files.templates, `${id}.json`)) : Promise.resolve(null)),
    templateLog: async (id: string) => (isTemplateId(id) ? readLog(path.join(files.templateLog, `${id}.json`)) : []),
    // The project's own workflow (a Template), what its tasks follow; null: none yet.
    workflow: (key: string) => (KEY_RE.test(key) ? readJson<Template>(workflowFile(key)) : Promise.resolve(null)),
    workflowLog: (key: string) => (KEY_RE.test(key) ? readLog(workflowLogFile(key)) : Promise.resolve([])),
    // by, said: as saveTemplate. Its id is always the project's (lowercased key).
    saveWorkflow: (key: string, t: unknown, { by = 'user', said = '' } = {}) => write(async () => {
      await findProject(key)
      const errors = validateTemplate(t)
      if (errors.length) throw badInput(errors)
      const version = await saveVersioned(workflowFile(key), workflowLogFile(key), { ...(t as Template), id: key.toLowerCase() }, await readJson<Template>(workflowFile(key)), by, said)
      return { id: key.toLowerCase(), version }
    }),
    runs: () => readAll<Run>(files.runs),
    saveTask: (t: Task) => write(async () => { await writeJson(path.join(files.tasks, `${t.id}.json`), t); return t }),
    // A screenshot of the task: `change` gives the task with it, from the task
    // read in the same write (refused: it throws, nothing is kept).
    addShot: (id: string, file: string, data: Buffer, change: (t: Task) => Task) => write(async () => {
      const task = TASK_ID_RE.test(id) && SHOT_FILE_RE.test(file) ? await readJson<Task>(path.join(files.tasks, `${id}.json`)) : null
      if (!task) throw new HerdrError('not_found', 'Unknown task')
      const next = change(task)
      const folder = path.join(files.shots, id)
      await fs.mkdir(folder, { recursive: true, mode: 0o700 })
      await fs.writeFile(path.join(folder, file), data, { mode: 0o600 })
      await writeJson(path.join(files.tasks, `${id}.json`), next)
      return next
    }),
    shot: (id: string, file: string) => (TASK_ID_RE.test(id) && SHOT_FILE_RE.test(file) ? fs.readFile(path.join(files.shots, id, file)).catch(() => null) : Promise.resolve(null)),
    // A line of the task's log, saved with the task.
    logTask: (t: Task, by: string, text: string) => write(async () => {
      const out = { ...t, log: [...(t.log ?? []), { at: Date.now(), by, text }].slice(-200) }
      await writeJson(path.join(files.tasks, `${t.id}.json`), out)
      return out
    }),
    // A task removed for good (never started: nothing else to clean up), and a
    // line of its project's log, since its own log goes with it.
    removeTask: (t: Task, by: string, text: string) => write(async () => {
      const logFile = path.join(files.projectLog, `${t.project}.json`)
      const entries = await projectLog(t.project)
      await writeJson(logFile, { v: 1, entries: [...entries, { at: Date.now(), by, text, task: t.id }].slice(-500) })
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
    wakes: async () => readQueue((await fs.readFile(files.wakes, 'utf8').catch(() => '')).split('\n'), Date.now()),
    // Appends the changed wakes; the file is rewritten (atomically) once it holds many old lines.
    saveWakes: (changed: Wake[]) => write(async () => {
      if (!changed.length) return
      const lines = (await fs.readFile(files.wakes, 'utf8').catch(() => '')).split('\n').filter(Boolean)
      if (lines.length < 500) {
        await fs.mkdir(dir, { recursive: true, mode: 0o700 })
        return fs.appendFile(files.wakes, changed.map(w => JSON.stringify(w) + '\n').join(''), { mode: 0o600 })
      }
      const ids = new Set(changed.map(w => w.id))
      const keep = [...readQueue(lines, Date.now()).filter(w => !ids.has(w.id)), ...changed]
      const temp = `${files.wakes}.${randomUUID()}.tmp`
      await fs.writeFile(temp, keep.map(w => JSON.stringify(w) + '\n').join(''), { mode: 0o600 })
      await fs.rename(temp, files.wakes)
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
    saveRun: (r: Run) => write(() => writeJson(path.join(files.runs, `${r.id}.json`), r)),
    receipt: (id: string) => readJson<Receipt>(path.join(files.receipts, `${id}.json`)),
    saveReceipt: (r: Receipt) => write(() => writeJson(path.join(files.receipts, `${r.id}.json`), r)),

    // { project, title, description?, type, after?, auto?, origin? }: a new task, to do (origin: 'user' when unset).
    addTask: (raw: unknown) => write(async () => {
      const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
      const p = projectOf(await projects(), o.project)
      if (!p) throw new HerdrError('not_found', 'Unknown project')
      const title = str('title'), type = str('type')
      if (!title || title.length > 200) throw badInput([{ path: 'title', message: '1 to 200 characters' }])
      if (!type) throw badInput([{ path: 'type', message: 'is required' }])
      // A removed task's number is never given again.
      const ids = [...(await tasks()).filter(t => t.project === p.key).map(t => t.id), ...(await projectLog(p.key)).flatMap(e => (e.task ? [e.task] : []))]
      const n = 1 + Math.max(0, ...ids.map(id => Number(id.slice(p.key.length + 1)) || 0))
      const after = afterIds({ after: str('after') }).map(a => storedTaskId([p], a) ?? a).join(',')
      const known = await tasks()
      if (afterIds({ after }).some(a => !known.some(t => t.id === a && t.project === p.key))) throw badInput([{ path: 'after', message: 'tasks of the same project, comma-separated' }])
      const auto = str('auto')
      const origin = (['coordinator', 'automation', 'mission'] as const).find(x => x === o.origin) ?? 'user'
      const task: Task = { id: `${p.key}-${n}`, project: p.key, title, description: str('description').slice(0, 20000), type, state: 'todo', origin, createdAt: Date.now(), ...(after ? { after } : {}), ...(auto ? { auto } : {}) }
      await writeJson(path.join(files.tasks, `${task.id}.json`), task)
      return task
    }),

    addProject: (raw: unknown, check: FolderCheck, opts?: FolderOptions) => write(async () => {
      const { project, errors } = cleanProjectInput(raw)
      if (!project) throw badInput(errors)
      const list = await projects()
      const clash = keyClash(list, project.key)
      if (clash) throw new HerdrError('exists', `Project ${clash.name} already has the key ${project.key}`)
      const { template, ...fields } = project
      const source = template ? await sourceOf(template) : null
      const checked = await check(project.machine, project.path, opts)
      const { path: folder, git } = typeof checked === 'string' ? { path: checked, git: true } : checked
      if (list.some(p => p.machine === project.machine && p.path === folder)) throw new HerdrError('exists', 'This folder is already a project')
      // A removed project's workflow and log under the same key are not the new one's.
      await Promise.all([workflowFile(fields.key), workflowLogFile(fields.key)].map(f => fs.rm(f, { force: true })))
      let added: Project = { ...fields, color: fields.color ?? defaultColor(list), path: folder, ...(git ? {} : { git: false as const }), addedAt: Date.now() }
      if (source) added = { ...added, from: (await copyTemplate(added.key, source, 'user')).from }
      await saveProjects([...list, added])
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
      const { base: _base, label: _label, aliases: _aliases, ...rest } = list[i]!
      const base = update.base ?? list[i]!.base
      const next = update.key ?? shownKey(list[i]!)
      const clash = keyClash(list, next, rest.key)
      if (clash) throw new HerdrError('exists', `Project ${clash.name} already has the key ${next}`)
      list[i] = { ...rest, ...renamed(list[i]!, next), ...(update.name ? { name: update.name } : {}), ...(base ? { base } : {}), ...(update.color ? { color: update.color } : {}) }
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
      const { base: _old, ...rest } = list[i]!
      list[i] = b ? { ...rest, base: b } : rest
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
  }
}

export type PmStore = ReturnType<typeof createPmStore>
let store: PmStore | null = null
export const pmStore = () => (store ??= createPmStore())
