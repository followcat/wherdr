// Tasks and the agent runs that work on them. A run's terminal carries
// wherdr.* labels on herdr-core, so the engine finds it again after a restart.
import type { Project } from './project'
import type { Prefs, Step, Template } from './workflow'
import type { StepState } from './steps'
import { needsShots, shotMode } from './shots'

export interface Task {
  id: string // <project key>-<n>
  project: string
  title: string
  description: string
  type: string // a task type of the project's template
  state: 'todo' | 'working' | 'waiting'
  waiting?: string // why it waits for the user
  waitKind?: 'question' | 'permission' | 'auth' // what it waits for
  mech?: Record<string, number> // the engine's mechanical moves made (key → when): never twice
  run?: string // the current run
  step?: StepState // where the step engine has it
  prefs?: Prefs
  tags?: string[] // short texts, shown on the card
  links?: { label: string, url: string }[] // the PR, the ticket…
  shotToken?: string // the agent's key for POST /api/pm/shot (never sent to the browser)
  log?: TaskLogEntry[] // who changed what, newest last
  createdAt: number
}

// A task as the browser gets it: the agent's screenshot key stays on the server.
export const publicTask = ({ shotToken: _, ...t }: Task): Task => t

export interface TaskLogEntry { at: number, by: string, text: string }

export interface Run {
  id: string
  task: string
  role: 'worker' | 'reviewer'
  program: string // claude or codex
  model: string // pinned at launch
  machine: string // herdr-core machine key, '' = the wherdr host
  worktree: string
  branch: string
  instructions: string // file the agent reads first
  terminal?: string // herdr-core address, once started
  attempt: number // 1, or 2 after an agent that exited at once
  state: 'starting' | 'running' | 'ended'
  endedBy?: 'exit' | 'lost'
  startedAt: number
}

export const LABEL = { install: 'wherdr.install', task: 'wherdr.task', run: 'wherdr.run', role: 'wherdr.role', report: 'wherdr.report' } as const

export type WaitKind = NonNullable<Task['waitKind']>
// What a running agent waits for: its wherdr.report label (blocked:<kind>),
// else herdr-core's 'blocked' status, a tool's permission prompt.
export function waitOf(t: { labels?: Record<string, string>, status?: string | { state?: string } | null } | null | undefined): WaitKind | undefined {
  const m = /^blocked:(question|permission|auth)$/.exec(t?.labels?.[LABEL.report] ?? '')
  if (m) return m[1] as WaitKind
  const s = typeof t?.status === 'string' ? t.status : t?.status?.state
  if (s === 'blocked') return 'permission'
}
// An agent that stopped because it is not logged in.
export const isAuthFailure = (text: string) => /not logged in|log ?in again|please (run )?\/?login|authenticat|unauthori[sz]ed|invalid api key|\b401\b/i.test(text)
// Agents the engine knows how to start with a pinned model and a first message.
export const PROGRAMS = ['claude', 'codex'] as const
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,63}$/

export const runLabels = (install: string, run: Run) =>
  ({ [LABEL.install]: install, [LABEL.task]: run.task, [LABEL.run]: run.id, [LABEL.role]: run.role })

// Where a task works on its machine, under that machine's home.
export const taskPaths = (home: string, id: string) => ({
  worktree: `${home}/.wherdr/pm/worktrees/${id}`,
  instructions: `${home}/.wherdr/pm/tasks/${id}/instructions.md`,
  branch: `task/${id}`,
})

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
// The shell line that starts the agent: model pinned, first message points at the file.
export function agentLine(program: string, model: string, instructions: string) {
  return ['exec', program, '--model', model, `Read ${instructions} and follow it.`].map((s, i) => (i < 2 ? s : quote(s))).join(' ')
}

const typeSteps = (t: Template, type: string): Step[] =>
  (t.taskTypes[type]?.steps ?? []).map(s => (typeof s === 'string' ? t.steps?.[s] : s)).filter((s): s is Step => !!s)

// Program and model of the worker: the nearest level wins (task, task type,
// template). Returns the reason when the task cannot start.
export function workerPlan(t: Template, task: Task): { program: string, model: string } | { reason: string } {
  const tt = t.taskTypes[task.type]
  if (!tt) return { reason: `The template has no task type "${task.type}"` }
  if (!typeSteps(t, task.type).some(s => s.holder === 'worker')) return { reason: `Task type "${task.type}" has no worker step` }
  const pick = (k: 'agent' | 'model') => task.prefs?.[k] || tt.prefs?.[k] || t.prefs?.[k] || ''
  const program = pick('agent'), model = pick('model')
  if (!(PROGRAMS as readonly string[]).includes(program)) return { reason: program ? `The engine cannot start "${program}": claude or codex` : 'No agent set: add prefs.agent to the template' }
  if (!MODEL_RE.test(model)) return { reason: model ? `Invalid model "${model}"` : 'No model set: add prefs.model to the template (the model is always pinned)' }
  return { program, model }
}

// Program and model of the reviewer: reviewAgent and reviewModel, nearest
// level first. The reviewer is always of another model than the worker.
export function reviewerPlan(t: Template, task: Task): { program: string, model: string } | { reason: string } {
  const worker = workerPlan(t, task)
  if ('reason' in worker) return worker
  if (!typeSteps(t, task.type).some(s => s.holder === 'reviewer')) return { reason: `Task type "${task.type}" has no reviewer step` }
  const tt = t.taskTypes[task.type]
  const pick = (k: 'reviewAgent' | 'reviewModel') => task.prefs?.[k] || tt?.prefs?.[k] || t.prefs?.[k] || ''
  const program = pick('reviewAgent') || worker.program, model = pick('reviewModel')
  if (!(PROGRAMS as readonly string[]).includes(program)) return { reason: `The engine cannot start "${program}": claude or codex` }
  if (!MODEL_RE.test(model)) return { reason: model ? `Invalid review model "${model}"` : 'No review model set: add prefs.reviewModel to the template' }
  if (model === worker.model) return { reason: `The reviewer must use another model than the worker (${model})` }
  return { program, model }
}

// The worker's step that asks for screenshots, if any.
export const shotStep = (t: Template, type: string) => typeSteps(t, type).find(s => s.holder === 'worker' && needsShots(s))

// How the worker gives its screenshots: one ready command per image, to wherdr
// at `base`, with the task's key (no browser, no passkey session needed).
export function shotsSection(step: Step, task: Pick<Task, 'id'>, shots: { base: string, token: string }) {
  const both = shotMode(step) === 'before-after'
  const url = (phase: string) => `${shots.base.replace(/\/+$/, '')}/api/pm/shot?task=${task.id}&phase=${phase}`
  const cmd = (phase: string) => `curl -fsS -X POST -H 'Content-Type: image/png' -H 'X-Wherdr-Shot-Token: ${shots.token}' --data-binary @shot.png '${url(phase)}'`
  return [
    '## Screenshots', '',
    both
      ? 'Step "' + step.id + '" needs screenshots before and after your change: take the before ones first, on the unchanged code, then the same screens after.'
      : 'Step "' + step.id + '" needs screenshots of the result.',
    'Upload each one (PNG, JPEG or WebP, 10 MB max; set Content-Type to match) with:', '',
    ...(both ? ['    ' + cmd('before')] : []), '    ' + cmd('after'), '',
  ]
}

// The instructions file: the task, then every level's instructions, broadest
// first, then how to upload screenshots when a worker step asks for them.
export function instructionsText(p: Project, t: Template, task: Task, run: Pick<Run, 'worktree' | 'branch'>, shots?: { base: string, token: string }) {
  const step = typeSteps(t, task.type).find(s => s.holder === 'worker')
  const parts = [t.instructions, t.taskTypes[task.type]?.instructions, step?.instructions].map(s => s?.trim()).filter(Boolean)
  const visual = shotStep(t, task.type)
  return [
    `# ${task.id}: ${task.title}`, '', task.description.trim() || '(no description)', '',
    '## Instructions', '', ...(parts.length ? parts : ['(none)']), '',
    ...(visual && shots ? shotsSection(visual, task, shots) : []),
    `You work in ${run.worktree} on branch ${run.branch} of project ${p.name}.`, '',
  ].join('\n')
}

export interface LabelledTerminal { address: string, labels?: Record<string, string>, state?: string }
export type Found = { run: Run, terminal: string, state: 'running' } | { run: Run, state: 'exit' | 'lost' }

// After a restart: each unfinished run finds its terminal by its labels. A run
// still 'starting' may have started before the restart: its labels tell.
export function reconcile(runs: Run[], terminals: LabelledTerminal[], install: string): Found[] {
  return runs.filter(r => r.state !== 'ended').map((run): Found => {
    const t = terminals.find(x => x.labels?.[LABEL.install] === install && x.labels?.[LABEL.run] === run.id)
    if (!t) return { run, state: 'lost' }
    return t.state === 'finished' ? { run, state: 'exit' } : { run, terminal: t.address, state: 'running' }
  })
}
