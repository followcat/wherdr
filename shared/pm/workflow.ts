// Project workflow templates: a mechanism to describe steps, not a workflow.
// wherdr knows steps, who holds them, how they end and the guards the user
// sets; what each step asks of an agent is plain text written in the template.

export const HOLDERS = ['worker', 'reviewer', 'coordinator', 'none'] as const
export type Holder = typeof HOLDERS[number]
// report: the agent says it is done. verdict: pass or send back. user: the
// user's gesture. action: the engine runs `action`.
export const ENDS = ['report', 'verdict', 'user', 'action'] as const
export type End = typeof ENDS[number]
export const EVIDENCE = ['link', 'commit', 'report', 'proposed-tasks', 'screenshots'] as const
export type Evidence = typeof EVIDENCE[number]
// What screenshots evidence asks for: the result only, or before and after the change.
export const SHOT_MODES = ['after', 'before-after'] as const
export type ShotMode = typeof SHOT_MODES[number]
export const ACTIONS = ['git.land', 'git.push', 'github.pr', 'github.merge', 'git.verify-merged'] as const
export type ActionKind = typeof ACTIONS[number]
// Who may merge: only the user, or the engine too. Ordered loosest first.
export const MERGE_BY = ['engine', 'user'] as const
export type MergeBy = typeof MERGE_BY[number]

export interface StepAction { kind: ActionKind, target?: string, base?: string }

export interface Step {
  id: string
  column?: string // board column, defaults to the id; steps may share one
  holder?: Holder // defaults to 'none'
  instructions?: string
  ends?: End // none: the step waits to start (to do) or is the last one (done)
  userLabel?: string // button text for ends: user
  badge?: string // what the user has to do, shown on the card in Your turn
  evidence?: Evidence[]
  screenshots?: ShotMode // with evidence screenshots, defaults to 'after'
  recheck?: string // duration, for a coordinator step
  timeout?: string // duration, then the task goes to Your turn
  sendBack?: string // ends: verdict, an earlier step
  rounds?: number // ends: verdict, send-backs before the after-N rule
  action?: StepAction
}

export interface Guards {
  protected?: string[]
  merge?: { protected?: MergeBy, others?: MergeBy }
}

export interface Prefs { agent?: string, model?: string, reviewAgent?: string, reviewModel?: string }
export const PREF_KEYS = ['agent', 'model', 'reviewAgent', 'reviewModel'] as const

export interface TaskType {
  instructions?: string
  guards?: Guards // may only make the project's guards stricter
  prefs?: Prefs
  childType?: string // the type of the tasks this one proposes (a split)
  steps: (Step | string)[] // a string reuses a shared step by its id
}

export interface Template {
  id: string
  version?: number
  guards?: Guards
  instructions?: string
  prefs?: Prefs
  steps?: Record<string, Step> // shared steps, reused by id
  taskTypes: Record<string, TaskType>
}

// What a task brings at creation. No step rules (rounds, sendBack, holder…):
// only the template changes those.
export interface TaskInput {
  type: string
  instructions?: string
  guards?: Guards
  prefs?: Prefs
  steps?: Record<string, { instructions?: string, timeout?: string }>
}

export interface WorkflowError { path: string, message: string }

const DURATION = /^\d+[smhd]$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown) => typeof v === 'string' && v.trim() !== ''

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, errs: WorkflowError[]) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errs.push({ path: path ? `${path}.${k}` : k, message: 'unknown field' })
}

function checkGuards(g: unknown, path: string, errs: WorkflowError[]) {
  if (g === undefined) return
  if (!isObj(g)) return void errs.push({ path, message: 'must be an object' })
  checkKeys(g, ['protected', 'merge'], path, errs)
  if (g.protected !== undefined && !(Array.isArray(g.protected) && g.protected.every(isStr)))
    errs.push({ path: `${path}.protected`, message: 'must be a list of branch names' })
  if (g.merge === undefined) return
  if (!isObj(g.merge)) return void errs.push({ path: `${path}.merge`, message: 'must be an object' })
  checkKeys(g.merge, ['protected', 'others'], `${path}.merge`, errs)
  for (const k of ['protected', 'others'] as const) {
    const v = g.merge[k]
    if (v !== undefined && !MERGE_BY.includes(v as MergeBy)) errs.push({ path: `${path}.merge.${k}`, message: `must be one of ${MERGE_BY.join(', ')}` })
  }
}

function checkPrefs(p: unknown, path: string, errs: WorkflowError[]) {
  if (p === undefined) return
  if (!isObj(p)) return void errs.push({ path, message: 'must be an object' })
  checkKeys(p, PREF_KEYS, path, errs)
  for (const [k, v] of Object.entries(p)) if (!isStr(v)) errs.push({ path: `${path}.${k}`, message: 'must be text' })
}

const STEP_KEYS = ['id', 'column', 'holder', 'instructions', 'ends', 'userLabel', 'badge', 'evidence', 'screenshots', 'recheck', 'timeout', 'sendBack', 'rounds', 'action']

function checkStep(s: unknown, path: string, earlier: string[], errs: WorkflowError[]) {
  const err = (field: string, message: string) => errs.push({ path: field ? `${path}.${field}` : path, message })
  if (!isObj(s)) return err('', 'must be a step or the id of a shared step')
  checkKeys(s, STEP_KEYS, path, errs)
  if (!isStr(s.id)) err('id', 'is required')
  for (const k of ['column', 'instructions', 'userLabel', 'badge'])
    if (s[k] !== undefined && typeof s[k] !== 'string') err(k, 'must be text')
  if (s.holder !== undefined && !HOLDERS.includes(s.holder as Holder)) err('holder', `must be one of ${HOLDERS.join(', ')}`)
  if (s.ends !== undefined && !ENDS.includes(s.ends as End)) err('ends', `must be one of ${ENDS.join(', ')}`)
  const agent = s.holder !== undefined && s.holder !== 'none'
  if ((s.ends === 'report' || s.ends === 'verdict') && !agent) err('holder', `an agent must hold a step that ends with ${s.ends}`)
  if (s.evidence !== undefined && !(Array.isArray(s.evidence) && s.evidence.every(e => EVIDENCE.includes(e))))
    err('evidence', `must be a list of ${EVIDENCE.join(', ')}`)
  if (s.screenshots !== undefined) {
    if (!SHOT_MODES.includes(s.screenshots as ShotMode)) err('screenshots', `must be one of ${SHOT_MODES.join(', ')}`)
    else if (!(Array.isArray(s.evidence) && s.evidence.includes('screenshots'))) err('screenshots', 'only for a step whose evidence has screenshots')
  }
  for (const k of ['recheck', 'timeout'])
    if (s[k] !== undefined && !(typeof s[k] === 'string' && DURATION.test(s[k]))) err(k, 'must be a duration like 30s, 5m, 2h or 1d')
  if (s.ends === 'verdict') {
    if (!earlier.includes(s.sendBack as string)) err('sendBack', 'must name an earlier step')
    if (s.rounds !== undefined && !(Number.isInteger(s.rounds) && (s.rounds as number) > 0)) err('rounds', 'must be a whole number above 0')
  }
  else for (const k of ['sendBack', 'rounds']) if (s[k] !== undefined) err(k, 'only for a step that ends with verdict')
  if (s.ends === 'action' && s.action === undefined) err('action', 'is required for a step that ends with action')
  if (s.action === undefined) return
  if (!isObj(s.action) || !ACTIONS.includes(s.action.kind as ActionKind)) return err('action.kind', `must be one of ${ACTIONS.join(', ')}`)
  checkKeys(s.action, ['kind', 'target', 'base'], `${path}.action`, errs)
  const need = s.action.kind === 'github.pr' ? 'base' : ['git.land', 'git.verify-merged'].includes(s.action.kind as string) ? 'target' : null
  if (need && !isStr(s.action[need])) err(`action.${need}`, 'is required')
  if (s.ends !== 'action' && s.ends !== 'user') err('action', 'only for a step that ends with action or user')
}

// Every problem in a template, each with the path of the field at fault.
export function validateTemplate(t: unknown): WorkflowError[] {
  const errs: WorkflowError[] = []
  if (!isObj(t)) return [{ path: '', message: 'must be an object' }]
  checkKeys(t, ['id', 'version', 'guards', 'instructions', 'prefs', 'steps', 'taskTypes'], '', errs)
  if (!isStr(t.id)) errs.push({ path: 'id', message: 'is required' })
  if (t.version !== undefined && !Number.isInteger(t.version)) errs.push({ path: 'version', message: 'must be a whole number' })
  if (t.instructions !== undefined && typeof t.instructions !== 'string') errs.push({ path: 'instructions', message: 'must be text' })
  checkGuards(t.guards, 'guards', errs)
  checkPrefs(t.prefs, 'prefs', errs)
  const shared = isObj(t.steps) ? t.steps : {}
  if (t.steps !== undefined && !isObj(t.steps)) errs.push({ path: 'steps', message: 'must be an object' })
  for (const [id, s] of Object.entries(shared)) {
    if (isObj(s) && s.id !== id) errs.push({ path: `steps.${id}.id`, message: 'must match its key' })
    // A shared step's sendBack is checked where a task type uses it.
    checkStep(s, `steps.${id}`, isObj(s) && isStr(s.sendBack) ? [s.sendBack as string] : [], errs)
  }
  if (!isObj(t.taskTypes) || !Object.keys(t.taskTypes).length) return [...errs, { path: 'taskTypes', message: 'needs at least one task type' }]
  for (const [name, tt] of Object.entries(t.taskTypes)) {
    const path = `taskTypes.${name}`
    if (!isObj(tt)) { errs.push({ path, message: 'must be an object' }); continue }
    checkKeys(tt, ['instructions', 'guards', 'prefs', 'childType', 'steps'], path, errs)
    if (tt.instructions !== undefined && typeof tt.instructions !== 'string') errs.push({ path: `${path}.instructions`, message: 'must be text' })
    checkGuards(tt.guards, `${path}.guards`, errs)
    checkPrefs(tt.prefs, `${path}.prefs`, errs)
    if (tt.childType !== undefined && !Object.hasOwn(t.taskTypes, tt.childType as string)) errs.push({ path: `${path}.childType`, message: 'must name a task type of this template' })
    if (!Array.isArray(tt.steps) || !tt.steps.length) { errs.push({ path: `${path}.steps`, message: 'needs at least one step' }); continue }
    const seen: string[] = []
    tt.steps.forEach((entry, i) => {
      const p = `${path}.steps[${i}]`
      if (typeof entry === 'string' && !Object.hasOwn(shared, entry)) errs.push({ path: p, message: `no shared step "${entry}"` })
      const step = typeof entry === 'string' ? shared[entry] : entry
      if (typeof entry !== 'string') checkStep(entry, p, seen, errs)
      else if (isObj(step) && step.ends === 'verdict' && !seen.includes(step.sendBack as string)) errs.push({ path: p, message: `sendBack "${step.sendBack}" is not an earlier step here` })
      const id = isObj(step) ? step.id as string : undefined
      if (id && seen.includes(id)) errs.push({ path: `${p}.id`, message: `step "${id}" appears twice` })
      if (id) seen.push(id)
    })
  }
  return errs
}

export function validateTaskInput(input: unknown): WorkflowError[] {
  const errs: WorkflowError[] = []
  if (!isObj(input)) return [{ path: '', message: 'must be an object' }]
  checkKeys(input, ['type', 'instructions', 'guards', 'prefs', 'steps'], '', errs)
  if (!isStr(input.type)) errs.push({ path: 'type', message: 'is required' })
  if (input.instructions !== undefined && typeof input.instructions !== 'string') errs.push({ path: 'instructions', message: 'must be text' })
  checkGuards(input.guards, 'guards', errs)
  checkPrefs(input.prefs, 'prefs', errs)
  if (input.steps === undefined) return errs
  if (!isObj(input.steps)) return [...errs, { path: 'steps', message: 'must be an object' }]
  for (const [id, o] of Object.entries(input.steps)) {
    const path = `steps.${id}`
    if (!isObj(o)) { errs.push({ path, message: 'must be an object' }); continue }
    // rounds, sendBack, holder…: only a template change, asked by the user, sets them.
    for (const k of Object.keys(o)) if (k !== 'instructions' && k !== 'timeout') errs.push({ path: `${path}.${k}`, message: 'a task cannot change this; edit the template' })
    if (o.instructions !== undefined && typeof o.instructions !== 'string') errs.push({ path: `${path}.instructions`, message: 'must be text' })
    if (o.timeout !== undefined && !(typeof o.timeout === 'string' && DURATION.test(o.timeout))) errs.push({ path: `${path}.timeout`, message: 'must be a duration like 30s, 5m, 2h or 1d' })
  }
  return errs
}
