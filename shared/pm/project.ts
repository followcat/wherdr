// A managed project: a folder (git, unless git: false) on a machine reached through herdr-core,
// and its own workflow (DATA_DIR/projects/workflows/<KEY>.json), which its tasks follow. Stored in DATA_DIR/projects/projects.json.
import type { WorkflowError } from './workflow'
import type { Task } from './run'
import type { RepoVisibility } from './visibility'
import { isProjectColor, type ProjectColor } from './projectKey'

export interface Project {
  key: string // the fixed id (see projectKey.ts): task ids are <key>-<n>: WHR-344
  label?: string // the key shown and edited, when it is not the id
  aliases?: string[] // the keys shown before: they still resolve
  color?: ProjectColor // its badge's color, from the palette
  name: string
  machine: string // herdr-core machine key, '' = the wherdr host
  path: string
  git?: false // a folder without git: its coordinator works in it, no task worktree
  // Working branch: tasks start from it, and a step's PR, land or check uses it
  // when the step names no branch. Default: the repo's current branch, no default.
  base?: string
  // The library template (or example) its workflow was copied from: information
  // only, never followed. None: no workflow yet, no task can start.
  from?: { template: string, version: number }
  visibility?: RepoVisibility // public repository: guardrails for its coordinator and tasks
  addedAt: number
}

// template: a library template id or example:<id>, copied into the project's workflow.
export type ProjectInput = Omit<Project, 'addedAt' | 'from' | 'label' | 'aliases'> & { template?: string }
export interface TemplateInfo { id: string, version?: number }
// GET /api/pm/overview
export interface PmOverview { enabled: boolean, projects: Project[], templates: TemplateInfo[], tasks?: Task[] }

export const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
// A branch name git takes, without the odd cases (.., @{, spaces, ~^:?*[\).
const BRANCH_RE = /^(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/

export const isBranch = (b: string) => BRANCH_RE.test(b)
export const isTemplateId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)

const KEY_HINT = '2 to 10 letters or digits, starting with a letter'
export interface ProjectUpdate { name?: string, base?: string, key?: string, color?: ProjectColor }

// The fields the user changes on a project (General tab): name, base ('' clears it), key, color.
export function cleanProjectUpdate(raw: unknown): { update?: ProjectUpdate, errors: WorkflowError[] } {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const errors: WorkflowError[] = [], update: ProjectUpdate = {}
  // `key` names the project; `newKey` is its new shown key.
  if (o.newKey !== undefined) {
    const key = typeof o.newKey === 'string' ? o.newKey.trim().toUpperCase() : ''
    if (!KEY_RE.test(key)) errors.push({ path: 'key', message: KEY_HINT })
    else update.key = key
  }
  if (o.color !== undefined) {
    if (!isProjectColor(o.color)) errors.push({ path: 'color', message: 'not a palette color' })
    else update.color = o.color
  }
  if (o.name !== undefined) {
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name || name.length > 80) errors.push({ path: 'name', message: '1 to 80 characters' })
    else update.name = name
  }
  if (o.base !== undefined) {
    const base = typeof o.base === 'string' ? o.base.trim() : null
    if (base === null || (base && !BRANCH_RE.test(base))) errors.push({ path: 'base', message: 'invalid branch name' })
    else update.base = base
  }
  return errors.length ? { errors } : { update, errors }
}

// Checks a project to add; returns its clean form or the errors.
export function cleanProjectInput(raw: unknown): { project?: ProjectInput, errors: WorkflowError[] } {
  const errors: WorkflowError[] = []
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  const key = str('key').toUpperCase()
  if (!KEY_RE.test(key)) errors.push({ path: 'key', message: KEY_HINT })
  const name = str('name') || key
  if (name.length > 80) errors.push({ path: 'name', message: 'at most 80 characters' })
  if (typeof o.machine !== 'string' || o.machine.length > 64) errors.push({ path: 'machine', message: 'unknown machine' })
  const path = str('path')
  if (!path.startsWith('/') && !path.startsWith('~')) errors.push({ path: 'path', message: 'an absolute folder path' })
  else if (path.length > 1024 || path.includes('\0')) errors.push({ path: 'path', message: 'invalid folder' })
  const base = str('base')
  if (base && !isBranch(base)) errors.push({ path: 'base', message: 'invalid branch name' })
  if (o.color !== undefined && !isProjectColor(o.color)) errors.push({ path: 'color', message: 'not a palette color' })
  const template = str('template')
  if (template && !isTemplateId(template.replace(/^example:/, ''))) errors.push({ path: 'template', message: 'invalid template id' })
  if (errors.length) return { errors }
  return {
    errors,
    project: { key, name, machine: o.machine as string, path, ...(base ? { base } : {}), ...(isProjectColor(o.color) ? { color: o.color } : {}), ...(template ? { template } : {}) },
  }
}
