// A managed project: a git folder on a machine reached through herdr-core,
// and the template its tasks follow. Stored in DATA_DIR/projects/projects.json.
import type { WorkflowError } from './workflow'
import type { Task } from './run'

export interface Project {
  key: string // task ids are <key>-<n>: WHR-344
  name: string
  machine: string // herdr-core machine key, '' = the wherdr host
  path: string
  base?: string // branch tasks start from (default: the repo's current one)
  template?: string // template id; none yet = no task can start
  addedAt: number
}

export type ProjectInput = Omit<Project, 'addedAt'>
export interface TemplateInfo { id: string, version?: number }
// GET /api/pm/overview
export interface PmOverview { enabled: boolean, projects: Project[], templates: TemplateInfo[], tasks?: Task[] }

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
// A branch name git takes, without the odd cases (.., @{, spaces, ~^:?*[\).
const BRANCH_RE = /^(?!.*\.\.)(?!.*@\{)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,100}$/

export const isTemplateId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id)

// Checks a project to add; returns its clean form or the errors.
export function cleanProjectInput(raw: unknown): { project?: ProjectInput, errors: WorkflowError[] } {
  const errors: WorkflowError[] = []
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' ? (o[k] as string).trim() : '')
  const key = str('key').toUpperCase()
  if (!KEY_RE.test(key)) errors.push({ path: 'key', message: '2 to 10 letters or digits, starting with a letter' })
  const name = str('name') || key
  if (name.length > 80) errors.push({ path: 'name', message: 'at most 80 characters' })
  if (typeof o.machine !== 'string' || o.machine.length > 64) errors.push({ path: 'machine', message: 'unknown machine' })
  const path = str('path')
  if (!path.startsWith('/') && !path.startsWith('~')) errors.push({ path: 'path', message: 'an absolute folder path' })
  else if (path.length > 1024 || path.includes('\0')) errors.push({ path: 'path', message: 'invalid folder' })
  const base = str('base')
  if (base && !BRANCH_RE.test(base)) errors.push({ path: 'base', message: 'invalid branch name' })
  const template = str('template')
  if (template && !isTemplateId(template)) errors.push({ path: 'template', message: 'invalid template id' })
  if (errors.length) return { errors }
  return {
    errors,
    project: { key, name, machine: o.machine as string, path, ...(base ? { base } : {}), ...(template ? { template } : {}) },
  }
}
