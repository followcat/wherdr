// The wherdr v2 herdr-projects board, read only, when Alfred asks for it
// (`wherdr alfred v2`): its projects, as candidates for v3 projects, with their
// open tasks. The install reads nothing of it; nothing here writes.
import fs from 'node:fs'
import path from 'node:path'
import { isGitBranch } from '../../shared/pm/project'

type Obj = Record<string, any>
export interface BoardTask { repo: string, n?: unknown, id?: unknown, stage?: unknown, title?: unknown, description?: unknown, archivedAt?: unknown, branch?: unknown, pr?: unknown }
// coordinators: config.json's coordinators.projects.<repo> (its autopilot goal);
// coordinated: the repos whose v2 coordinator exists (it was ever talked to).
export interface Board { repos: Record<string, unknown>, settings: Record<string, Obj>, tasks: BoardTask[], coordinators?: Record<string, Obj>, coordinated?: string[] }
// handover: the prompt the user pastes to the project's v2 coordinator, when it
// exists; goalLine: its v2 autopilot goal, as one line of the new coordinator's memory.md.
export interface V2Candidate { key: string, name: string, path: string, here: boolean, base?: string, left: string[], tasks: V2Task[], handover?: string, goalLine?: string }
// An open v2 task: its stage, and its branch and PR when it was under way.
// intro: how its description starts when Alfred adds it again.
export interface V2Task { v2: string, stage: string, title: string, description: string, branch?: string, pr?: number, intro: string }

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const readJson = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) } catch { return null } }
const list = (d: string) => { try { return fs.readdirSync(d) } catch { return [] } }

// The prompt for a v2 project coordinator: what the new one should know.
export const HANDOVER_PROMPT = 'Write a handover note, at most 25 lines: decisions and preferences, conventions, open work and where it stands, what to avoid.'

// The repos whose v2 coordinator exists: data/coordinator/<session>/projects/<folder>/state.json
// (its repo in the state, else the folder's name).
function coordinated(hpDir: string) {
  const top = path.join(hpDir, 'data', 'coordinator')
  return list(top).flatMap(session => list(path.join(top, session, 'projects')).flatMap((n) => {
    const st = readJson(path.join(top, session, 'projects', n, 'state.json'))
    return isObj(st) ? [typeof st.repo === 'string' && st.repo ? st.repo : n] : []
  }))
}

// repos.json { name: path }, settings/config.json repos.<name> (key and per-repo settings)
// and coordinators.projects.<name>, data/tasks/<repo>/<n>/task.json.
export function readBoard(hpDir: string): Board | null {
  const repos = readJson(path.join(hpDir, 'data', 'repos.json'))
  if (!isObj(repos)) return null
  const config = readJson(path.join(hpDir, 'settings', 'config.json'))
  const tasks: BoardTask[] = []
  const tdir = path.join(hpDir, 'data', 'tasks')
  for (const repo of list(tdir).sort()) {
    for (const n of list(path.join(tdir, repo)).sort((a, b) => Number(a) - Number(b))) {
      const t = readJson(path.join(tdir, repo, n, 'task.json'))
      if (isObj(t)) tasks.push({ ...t, repo })
    }
  }
  const coordinators = isObj(config) && isObj(config.coordinators) && isObj(config.coordinators.projects) ? config.coordinators.projects : {}
  return { repos, settings: isObj(config) && isObj(config.repos) ? config.repos : {}, tasks, coordinators, coordinated: coordinated(hpDir) }
}

// Same rules as shared/pm/project.ts (KEY_RE, BRANCH_RE).
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/
const BRANCH_RE = /^(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/$)[\w./-]{1,100}$/
const DONE_STAGES = new Set(['done', 'merged', 'closed', 'cancelled', 'canceled'])

function keyFor(name: string, wanted: string, taken: Set<string>) {
  const derived = name.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^\d+/, '').slice(0, 10)
  const base = KEY_RE.test(wanted) ? wanted : KEY_RE.test(derived) ? derived : 'PRJ'
  let key = base
  for (let i = 2; taken.has(key); i++) key = `${base.slice(0, 10 - String(i).length)}${i}`
  return key
}

// Flattened setting paths of a repo: { merge: { by: 'x' } } → ['merge.by'].
const flat = (o: Obj, pre = ''): string[] => Object.entries(o || {}).flatMap(([k, v]) => (isObj(v) ? flat(v, `${pre}${k}.`) : [`${pre}${k}`]))

// How v2 showed a board task: KEY-n with the repo's key (WHR-37), else its id (app/1).
export function v2TaskName(board: Board, t: BoardTask) {
  const key = String(board.settings[t.repo]?.repo?.key || '').toUpperCase()
  const n = Number(t.n)
  return KEY_RE.test(key) && Number.isInteger(n) && n > 0 ? `${key}-${n}` : String(t.id || `${t.repo}/${t.n}`)
}

// v2 keeps the PR as its URL (…/pull/12); a number or "#12" is read too.
function prNumber(v: unknown): number | undefined {
  const m = typeof v === 'number' ? [, String(v)] : typeof v === 'string' ? v.trim().match(/(?:\/pull\/|^#?)(\d{1,7})$/) : null
  const n = Number(m?.[1])
  return Number.isInteger(n) && n > 0 ? n : undefined
}

// The text an added-again task's description starts with: where it comes from,
// and the branch and PR its worker continues from.
export function v2Intro(v2: string, branch?: string, pr?: number) {
  const from = [branch && `branch \`${branch}\``, pr && `PR #${pr}`].filter(Boolean).join(' / ')
  return `From v2 ${v2}.${from ? ` Continue from ${from}.` : ''}`
}

// A v2 coordinator's autopilot goal (nested or dotted), as one memory.md line; "none" is no goal.
export function goalLine(co: Obj | undefined) {
  const g = isObj(co?.autopilot) ? co.autopilot.goal : co?.['autopilot.goal']
  const text = typeof g === 'string' ? g.replace(/\s+/g, ' ').trim().slice(0, 500) : ''
  return text && text !== 'none' ? `- Goal from v2's autopilot: ${text}` : undefined
}

function v2Task(board: Board, t: BoardTask): V2Task {
  const v2 = v2TaskName(board, t)
  const branch = typeof t.branch === 'string' && isGitBranch(t.branch.trim()) ? t.branch.trim() : undefined
  const pr = prNumber(t.pr)
  return { v2, stage: String(t.stage || 'todo'), title: String(t.title || '').trim().slice(0, 200) || `Task ${v2}`, description: String(t.description || '').slice(0, 20000), ...(branch ? { branch } : {}), ...(pr ? { pr } : {}), intro: v2Intro(v2, branch, pr) }
}

// Board repos → candidates for v3 projects. None is added here: Alfred offers
// them to the user. Each: a suggested key (free in v3), its folder on this
// machine and whether it is there, its base branch, the v2 settings to redo in
// its template, and its open tasks. `existing`: v3's projects.
export function mapCandidates(board: Board, existing: { key: string }[] = [], exists = (p: string) => fs.existsSync(p)) {
  const projects: V2Candidate[] = [], skipped: { name: string, path: string, reason: string }[] = []
  const taken = new Set(existing.map(p => p.key))
  for (const [name, folder] of Object.entries(board.repos).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof folder !== 'string' || !folder.startsWith('/')) { skipped.push({ name, path: String(folder), reason: 'not an absolute path' }); continue }
    const s = board.settings[name] || {}
    const key = keyFor(name, String(s.repo?.key || '').toUpperCase(), taken)
    taken.add(key)
    const from = s.workspace?.from
    const base = typeof from === 'string' && BRANCH_RE.test(from) ? from : undefined
    const left = flat(s).filter(k => k !== 'repo.key' && !(k === 'workspace.from' && base))
    const tasks = board.tasks
      .filter(t => t.repo === name && !t.archivedAt && !DONE_STAGES.has(String(t.stage || 'todo')))
      .map(t => v2Task(board, t))
    const goal = goalLine(board.coordinators?.[name])
    projects.push({
      key, name: name.slice(0, 80), path: folder, here: exists(folder), ...(base ? { base } : {}), left, tasks,
      ...(board.coordinated?.includes(name) ? { handover: HANDOVER_PROMPT } : {}), ...(goal ? { goalLine: goal } : {}),
    })
  }
  return { projects, skipped }
}

// The v2 projects, read now from the board. A v3 project already made from one
// (same folder or name) keeps its key out of the others' way, not its own.
export function readV2Projects(hpDir: string, existing: { key: string, path: string, name: string }[] = [], exists?: (p: string) => boolean): V2Candidate[] {
  const board = readBoard(hpDir)
  if (!board) return []
  const own = new Set(Object.entries(board.repos).flatMap(([n, p]) => [n, String(p)]))
  return mapCandidates(board, existing.filter(p => !own.has(p.path) && !own.has(p.name)), exists).projects
}
