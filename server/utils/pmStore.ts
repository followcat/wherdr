// Project management storage, in DATA_DIR/projects/ (one engine, on the wherdr
// host): pm.json (the on/off switch and this install's id), projects.json,
// templates/<id>.json, template-log/<id>.json, tasks/<KEY>-<n>.json, runs/<id>.json, receipts/<id>.json,
// shots/<KEY>-<n>/<file> (a task's screenshots),
// coordinators/<KEY>.json (the hash of the coordinator's token, its current turn, its autopilot),
// wakes.jsonl (the coordinators' wake queue, append-only: the last line of an id wins).
// Atomic writes (temp file + rename), one at a time. Switched off, every
// write is refused except turning it back on.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { cleanProjectInput, isTemplateId, type PmOverview, type Project, type TemplateInfo } from '../../shared/pm/project'
import { validateTemplate, type Template } from '../../shared/pm/workflow'
import { templateChanges, type LogEntry } from '../../shared/pm/templateText'
import { publicTask, type Run, type Task } from '../../shared/pm/run'
import type { Receipt } from '../../shared/pm/actions'
import { SHOT_FILE_RE } from '../../shared/pm/shots'
import { HerdrError } from './herdr'
import type { CoordinatorAgent, Proposal, ProposalOutcome } from '../../shared/pm/coordinator'
import type { Autopilot, TaskStatus } from '../../shared/pm/autopilot'
import { readQueue, type Wake } from '../../shared/pm/wakes'
import { DATA_DIR } from './env'

// A project coordinator: the sha256 of its token, its terminal (herdr-core
// address), where its current turn comes from (said: the user's message), the
// project's default agent, the agent its conversation ran with, and a template
// change waiting for the user.
export interface CoordinatorRecord {
  project: string, tokenHash: string, terminal?: string, turn?: { kind: 'user' | 'wake', at: number, said?: string }
  agent?: CoordinatorAgent, ran?: CoordinatorAgent, proposal?: Proposal, answered?: { outcome: ProposalOutcome, at: number }
  // userAt: the user's last message. seen: each task's status at the last tick; ranAt: the last interval wake.
  userAt?: number, autopilot?: Autopilot, seen?: Record<string, TaskStatus>, ranAt?: number
}

// The checks the store cannot make itself: the machine, a git folder there.
// Resolves to the folder's absolute path.
export type FolderCheck = (machine: string, folder: string) => Promise<string>

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

const TASK_ID_RE = /^[A-Z][A-Z0-9]{1,9}-\d{1,6}$/
const badInput = (errors: { path: string, message: string }[]) =>
  new HerdrError('bad_input', errors.map(e => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; '))

export function createPmStore(dir = path.join(DATA_DIR, 'projects')) {
  const files = {
    pm: path.join(dir, 'pm.json'), projects: path.join(dir, 'projects.json'), templates: path.join(dir, 'templates'), templateLog: path.join(dir, 'template-log'),
    tasks: path.join(dir, 'tasks'), runs: path.join(dir, 'runs'), receipts: path.join(dir, 'receipts'), shots: path.join(dir, 'shots'),
    coordinators: path.join(dir, 'coordinators'), wakes: path.join(dir, 'wakes.jsonl'),
  }
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn)
    queue = run.catch(() => {})
    return run
  }

  const pm = async () => (await readJson<{ enabled?: boolean, install?: string }>(files.pm)) ?? {}
  const enabled = async () => (await pm()).enabled === true
  const readAll = async <T>(folder: string) => {
    const names = (await fs.readdir(folder).catch(() => [] as string[])).filter(n => n.endsWith('.json')).sort()
    return (await Promise.all(names.map(n => readJson<T>(path.join(folder, n)).catch(() => null)))).filter((x): x is Awaited<T> & {} => !!x)
  }
  const tasks = () => readAll<Task>(files.tasks)
  const projects = async () => (await readJson<{ projects?: Project[] }>(files.projects))?.projects ?? []
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
  const saveProjects = (list: Project[]) => writeJson(files.projects, { v: 1, projects: list })
  async function findProject(key: unknown) {
    const list = await projects()
    const i = list.findIndex(p => p.key === key)
    if (i < 0) throw new HerdrError('not_found', 'Unknown project')
    return { list, i }
  }
  async function knownTemplate(id: string | undefined) {
    if (id && !(await templates()).some(t => t.id === id)) throw new HerdrError('not_found', 'Unknown template')
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
    task: (id: unknown) => (typeof id === 'string' && TASK_ID_RE.test(id) ? readJson<Task>(path.join(files.tasks, `${id}.json`)) : Promise.resolve(null)),
    template: (id: string) => (isTemplateId(id) ? readJson<Template>(path.join(files.templates, `${id}.json`)) : Promise.resolve(null)),
    templateLog: async (id: string) => (isTemplateId(id) ? (await readJson<{ entries?: LogEntry[] }>(path.join(files.templateLog, `${id}.json`)))?.entries : null) ?? [],
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
    coordinator: (key: string) => readJson<CoordinatorRecord>(path.join(files.coordinators, `${key}.json`)),
    coordinators: () => readAll<CoordinatorRecord>(files.coordinators),
    saveCoordinator: (c: CoordinatorRecord) => write(() => writeJson(path.join(files.coordinators, `${c.project}.json`), c)),
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
    saveRun: (r: Run) => write(() => writeJson(path.join(files.runs, `${r.id}.json`), r)),
    receipt: (id: string) => readJson<Receipt>(path.join(files.receipts, `${id}.json`)),
    saveReceipt: (r: Receipt) => write(() => writeJson(path.join(files.receipts, `${r.id}.json`), r)),

    // { project, title, description?, type }: a new task, to do.
    addTask: (raw: unknown) => write(async () => {
      const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
      const p = (await projects()).find(x => x.key === o.project)
      if (!p) throw new HerdrError('not_found', 'Unknown project')
      const title = str('title'), type = str('type')
      if (!title || title.length > 200) throw badInput([{ path: 'title', message: '1 to 200 characters' }])
      if (!type) throw badInput([{ path: 'type', message: 'is required' }])
      const n = 1 + Math.max(0, ...(await tasks()).filter(t => t.project === p.key).map(t => Number(t.id.slice(p.key.length + 1)) || 0))
      const task: Task = { id: `${p.key}-${n}`, project: p.key, title, description: str('description').slice(0, 20000), type, state: 'todo', createdAt: Date.now() }
      await writeJson(path.join(files.tasks, `${task.id}.json`), task)
      return task
    }),

    addProject: (raw: unknown, check: FolderCheck) => write(async () => {
      const { project, errors } = cleanProjectInput(raw)
      if (!project) throw badInput(errors)
      const list = await projects()
      if (list.some(p => p.key === project.key)) throw new HerdrError('exists', 'A project already has this key')
      await knownTemplate(project.template)
      const folder = await check(project.machine, project.path)
      if (list.some(p => p.machine === project.machine && p.path === folder)) throw new HerdrError('exists', 'This folder is already a project')
      const added: Project = { ...project, path: folder, addedAt: Date.now() }
      await saveProjects([...list, added])
      return added
    }),

    // Picks (or clears, with '') the project's template.
    setTemplate: (key: unknown, template: unknown) => write(async () => {
      const id = typeof template === 'string' ? template : ''
      if (id && !isTemplateId(id)) throw badInput([{ path: 'template', message: 'invalid template id' }])
      await knownTemplate(id || undefined)
      const { list, i } = await findProject(key)
      const { template: _old, ...rest } = list[i]!
      list[i] = id ? { ...rest, template: id } : rest
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
      // Each save that changes something is a new version and a line of its log.
      const file = path.join(files.templates, `${id}.json`)
      const old = await readJson<Template>(file)
      if (old && !replace) throw new HerdrError('exists', 'A template already has this id')
      const changes = templateChanges(old, t as Template)
      if (old && !changes.length) return { id: id!, version: old.version ?? 1 }
      const version = (old?.version ?? 0) + 1
      await writeJson(file, { ...(t as Template), version })
      const logFile = path.join(files.templateLog, `${id}.json`)
      const entries = (await readJson<{ entries?: LogEntry[] }>(logFile))?.entries ?? []
      await writeJson(logFile, { v: 1, entries: [...entries, { at: Date.now(), by, version, changes, ...(said ? { said } : {}) }].slice(-200) })
      return { id: id!, version }
    }),
  }
}

export type PmStore = ReturnType<typeof createPmStore>
let store: PmStore | null = null
export const pmStore = () => (store ??= createPmStore())
