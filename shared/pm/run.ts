// Tasks and the agent runs that work on them. A run's terminal carries
// wherdr.* labels on herdr-core, so the engine finds it again after a restart.
import type { Project } from './project'
import { MODEL_RE, PROGRAMS, reviewerCheck, type Prefs, type Step, type Template, type Weight } from './workflow'
import { fillBase, planSteps, type StepState } from './steps'
import { needsShots, shotMode } from './shots'
import type { Stopped } from './stop'
import type { Report } from './report'
import type { TaskTldr } from './summary'
import type { WorkReport } from './history'
import type { Mark } from './times'
import type { Sentinel } from './sentinel'
import { isPublic, publicWorkerSection } from './visibility'
import { CODEX_NO_UPDATE } from '../codexLaunch'
import type { Recovery } from './incident'
import { uiGuide } from './uiGuide'

// Who made a task: the user (the board, their turn), the coordinator in a
// wake, an automation, a mission.
export type TaskOrigin = 'user' | 'coordinator' | 'automation' | 'mission'

export interface Task {
  id: string // <project key>-<n>
  project: string
  title: string
  description: string
  type: string // a task type of the project's template
  state: 'todo' | 'working' | 'waiting'
  waiting?: string // why it waits for the user
  waitKind?: 'question' | 'permission' | 'auth' // what it waits for
  answered?: number // when a coordinator's tell answered its question; cleared once the agent's question is gone (no second wake: autopilot.ts)
  mech?: Record<string, number> // the engine's mechanical moves made (key → when): never twice
  ci?: { head: string, red: boolean, running?: true } // its PR's CI at the task's commit, as the engine last read it
  prBase?: { base: string, commits?: number } // its PR's base and commit count, as the engine last read them: kept once done
  queue?: number // its place in its project's merge queue (mergeQueue.ts), 1: merging now
  queueOut?: string // why it stepped out of the queue's line (a conflict, its checks, its agent's work)
  order?: number // its place on the board, set by the coordinator's `task order` (boardOrder.ts): lower first
  idle?: number // since when the agent holding its step sits idle, its report still due (blocked.ts)
  stall?: { cause: string, reason: string, since: number } // its stall as the engine last saw it (blocked.ts)
  stalls?: Record<string, { since: number, nudged?: number, restarted?: number, handled?: number, back?: number }> // each cause seen: when it began, its one nudge, restart and hand-over, when its agent went back to work
  selfFix?: { step: string, block: string, tried: string[], at: number, woke?: number } // the engine's tries on a block in this step (selfFix.ts)
  fixes?: { step: string, n: number } // mechanical fixes the coordinator's wakes made in this step (tell --fix)
  run?: string // the current run
  weight?: Weight // light, standard or heavy, set by the user or the coordinator (weight.ts); else from its type
  machine?: string // where its first start put it: it always goes back there (none, once started: its project's machine)
  step?: StepState // where the step engine has it
  base?: string // the project's working branch when it started ('' none): a later change leaves it alone
  branch?: string // its branch, named at its first start (branchName.ts), or the one its worker said it pushed
  branchStart?: string // the branch its worktree was made on (none: task/<id>)
  fromBranch?: string // a branch to continue (a v2 task's): its first start takes it when the remote still has it, else starts from the base
  prefs?: Prefs
  tags?: string[] // short texts, shown on the card
  links?: { label: string, url: string }[] // the PR, the ticket…
  shotToken?: string // the agent's key for POST /api/pm/shot (never sent to the browser)
  log?: TaskLogEntry[] // who changed what, newest last
  specNotes?: SpecNote[] // spec changes added after its description (task note, tell --spec), newest last
  specPass?: { at: number, step: string, reason: string } // the coordinator's last pass on a spec change, shown in Decisions for a day
  marks?: Mark[] // when its step or turn changed, added by the store (times.ts)
  after?: string // tasks of the same project or workspace, comma-separated: this one starts once they are done
  mergeAfter?: string // tasks of the same project or workspace, comma-separated: its PR merges once they are done (mergeQueue.ts)
  kind?: 'feature' // a workspace's task: it runs no agent (feature.ts)
  feature?: string // the feature this sub-task of a member belongs to (its <WS-n>)
  plan?: { order: string } // a feature's split: the coordinator's one-line reason for its order
  closed?: { at: number, by: string, reason?: string } // a feature its coordinator closed: done
  stopped?: Stopped // who stopped it and why (stop.ts): it waits for the user
  autopilot?: true // started or added by the coordinator in a wake: its autopilot's own
  auto?: string // the automation that added it
  origin?: TaskOrigin // who made it: only automatic work is held by the pace (pace.ts)
  addedBy?: string // who added it: 'user', 'automation', or a coordinator's key (MAIN for the main one)
  held?: string // an automatic start waits for memory on its machine (memory.ts): the engine starts it once memory is back
  machineWait?: string // the engine's start found this machine (key) unreachable: held, it starts once a machine that fits is back (startHeld, startChained)
  sentinel?: Sentinel // the liveness sentinel's tries at its current step (sentinel.ts)
  reviewWait?: string // the reviewer account its review waits on, in that account's queue (reviewQueue.ts)
  files?: string[] // the files or folders it plans to change (files.ts)
  changed?: string[] // what it changed since its branch started, as the engine last read it
  sameFiles?: string // the started task its start waits behind: same files (files.ts)
  cleanup?: { done?: true, skipped?: string } // its worktree removed, or why it stays (cleanup.ts)
  report?: Report // a problem the user reported, open until the coordinator acts (report.ts)
  // Its own commits since its fork from the base (author time and subject, so a
  // rebase or a merge of the base keeps it) and the files they change, read at each report or verdict.
  // reviewed: the commits a verdict last read (a later report on the same ones changes nothing).
  work?: { commits: string, files: { path: string, add: number, del: number }[], reviewed?: string }
  workReports?: WorkReport[] // the worker's reports, each as it arrived, newest last (history.ts)
  tldr?: TaskTldr // a cheap model's few lines for the user to decide, per significant change (summary.ts)
  tldrHeld?: true // a new one waits for the pace of the Claude account
  question?: string // its agent's last message while it waits on a question, whole (Markdown)
  questionTldr?: TaskTldr // that question in a few plain lines, per question (summary.ts)
  recovery?: Recovery // its agent gone with an incident: the engine resumes it (recovery.ts)
  archived?: number // when the engine archived it, done for its project's delay: off the board (archive.ts)
  unarchived?: number // when the user brought it back to Done: its delay runs again from then
  createdAt: number
}

// A task as the browser gets it: the agent's screenshot key stays on the server.
export const publicTask = ({ shotToken: _, ...t }: Task): Task => t

// A PR's address without what follows its number (/files, a slash, an anchor), to compare two.
export const prUrl = (u: string) => /^(.*\/pull\/\d+)(?:[/?#].*)?$/.exec(u)?.[1]
// Of a branch's PRs, the one the task links (another may be open on the same branch).
export const linkedPr = <P extends { url: string }>(prs: P[], link: string | undefined) => (link ? prs.find(x => prUrl(x.url) === link) : undefined)
// A task's PR, when a step or its worker linked one (a worker's report, the PR step's proof): the last linked.
export const prLink = (t: Pick<Task, 'links' | 'step'>) =>
  [...(t.links ?? []).map(l => l.url), ...Object.values(t.step?.proofs ?? {}).map(p => p?.link ?? '')].map(prUrl).filter(Boolean).at(-1)

export interface TaskLogEntry { at: number, by: string, text: string }
export type SpecNote = TaskLogEntry

// The rule the worker and the reviewer follow when the spec changed.
export const SPEC_RULE = 'The latest note overrides the description where they disagree.'
// The task's description, then its spec changes, newest last, as the worker's
// and the reviewer's instructions give them.
export function specText(task: Pick<Task, 'description' | 'specNotes'>) {
  const notes = task.specNotes ?? []
  return [task.description.trim() || '(no description)', ...(notes.length
    ? ['', '## Spec changes', '', SPEC_RULE, '', ...notes.map(n => `- Spec change (${new Date(n.at).toISOString().slice(0, 10)}): ${n.text}`)]
    : [])].join('\n')
}

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
  endedBy?: 'exit' | 'lost' | 'stopped' | 'released' // released: idle while its task waited for the user (release.ts)
  startedAt: number
  peakMb?: number // the most its worktree's processes took, sampled each tick (peaks.ts)
  session?: string // Claude's conversation id, pinned at launch: a resume takes it up again
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
// The folder trust dialog (Claude's or Codex's) on a folder wherdr made itself
// (a task's worktree, a coordinator's or Alfred's folder): the keys that pick
// its "trust" option from where the cursor is, then confirm; none for any other screen.
const TRUST_OPTION = /^\s*(?:[❯›>]\s*)?(?:\d+\.\s+)?(Yes, I trust this folder|Yes, proceed|Yes, continue|Trust and continue|No, exit|No, quit|Back to\b)/
export function trustKeys(screen: string, folder: string): string[] | undefined {
  // The folder exactly: alone on its line (Claude, Codex's folder access) or
  // Codex's "You are in <folder>"; never a longer path, nor one with spaces ending in it.
  const named = screen.split('\n').some(l => { const t = l.trim(); return t === folder || /^[>›]?\s*You are in$/.test(t.slice(0, -folder.length).trimEnd()) && t.endsWith(` ${folder}`) })
  if (!/trust/i.test(screen) || !named) return undefined
  const options = screen.split('\n').filter(l => TRUST_OPTION.test(l))
  const yes = options.findIndex(l => !/^(No|Back)\b/.test(TRUST_OPTION.exec(l)![1]!))
  if (yes < 0 || options.length < 2) return undefined
  const at = Math.max(0, options.findIndex(l => /^\s*[❯›>]/.test(l)))
  return [...Array<string>(Math.abs(yes - at)).fill(yes > at ? 'down' : 'up'), 'enter']
}
// An agent that stopped because it is not logged in.
export const isAuthFailure = (text: string) => /not logged in|log ?in again|please (run )?\/?login|authenticat|unauthori[sz]ed|invalid api key|\b401\b/i.test(text)
export { PROGRAMS, SAME_MODEL } from './workflow'

export const runLabels = (install: string, run: Run) =>
  ({ [LABEL.install]: install, [LABEL.task]: run.task, [LABEL.run]: run.id, [LABEL.role]: run.role })

// Where a task works on its machine, under that machine's home.
export const taskPaths = (home: string, id: string, branch = `task/${id}`) => ({
  worktree: `${home}/.wherdr/pm/worktrees/${id}`,
  instructions: `${home}/.wherdr/pm/tasks/${id}/instructions.md`,
  branch,
})

// A task's agents keep their temporary files in its worktree, not in the
// machine's /tmp (often small, in memory, and shared by every agent): ignored
// by git, removed with the worktree, kept when the agents are released.
export const TMP_DIR = '.wherdr-tmp'
export const agentEnv = (worktree: string) => {
  const tmp = `${worktree}/${TMP_DIR}`
  return { DISABLE_AUTOUPDATER: '1', TMPDIR: tmp, CLAUDE_CODE_TMPDIR: tmp, NODE_COMPILE_CACHE: tmp }
}
// Below this, the machine's /tmp would make the agent's shell commands fail.
export const MIN_TMP_FREE_KB = 500 * 1024
// The temp folder script's output: the KB free in /tmp. Unknown: no refusal.
export function tmpRefusal(out: string) {
  const kb = Number(out.trim().split('\n').pop())
  if (!out.trim() || !Number.isFinite(kb) || kb >= MIN_TMP_FREE_KB) return undefined
  return `/tmp on the task's machine has only ${Math.floor(kb / 1024)} MB free (needs ${MIN_TMP_FREE_KB / 1024} MB): free some space, then start the task again`
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
// The shell line that starts the agent: model pinned, first message points at the file.
// session (Claude only): the conversation's id, new (--session-id), or taken
// up again (--resume) with `resume` as its first message.
export function agentLine(program: string, model: string, instructions: string, session?: { id: string, resume?: string }) {
  const own = program === 'claude' && session ? (session.resume ? ['--resume', session.id] : ['--session-id', session.id]) : []
  const first = own[0] === '--resume' ? session!.resume! : `Read ${instructions} and follow it.`
  return ['exec', program, ...(program === 'codex' ? CODEX_NO_UPDATE : []), '--model', model, ...own, first].map((s, i) => (i < 2 ? s : quote(s))).join(' ')
}

// A task's working branch: the one it started with, else its project's now.
export const taskBase = (task: Pick<Task, 'base'>, p?: Pick<Project, 'base'>) =>
  (task.base !== undefined ? task.base : p?.base) || undefined

// A task's planned steps, with its working branch.
export const taskPlan = (t: Template, task: Pick<Task, 'type' | 'prefs' | 'base'>, p?: Pick<Project, 'base'>) =>
  planSteps(t, { type: task.type, ...(task.prefs ? { prefs: task.prefs } : {}) }, taskBase(task, p))

export const typeSteps = (t: Template, type: string): Step[] =>
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
// level first. The reviewer is of another model than the worker, unless the
// template says reviewModel "same": a fresh session of the worker's model.
// out: why the review agent cannot take this review now (its account at its
// limit). With reviewFallbackAgent and reviewFallbackModel set, the fallback
// takes it (`switched` says why); without, nothing changes.
export function reviewerPlan(t: Template, task: Task, out?: string): { program: string, model: string, switched?: string } | { reason: string } {
  const worker = workerPlan(t, task)
  if ('reason' in worker) return worker
  if (!typeSteps(t, task.type).some(s => s.holder === 'reviewer')) return { reason: `Task type "${task.type}" has no reviewer step` }
  const pick = (k: keyof Prefs) => prefOf(t, task, k)
  const main = reviewerCheck(worker, pick('reviewAgent') || worker.program, pick('reviewModel'), 'reviewModel')
  const agent = pick('reviewFallbackAgent'), model = pick('reviewFallbackModel')
  if (!out || (!agent && !model) || 'reason' in main) return main
  if (!agent || !model) return { reason: 'reviewFallbackAgent and reviewFallbackModel go together' }
  const fallback = reviewerCheck(worker, agent, model, 'reviewFallbackModel')
  return 'reason' in fallback ? fallback : { ...fallback, switched: out }
}

// A pref of a task: the nearest level that sets it (task, task type, template).
export const prefOf = (t: Template, task: Pick<Task, 'type' | 'prefs'>, k: keyof Prefs) =>
  task.prefs?.[k] || t.taskTypes[task.type]?.prefs?.[k] || t.prefs?.[k] || ''

// Why the review agent cannot take a review: its account at its limit until `until` (local time).
export const programName = (program: string) => `${program.charAt(0).toUpperCase()}${program.slice(1)}`
export const quotaOut = (program: string, until: number) => `${programName(program)} out of quota until ${new Date(until).toTimeString().slice(0, 5)}`

// The last reviewer start in a task's log, when the fallback took it: why, and by whom.
export function reviewSwitch(log: { text: string }[]) {
  const last = [...log].reverse().find(e => /^review: (started the reviewer|.+, reviewed by )/.test(e.text))
  return last && !last.text.startsWith('review: started') ? last.text.slice('review: '.length) : undefined
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
// first, then how to upload screenshots when a worker step asks for them, then
// a public repository's rule (leakCheck: its own check, see ownLeakCheck).
export function instructionsText(p: Project, t: Template, task: Task, run: Pick<Run, 'worktree' | 'branch'>, shots?: { base: string, token: string }, leakCheck?: string) {
  const step = typeSteps(t, task.type).find(s => s.holder === 'worker')
  const parts = [t.instructions, t.taskTypes[task.type]?.instructions, step?.instructions].map(s => s?.trim()).filter(Boolean).map(s => fillBase(s!, taskBase(task, p)))
  const visual = shotStep(t, task.type)
  return [
    `# ${task.id}: ${task.title}`, '', specText(task), '',
    '## Instructions', '', ...(parts.length ? parts : ['(none)']), '',
    ...(visual && shots ? shotsSection(visual, task, shots) : []),
    ...uiGuide('task', { key: p.key }),
    ...(isPublic(p) ? publicWorkerSection(leakCheck) : []),
    `You work in ${run.worktree} on branch ${run.branch} of project ${p.name}. If you push your work to another branch, add a line \`Branch: <its name>\` to your note: the engine then follows that branch.`, '',
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

// Two live agents of one role on a task (two starts that raced): the one the
// engine tracks stays (the task's run, else its newest unended run), the others end.
export function duplicateAgents(terminals: LabelledTerminal[], runs: Run[], tasks: Pick<Task, 'id' | 'run'>[], install: string) {
  const groups = new Map<string, LabelledTerminal[]>()
  for (const x of terminals) {
    const l = x.labels
    if (x.state === 'finished' || l?.[LABEL.install] !== install || !l[LABEL.task] || !l[LABEL.role]) continue
    const k = `${l[LABEL.task]}\u0000${l[LABEL.role]}`
    groups.set(k, [...(groups.get(k) ?? []), x])
  }
  return [...groups.values()].filter(g => g.length > 1).map(g => {
    const task = g[0]!.labels![LABEL.task]!, role = g[0]!.labels![LABEL.role]! as Run['role']
    const tracked = tasks.find(t => t.id === task)?.run
    const rank = (x: LabelledTerminal) => {
      const id = x.labels![LABEL.run]
      if (id === tracked) return Infinity
      return runs.find(r => r.id === id && r.state !== 'ended')?.startedAt ?? -1
    }
    const keep = g.reduce((a, b) => (rank(b) > rank(a) ? b : a))
    return { task, role, keep, end: g.filter(x => x !== keep) }
  })
}
