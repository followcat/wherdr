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
export const ACTIONS = ['git.land', 'git.push', 'github.pr', 'github.merge', 'bitbucket.merge', 'git.verify-merged', 'pipeline.watch'] as const
// The PR merges: they take a method and required checks.
export const isPrMerge = (k?: string) => k === 'github.merge' || k === 'bitbucket.merge'
export type ActionKind = typeof ACTIONS[number]
// Who may merge: only the user, or the engine too. Ordered loosest first.
export const MERGE_BY = ['engine', 'user'] as const
export type MergeBy = typeof MERGE_BY[number]

export const MERGE_METHODS = ['merge', 'squash', 'rebase'] as const
export type MergeMethod = typeof MERGE_METHODS[number]
// What a task needs of a machine (weight.ts).
export const WEIGHTS = ['light', 'standard', 'heavy'] as const
export type Weight = typeof WEIGHTS[number]
export const isWeight = (v: unknown): v is Weight => (WEIGHTS as readonly unknown[]).includes(v)
// github.merge: method (default: the first the repo allows) and checks, the
// names that must be there and green (a PR whose CI has not started yet has none).
// bitbucket.merge: the same; its default method is a merge commit.
// pipeline.watch: the engine polls a pipeline every `every` (default 1m) until
// `timeout` (default 30m). source github (default): the GitHub Actions runs of
// `branch`'s latest commit, else of the task's commit, `workflow` only when
// named. source command: `command`, run in the worktree, exits 0 done, 1
// failed, 2 still running. onFail worker: a failure goes back to the worker.
export const WATCH_SOURCES = ['github', 'command'] as const
export const WATCH = { every: '1m', timeout: '30m' } as const
export interface StepAction {
  kind: ActionKind, target?: string, base?: string, method?: MergeMethod, checks?: string[]
  source?: typeof WATCH_SOURCES[number], branch?: string, workflow?: string, command?: string, every?: string, timeout?: string, onFail?: 'worker' | 'user'
}

// What the action's branch field holds: a branch to merge into, or the PR's
// base. Left out, the project's working branch fills it (withBase in steps.ts).
export const actionField = (k: ActionKind): 'target' | 'base' | undefined =>
  k === 'github.pr' ? 'base' : k === 'git.land' || k === 'git.verify-merged' ? 'target' : undefined

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

// contributorPrs (the project's guards only; off when absent): the coordinator
// may merge an outside contributor's PR after the user's yes, into the
// branches not reserved for the user ('others') or into any ('all').
export const CONTRIBUTOR_PRS = ['others', 'all'] as const
export interface Guards {
  protected?: string[]
  merge?: { protected?: MergeBy, others?: MergeBy }
  contributorPrs?: typeof CONTRIBUTOR_PRS[number]
}

// reviewFallbackAgent and reviewFallbackModel (both, or none): the reviewer
// started instead when the review agent's account is at its limit.
export interface Prefs { agent?: string, model?: string, reviewAgent?: string, reviewModel?: string, reviewFallbackAgent?: string, reviewFallbackModel?: string }
export const PREF_KEYS = ['agent', 'model', 'reviewAgent', 'reviewModel', 'reviewFallbackAgent', 'reviewFallbackModel'] as const

// Agents the engine knows how to start with a pinned model and a first message.
export const PROGRAMS = ['claude', 'codex'] as const
// reviewModel: the worker's own model, in a new session.
export const SAME_MODEL = 'same'
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,63}$/

// A reviewer's agent and model (`field` asked for it): another model than the
// worker's, or "same" with the worker's agent. Returns the reason it cannot run.
export function reviewerCheck(worker: { program: string, model: string }, program: string, asked: string, field: 'reviewModel' | 'reviewFallbackModel'): { program: string, model: string } | { reason: string } {
  const same = asked === SAME_MODEL, model = same ? worker.model : asked
  if (!(PROGRAMS as readonly string[]).includes(program)) return { reason: `The engine cannot start "${program}": claude or codex` }
  if (same && program !== worker.program) return { reason: `${field} "${SAME_MODEL}" needs the worker's agent (${worker.program})` }
  if (!MODEL_RE.test(model)) return { reason: model ? `Invalid review model "${model}"` : `No review model set: add prefs.${field} to the template` }
  if (!same && model === worker.model) return { reason: `The reviewer must use another model than the worker (${model}), or set ${field} to "${SAME_MODEL}"` }
  return { program, model }
}

export interface TaskType {
  instructions?: string
  weight?: Weight // what its tasks need of a machine (weight.ts); left out, read from its steps
  guards?: Guards // may only make the project's guards stricter
  prefs?: Prefs
  childType?: string // the type of the tasks this one proposes (a split)
  steps: (Step | string)[] // a string reuses a shared step by its id
}

// Worktree setup (pmDeps.ts), before a task's first worker: copy, ignored
// files from the project's clone (literal paths: a tracked or missing one is
// skipped); share, ignored folders taken from the clone while `lockfile`
// (default package-lock.json) is the same in both (default node_modules, []
// none); command, run in the worktree when a folder could not be shared (or
// when none is listed), within `timeout` (default and at most 10m).
export interface WorktreeSetup { copy?: string[], share?: string[], lockfile?: string, command?: string, timeout?: string }
export const SETUP_KEYS = ['copy', 'share', 'lockfile', 'command', 'timeout'] as const
export const SETUP_TIMEOUT = '10m'

export interface Template {
  id: string
  version?: number
  guards?: Guards
  instructions?: string
  prefs?: Prefs
  worktree?: WorktreeSetup
  steps?: Record<string, Step> // shared steps, reused by id
  taskTypes: Record<string, TaskType>
  // A member project's: its workspace's guards, which its own only harden. Set
  // by the store when it serves the workflow, never saved (ownWorkflow drops it).
  workspaceGuards?: Guards
}

// A project's workflow until the user accepts one (a template copy or the
// coordinator's proposal): one type `task`, todo → work → done. Never saved;
// version 0 marks it (a saved workflow starts at 1).
export const defaultWorkflow = (key: string): Template => ({
  id: key.toLowerCase(), version: 0, prefs: { agent: 'claude', model: 'sonnet' },
  taskTypes: { task: { steps: [{ id: 'todo', column: 'To do' }, { id: 'work', column: 'Working', holder: 'worker', ends: 'report' }, { id: 'done', column: 'Done' }] } },
})
export const isDefaultWorkflow = (t?: Template | null) => t?.version === 0

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

function checkGuards(g: unknown, path: string, errs: WorkflowError[], project = false) {
  if (g === undefined) return
  if (!isObj(g)) return void errs.push({ path, message: 'must be an object' })
  checkKeys(g, ['protected', 'merge', ...(project ? ['contributorPrs'] : [])], path, errs)
  if (g.contributorPrs !== undefined && !CONTRIBUTOR_PRS.includes(g.contributorPrs as 'all'))
    errs.push({ path: `${path}.contributorPrs`, message: `must be one of ${CONTRIBUTOR_PRS.join(', ')}` })
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

export function checkPrefs(p: unknown, path: string, errs: WorkflowError[]) {
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
  checkKeys(s.action, ['kind', 'target', 'base', 'method', 'checks', ...WATCH_KEYS], `${path}.action`, errs)
  checkWatch(s.action, s, err)
  if (!isPrMerge(s.action.kind as string)) for (const k of ['method', 'checks']) if (s.action[k] !== undefined) err(`action.${k}`, 'only for github.merge or bitbucket.merge')
  if (s.action.method !== undefined && !MERGE_METHODS.includes(s.action.method as MergeMethod)) err('action.method', `must be one of ${MERGE_METHODS.join(', ')}`)
  if (s.action.checks !== undefined && !(Array.isArray(s.action.checks) && s.action.checks.every(isStr))) err('action.checks', 'must be a list of check names')
  const field = actionField(s.action.kind as ActionKind)
  if (field && s.action[field] !== undefined && !isStr(s.action[field])) err(`action.${field}`, 'must be a branch name')
  if (s.ends !== 'action' && s.ends !== 'user') err('action', 'only for a step that ends with action or user')
}

const WATCH_KEYS = ['source', 'branch', 'workflow', 'command', 'every', 'timeout', 'onFail']
function checkWatch(a: Record<string, unknown>, s: Record<string, unknown>, err: (field: string, message: string) => void) {
  if (a.kind !== 'pipeline.watch') return WATCH_KEYS.forEach(k => a[k] !== undefined && err(`action.${k}`, 'only for pipeline.watch'))
  if (a.source !== undefined && !WATCH_SOURCES.includes(a.source as never)) err('action.source', `must be one of ${WATCH_SOURCES.join(', ')}`)
  if (a.source === 'command' ? !isStr(a.command) : a.command !== undefined) err('action.command', 'is required for source command, and only for it')
  if (a.source === 'command') for (const k of ['branch', 'workflow']) if (a[k] !== undefined) err(`action.${k}`, 'only for source github')
  for (const k of ['branch', 'workflow']) if (a[k] !== undefined && !isStr(a[k])) err(`action.${k}`, 'must be text')
  for (const k of ['every', 'timeout']) if (a[k] !== undefined && !(typeof a[k] === 'string' && DURATION.test(a[k]))) err(`action.${k}`, 'must be a duration like 30s, 5m, 2h or 1d')
  if (a.onFail !== undefined && a.onFail !== 'worker' && a.onFail !== 'user') err('action.onFail', 'must be worker or user')
  if (s.ends !== 'action') err('ends', 'pipeline.watch runs only in a step that ends with action')
  if (s.holder !== undefined && s.holder !== 'none') err('holder', 'the engine watches the pipeline: leave the holder out')
}

// A path inside the worktree, as typed: no glob, no .., not absolute.
const isRelPath = (v: unknown) => isStr(v) && (v as string).length <= 200 && !/^[/~]|[*?[\]\0\n]|(^|\/)\.\.(\/|$)/.test(v as string)
export function checkSetup(w: unknown, errs: WorkflowError[]) {
  if (w === undefined) return
  if (!isObj(w)) return void errs.push({ path: 'worktree', message: 'must be an object' })
  checkKeys(w, SETUP_KEYS, 'worktree', errs)
  for (const k of ['copy', 'share'] as const)
    if (w[k] !== undefined && !(Array.isArray(w[k]) && w[k].length <= 50 && w[k].every(isRelPath))) errs.push({ path: `worktree.${k}`, message: 'must be a list of paths in the repository (no *, no .., not absolute)' })
  if (w.lockfile !== undefined && !isRelPath(w.lockfile)) errs.push({ path: 'worktree.lockfile', message: 'must be a path in the repository' })
  if (w.command !== undefined && typeof w.command !== 'string') errs.push({ path: 'worktree.command', message: 'must be text' })
  if (w.timeout !== undefined && !(typeof w.timeout === 'string' && DURATION.test(w.timeout) && durationSecs(w.timeout) <= 600)) errs.push({ path: 'worktree.timeout', message: 'must be a duration up to 10m, like 5m' })
}
const SECS = { s: 1, m: 60, h: 3600, d: 86400 } as const
export const durationSecs = (d: string) => Number(d.slice(0, -1)) * SECS[d.slice(-1) as keyof typeof SECS]

// Start over: template `source` copied as a project's workflow. The project's
// own guards and worktree setup stay when it already has a workflow (`own`).
export function startOverFrom(source: Template, own: Template | null): Template {
  if (!own) return source
  const { guards: _guards, worktree: _worktree, ...copy } = source
  return { ...copy, ...(own.guards ? { guards: own.guards } : {}), ...(own.worktree ? { worktree: own.worktree } : {}) }
}

// Every problem in a template, each with the path of the field at fault.
export function validateTemplate(t: unknown): WorkflowError[] {
  const errs: WorkflowError[] = []
  if (!isObj(t)) return [{ path: '', message: 'must be an object' }]
  checkKeys(t, ['id', 'version', 'guards', 'instructions', 'prefs', 'worktree', 'steps', 'taskTypes'], '', errs)
  checkSetup(t.worktree, errs)
  if (!isStr(t.id)) errs.push({ path: 'id', message: 'is required' })
  if (t.version !== undefined && !Number.isInteger(t.version)) errs.push({ path: 'version', message: 'must be a whole number' })
  if (t.instructions !== undefined && typeof t.instructions !== 'string') errs.push({ path: 'instructions', message: 'must be text' })
  checkGuards(t.guards, 'guards', errs, true)
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
    checkKeys(tt, ['instructions', 'weight', 'guards', 'prefs', 'childType', 'steps'], path, errs)
    if (tt.weight !== undefined && !isWeight(tt.weight)) errs.push({ path: `${path}.weight`, message: `must be one of ${WEIGHTS.join(', ')}` })
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
    checkFallback(t as unknown as Template, name, shared, errs)
  }
  return errs
}

// A task type's reviewer fallback, as its levels set it: both prefs or none,
// and the reviewer's rules against the worker of that type.
function checkFallback(t: Template, name: string, shared: Record<string, unknown>, errs: WorkflowError[]) {
  const tt = t.taskTypes[name]!
  const steps = Array.isArray(tt.steps) ? tt.steps.map(s => (typeof s === 'string' ? shared[s] : s)) : []
  if (!steps.some(s => isObj(s) && s.holder === 'reviewer')) return
  const own = (k: keyof Prefs) => (isObj(tt.prefs) && isStr(tt.prefs[k]) ? tt.prefs[k] as string : '')
  const pick = (k: keyof Prefs) => own(k) || (isObj(t.prefs) && isStr(t.prefs[k]) ? t.prefs[k] as string : '')
  const at = (k: keyof Prefs) => (own(k) ? `taskTypes.${name}.prefs.${k}` : `prefs.${k}`)
  const agent = pick('reviewFallbackAgent'), model = pick('reviewFallbackModel')
  if (!agent && !model) return
  const add = (path: string, message: string) => { if (!errs.some(e => e.path === path && e.message === message)) errs.push({ path, message }) }
  if (!agent || !model) return add(at(agent ? 'reviewFallbackAgent' : 'reviewFallbackModel'), 'reviewFallbackAgent and reviewFallbackModel go together')
  const worker = { program: pick('agent'), model: pick('model') }
  if (!worker.program || !worker.model) return
  const r = reviewerCheck(worker, agent, model, 'reviewFallbackModel')
  if ('reason' in r) add(at(r.reason.startsWith('The engine') ? 'reviewFallbackAgent' : 'reviewFallbackModel'), `${r.reason} (task type ${name})`)
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
