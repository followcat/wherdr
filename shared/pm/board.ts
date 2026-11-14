// The board, from the step engine's state: a task's column is the column of
// its current step; its live indicator is the herdr-core state of the agent
// that holds that step (none for holder: none); anything waiting for the user
// puts it in Your turn, whatever its step, with a badge saying what to do.
import { actionField, type Holder } from './workflow'
import { caughtUpSettled, stepLabels, waitsToMerge, type PlannedStep, type StepState } from './steps'
import type { Run, SpecNote, Task, WaitKind } from './run'
import { notStarted, type Stopped } from './stop'
import { HANDLE_AFTER_MS, stallOf, stallTurn, type Stall } from './blocked'
import { afterIds, mergeAfterIds } from './advance'
import { GREEN, type Check, type PrInfo } from './actions'
import type { Report } from './report'
import type { WorkReport } from './history'
import { timesOf, type Times } from './times'
import { sameFilesText } from './files'
import { MERGE_REFUSED, ordinal } from './mergeQueue'
import { agentCatchingUp, refusalSaid, turnText, type Told } from './refusal'
import { AGENT_ENDED, retriesAction, waitsShort } from './release'
import { recovering } from './incident'
import { showIds } from './projectKey'
import { questionKey } from './summary'

export type Phase = 'todo' | 'working' | 'done'
export const PHASES: Phase[] = ['todo', 'working', 'done']

export interface Card {
  id: string
  shown: string // the id as the user sees it, with the project's current key (projectKey.ts)
  color?: string // its project's badge color
  project: string
  title: string
  description: string
  specNotes?: SpecNote[] // spec changes after the description, newest last
  column: string // the step's column in its project's view
  phase: Phase // the column in the all-projects view
  step?: string // the current step's id, once started
  holder: Holder
  terminal?: string // herdr-core address of the holder's agent, if it runs
  agents?: { worker?: string, reviewer?: string } // herdr-core address of each role's agent still running (Open the agent)
  yourTurn?: string // the badge
  stall?: Stall // stalled, the machine may still fix it (blocked.ts); past HANDLE_AFTER_MS, also its yourTurn
  userLabel?: string // the button of a step that waits for the user
  tags: string[]
  links: { label: string, url: string }[]
  log: { at: number, by: string, text: string }[] // newest last: tags, links, the coordinator's choices and their reason
  plan: PlannedStep[]
  state?: StepState
  stopped?: Stopped // who stopped it and why: Continue, Take it as it is or Archive
  removable?: true // never started (no agent, worktree or branch): the user may remove it
  after?: string[] // tasks of the same project it starts after
  mergeAfter?: string[] // tasks of its project or workspace its PR merges after
  prNow?: string // its PR as the engine last read it (prNow)
  branch?: string // its working branch, once an agent worked on it
  pr?: { base: string, commits?: number } // its PR's base and commit count, as the engine last read them
  held?: string // waits for memory on its machine
  sameFiles?: string // to do behind this started task, which touches its files (files.ts)
  machine?: string // the machine it went to, named, when its project allows several
  queue?: number // its place in its project's merge queue (mergeQueue.ts)
  queueOut?: string // why it stepped out of the queue's line
  // its agent waits on a question, a permission or a login; a question's whole message and its summary (summary.ts)
  asks?: { kind: WaitKind, text: string, full?: string, tldr?: string }
  report?: Report // a problem the user reported, open (report.ts)
  workReports?: WorkReport[] // the worker's reports as they arrived (Comments, history.ts)
  tldr?: string // what the user needs to decide, in a few lines (summary.ts)
  tldrWaits?: true // a new TL;DR waits for the pace: the notes show instead
  times?: Times // time per step, waits for the user, rounds, CI fixes (times.ts), once started
  archived?: number // when it was archived: off the board, in the Done column's archived list (archive.ts)
}

// A machine a project allows, for "Start on…": unready, the last check's failures ('' ready, none never checked).
export interface BoardMachine { key: string, label: string, online: boolean, unready?: string }
// types: the project's task types, each with its steps in one line ("work → review → merge")
// and the weight its tasks get when none is set ("heavy (screenshots)").
// machines: only for a project that allows more than its own, home first.
// base: the project's working branch, to tell a task that goes elsewhere.
export interface BoardProject { base?: string, key: string, label?: string, aliases?: string[], color?: string, name: string, columns: string[], types: { id: string, plan: string, weight?: string }[], machines?: BoardMachine[] }
// GET /api/pm/board
// archived: each project's count of archived tasks, left out of cards (GET /api/pm/archived lists them).
export interface Board { projects: BoardProject[], cards: Card[], archived?: Record<string, number> }

export const columnOf = (s: PlannedStep) => s.column || s.id

// The columns of a project: those of every task type's steps, in order, once each.
export function boardColumns(plans: PlannedStep[][]): string[] {
  const out: string[] = []
  for (const plan of plans) {
    let at = 0
    for (const c of plan.map(columnOf)) {
      const i = out.indexOf(c)
      if (i < 0) out.splice(at++, 0, c)
      else at = Math.max(at, i + 1)
    }
  }
  return out
}

export function cardOf(task: Task, plan: PlannedStep[], runs: Run[], now = Date.now()): Card {
  const s = task.step
  const started = !!s?.started && !!plan.length
  // Working with no step recorded (started before the engine kept it): its worker's step.
  const running = !started && task.state === 'working'
  const step = started ? plan[s!.at] : running ? plan.find(p => p.holder === 'worker') : undefined
  const holder: Holder = (!s?.done && step?.holder) || (running ? 'worker' : 'none')
  // Each role's latest run that has not ended; the holder's is the card's terminal.
  const live = (role: 'worker' | 'reviewer') => runs.filter(r => r.task === task.id && r.role === role && r.state !== 'ended').sort((a, b) => b.startedAt - a.startedAt)[0]
  const run = holder === 'worker' || holder === 'reviewer' ? live(holder) : undefined
  const worker = live('worker')?.terminal
  const reviewer = live('reviewer')?.terminal
  const stall = stallOf(task, plan, now)
  const branch = runs.filter(r => r.task === task.id && r.role === 'worker').sort((a, b) => b.startedAt - a.startedAt)[0]?.branch
  // A done task (merged, archived) is never the user's turn.
  // In the merge queue, waiting its turn or out of line: a refused merge is the queue's, not the user's.
  const queue = task.queue && !s?.done ? task.queue : undefined
  const queueOut = queue ? task.queueOut : undefined
  // A refused merge out of line is the user's: the engine does not try it again at that commit.
  const queued = (queue ?? 0) > 1 || (!!queueOut && !queueOut.startsWith(MERGE_REFUSED))
  // Just updated with its base: the user's turn waits for GitHub's read of the new commit (prUpdating).
  const settling = !!s?.caughtUp && !caughtUpSettled(s.caughtUp, undefined, now)
  const yourTurn = s?.done ? undefined : ((queued && s?.yourTurn?.reason === 'action') || settling ? undefined : s?.yourTurn?.badge) || (task.state === 'waiting' && !recovering(task) ? task.waiting || 'Waiting' : undefined)
    || (stall && now - stall.since >= HANDLE_AFTER_MS ? stallTurn(stall) : undefined)
    // Work handed to an agent that cannot do it, no coordinator woken for it: the user's.
    || (s?.agent?.waits && s.agent.told === 'user' && !s.done ? s.agent.waits : undefined)
  return {
    id: task.id, shown: task.id, project: task.project, title: task.title, description: task.description,
    ...(task.specNotes?.length ? { specNotes: task.specNotes } : {}),
    column: plan.length ? columnOf((s?.done ? plan.at(-1) : step) ?? plan[0]!) : 'To do',
    phase: s?.done ? 'done' : started || running ? 'working' : 'todo',
    ...(step ? { step: step.id } : {}),
    holder,
    ...(run?.terminal ? { terminal: run.terminal } : {}),
    ...(worker || reviewer ? { agents: { ...(worker ? { worker } : {}), ...(reviewer ? { reviewer } : {}) } } : {}),
    ...(branch ? { branch } : {}),
    ...(task.prBase ? { pr: task.prBase } : {}),
    ...(yourTurn ? { yourTurn } : {}),
    ...(stall ? { stall } : {}),
    ...(queue ? { queue } : {}),
    ...(queueOut ? { queueOut } : {}),
    ...(step?.ends === 'user' && started && !s?.done ? { userLabel: stepLabels(step).button } : {}),
    // A feature's sub-task: its feature's id first.
    tags: [...(task.feature ? [task.feature] : []), ...task.tags ?? []],
    // Then the links steps gave as their proof, labelled 'PR' when a pull request, else by step; each address once.
    links: [...task.links ?? [], ...plan.flatMap((p) => { const url = s?.proofs[p.id]?.link; return url ? [{ label: isPrUrl(url) ? 'PR' : p.id, url }] : [] })]
      .filter((l, i, all) => all.findIndex(x => x.url === l.url) === i),
    log: (task.log ?? []).slice(-30),
    plan,
    ...(s ? { state: s } : {}),
    ...(task.workReports?.length ? { workReports: task.workReports } : {}),
    ...(task.stopped ? { stopped: task.stopped } : {}),
    ...(task.state === 'waiting' && task.waitKind ? { asks: { kind: task.waitKind, text: task.waiting?.split('\n')[0] ?? '', ...askedOf(task) } } : {}),
    // Waiting for the engine to resume it after an incident, or for its agent to start again (watchdog.ts): shown as a wait, not the user's turn.
    ...(task.held && (task.state === 'todo' || task.state === 'working') ? { held: task.held } : recovering(task) ? { held: task.held || task.waiting || 'Waiting' } : {}),
    ...(task.sameFiles && task.state === 'todo' ? { sameFiles: task.sameFiles } : {}),
    ...(task.report ? { report: task.report } : {}),
    ...(task.tldrHeld ? { tldrWaits: true as const } : task.tldr?.text ? { tldr: task.tldr.text } : {}),
    ...(notStarted(task, runs) ? { removable: true as const } : {}),
    ...(task.after ? { after: afterIds(task) } : {}),
    ...(task.mergeAfter ? { mergeAfter: mergeAfterIds(task) } : {}),
    ...(s?.started ? { times: timesOf(task, plan, runs, now) } : {}),
    ...(task.archived ? { archived: task.archived } : {}),
  }
}

// A question's whole message, and its summary while it is the one summarized.
const askedOf = (t: Task) => (t.waitKind !== 'question' || !t.question ? {} : { full: t.question, ...(t.questionTldr?.key === questionKey(t.question) ? { tldr: t.questionTldr.text } : {}) })

// The short action of a card in Your turn, for the sidebar's Tasks to handle.
export function handleLabel(c: Pick<Card, 'stopped' | 'asks' | 'state' | 'stall' | 'userLabel'>): string {
  if (c.stopped) return 'Resume'
  if (c.asks) return 'Answer'
  const r = c.state?.yourTurn?.reason
  if (r === 'user') return c.userLabel || 'Done'
  if (r === 'rounds') return 'Decide'
  if (r === 'action') return 'Retry'
  if (r === 'timeout') return 'Check'
  return c.stall ? 'Unblock' : 'Look'
}

// A task waiting for the user, as the sidebar's Tasks to handle lists it (GET /api/pm/handle).
// project: the task's project (its fixed key); terminal: the agent that asks (a question, a permission, a login), whose conversation a tap opens.
// The card's texts for people with each stored task id in its shown form
// (CP-16 → CMP-16), texts stored before a key change too; its ids stay stored.
export function shownTexts(projects: Parameters<typeof showIds>[0], c: Card): Card {
  const show = <T>(v: T) => showIds(projects, v)
  return {
    ...c, description: show(c.description), ...(c.specNotes ? { specNotes: c.specNotes.map(n => ({ ...n, text: show(n.text) })) } : {}), log: c.log.map(e => ({ ...e, text: show(e.text) })),
    ...(c.yourTurn ? { yourTurn: show(c.yourTurn) } : {}), ...(c.stall ? { stall: { ...c.stall, reason: show(c.stall.reason) } } : {}),
    ...(c.stopped ? { stopped: { ...c.stopped, why: show(c.stopped.why) } } : {}), ...(c.asks ? { asks: { ...c.asks, text: show(c.asks.text) } } : {}),
    ...(c.queueOut ? { queueOut: show(c.queueOut) } : {}), ...(c.held ? { held: show(c.held) } : {}), ...(c.tldr ? { tldr: show(c.tldr) } : {}),
    ...(c.workReports ? { workReports: c.workReports.map(r => ({ ...r, text: show(r.text) })) } : {}),
  }
}

export interface ToHandle { id: string, shown: string, project: string, color?: string, title: string, action: string, label: string, terminal?: string }
export const toHandle = (cards: Card[]): ToHandle[] => cards.filter(c => c.yourTurn).map(taskRow)
// Any task as that row (a `task <ID>` block in a chat, ChatTaskCard.vue): in
// Your turn, what to do and its short action; else where it stands and its column.
export function taskRow(c: Card): ToHandle {
  const turn = c.yourTurn?.split('\n')[0]
  const action = turn ?? (c.stopped ? `Stopped: ${c.stopped.why}` : c.held || c.sameFiles || (c.phase === 'done' ? 'Finished' : c.phase === 'todo' ? 'Not started yet' : c.holder === 'reviewer' ? 'Being reviewed' : 'Being worked on'))
  return { id: c.id, shown: c.shown, project: c.project, ...(c.color ? { color: c.color } : {}), title: c.title, action, label: turn ? handleLabel(c) : c.column, ...(asker(c) ? { terminal: asker(c) } : {}) }
}
// The agent a task waits on, when what it waits for is that agent's question or permission.
export const asker = (c: Pick<Card, 'asks' | 'stopped' | 'terminal'>) => (c.asks && !c.stopped ? c.terminal : undefined)

// The card's one-tap link: its PR when it has one, else its first link.
// A task the user may stop: started, not done, not stopped already.
export const canStop = (c: Pick<Card, 'state' | 'stopped'>) => !!c.state?.started && !c.state.done && !c.stopped

// A task the user may start by hand: to do, not stopped (its sheet resumes it).
// One that waits for others shows them instead (waitsFor).
export const canStart = (c: Pick<Card, 'phase' | 'stopped' | 'state'>) => c.phase === 'todo' && !c.state?.started && !c.stopped

// The tasks a card still waits for: its 'after' ones not done yet (a removed one is not waited for).
export const waitsFor = (c: Pick<Card, 'after'>, cards: Pick<Card, 'id' | 'phase'>[]) =>
  (c.after ?? []).filter(id => cards.some(x => x.id === id && x.phase !== 'done'))

export const mainLink = (c: Pick<Card, 'links'>) => c.links.find(l => /^pr$/i.test(l.label)) ?? c.links[0]
// A pull request's address, whatever its host: GitHub /pull/12, Bitbucket
// /pull-requests/12, GitLab /merge_requests/12, Azure DevOps /pullrequest/12;
// a proof stored with a sentence's period after it ('…/12.') still counts.
const PR_URL = /\/(?:pull|pull-requests|merge_requests|pullrequest)\/(\d+)(?![\w-])/i
const prNumber = (url: string) => PR_URL.exec(url)?.[1]
export const isPrUrl = (url: string) => !!prNumber(url)
// The card's PR: its first link to a pull request.
export const prLink = (c: Pick<Card, 'links'>) => c.links.find(l => isPrUrl(l.url))
// A PR's link reads 'PR #12'; any other keeps its label.
export const linkLabel = (l: { label: string, url: string }) => { const n = prNumber(l.url); return n ? `PR #${n}` : l.label }

// A commit's page on the Git host, read from a PR link of the task (GitHub,
// GitLab, Azure DevOps /commit/<sha>, Bitbucket /commits/<sha>); none without one.
const COMMIT_PATH: Record<string, string> = { 'pull': 'commit', 'pull-requests': 'commits', 'merge_requests': 'commit', 'pullrequest': 'commit' }
export function commitUrl(sha: string, links: { url: string }[]): string | undefined {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return undefined
  for (const l of links) {
    const m = /^(https?:\/\/.+?)\/(pull|pull-requests|merge_requests|pullrequest)\/\d+/i.exec(l.url)
    if (m) return `${m[1]}/${COMMIT_PATH[m[2]!.toLowerCase()]}/${sha}`
  }
  return undefined
}

// The tags of the cards, once each, to filter the board by.
export const boardTags = (cards: Pick<Card, 'tags'>[]) => [...new Set(cards.flatMap(c => c.tags))].sort()

// The columns shown: Your turn first, then the project's columns (or To do /
// Working / Done for all projects). A card in Your turn is in no other column.
// An accepted merge is the engine's (its column: Merging), back in Your turn
// only when the engine cannot go on alone (mergeStuck).
export function boardLanes(cards: Card[], columns: string[] | null): { id: string, cards: Card[] }[] {
  const mine = (c: Card) => (!!turnText(c) || mergeStuck(c) !== undefined) && !prUpdating(c)
  const lane = (c: Card) => (columns ? c.column : c.phase)
  return [
    { id: 'your-turn', cards: cards.filter(mine) },
    ...(columns ?? PHASES).map(id => ({ id, cards: cards.filter(c => !mine(c) && lane(c) === id) })),
  ]
}

// Its PR as the engine reads it every minute: checks first, then what GitHub
// says of the merge. required: the merge step's checks, absent until reported.
export function prNow(pr: (PrInfo & { mergeStateStatus?: string }) | undefined, required: string[] = []): string | undefined {
  if (!pr) return
  if (pr.merged) return 'merged'
  const checks = pr.statusCheckRollup ?? []
  const name = (c: Check) => c.name || c.context || 'a check'
  const running = (c: Check) => (c.status && c.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(c.state ?? '')
  const red = checks.filter(c => !running(c) && !GREEN.includes(c.conclusion || c.state || ''))
  if (red.length) return `checks failed (${red.map(name).join(', ')})`
  const waiting = [...required.filter(n => !checks.some(c => name(c) === n)), ...checks.filter(running).map(name)]
  if (waiting.length) return `waiting for checks (${[...new Set(waiting)].join(', ')})`
  const state = { BLOCKED: 'blocked by the branch rules', DIRTY: 'conflict with its base', BEHIND: 'behind its base' }[pr.mergeStateStatus ?? '']
  return state ?? 'ready to merge'
}

// The checks the task's merge step waits for.
export const requiredChecks = (plan: PlannedStep[]) => plan.flatMap(p => (p.action?.kind === 'github.merge' ? p.action.checks ?? [] : []))

// approved: when the user approved the merge (it merges by itself), said before the text.
export interface CardStatus { text: string, tone: 'wait' | 'bad' | 'ok', at?: number, approved?: number }

// The status line: the approval first (its date on the sheet), then the text and its time.
export function statusText(s: CardStatus, when: (at: number) => string, dated = false): string {
  const approval = s.approved === undefined ? '' : `Approved${dated ? ` on ${when(s.approved)}` : ''}, merges by itself`
  return [approval, s.at ? `${s.text} ${when(s.at)}` : s.text].filter(Boolean).join(' · ')
}
const MERGES = ['github.merge', 'bitbucket.merge', 'git.verify-merged']
const bad = (text: string): CardStatus => ({ text, tone: 'bad' })
// Its checks red at its merge step, as "Checks failed (smoke)"; undefined otherwise.
export function redAtMerge(c: Pick<Card, 'plan' | 'state' | 'prNow' | 'queueOut'>): string | undefined {
  const s = c.state
  if (!s?.started || s.done || c.plan[s.at]?.action?.kind !== 'github.merge') return
  // The engine's last read of the PR decides (a rerun may turn it green while the fix is still handed out); without one, the queue and the handed fix.
  const red = c.prNow ? (c.prNow.startsWith('checks failed') ? c.prNow : undefined)
    : c.queueOut === 'checks failed' || s.agent?.kind === 'ci-to-agent' ? 'checks failed' : undefined
  return red && `C${red.slice(1)}`
}
// A refused action in plain words; waiting, not bad, once the agent took it on.
const refused = (error: string, told?: Told): CardStatus => {
  const said = refusalSaid(error, told)
  return { text: said.short, tone: told ? 'wait' : 'bad' }
}
const ofPr = (pr: string): CardStatus => (pr === 'merged'
  ? { text: 'merged on GitHub', tone: 'ok' }
  : { text: `PR open · ${pr}`, tone: /^(checks failed|blocked|conflict)/.test(pr) ? 'bad' : 'wait' })

// Where a task's PR and merge stand, in one short line: from its step state
// and what the engine last read of its PR. None before a PR, or once stopped.
// A done task merged by a step: 'merged', at the time it was done.
export function cardStatus(c: Pick<Card, 'plan' | 'state' | 'stopped' | 'prNow' | 'held' | 'queue' | 'queueOut' | 'sameFiles'> & { log?: Card['log'] }): CardStatus | undefined {
  const s = c.state
  if (c.held) return { text: c.held, tone: 'wait' }
  if (c.sameFiles) return { text: sameFilesText(c.sameFiles), tone: 'wait' }
  if (!s?.started || c.stopped) return
  if (s.done) {
    const merged = c.plan.some(p => p.action && MERGES.includes(p.action.kind) && s.proofs[p.id] && Object.keys(s.proofs[p.id]!).length)
    return merged ? { text: 'merged', tone: 'ok', ...(s.since ? { at: s.since } : {}) } : undefined
  }
  // Red checks at the merge step: the worker fixes them, or waits to (why); never "merges by itself" meanwhile.
  const red = redAtMerge(c)
  if (red) return !s.agent ? bad(red) : s.agent.waits ? bad(`${red}: waits for its worker, ${waitsShort(s.agent.waits)}`) : { text: `${red}: fixing: the worker is on it`, tone: 'wait' }
  if (s.agent?.waits) return { text: s.agent.waits, tone: 'bad' }
  // In the merge queue: its place in line, or why it stepped out.
  if (c.queueOut) return { text: `in merge queue, out of line: ${c.queueOut}`, tone: c.queueOut === 'checks failed' ? 'bad' : 'wait', ...(s.approved && !s.acting ? { approved: s.approved.at } : {}) }
  const updating = prUpdating(c)
  if (s.agent) return { text: retriesAction(c.plan, s) ? 'the agent is fixing it' : updating ?? 'the agent is updating the PR', tone: 'wait', ...(s.approved ? { approved: s.approved.at } : {}) }
  const kind = c.plan[s.at]?.action?.kind
  const failed = s.yourTurn?.reason === 'action' ? s.yourTurn.error ?? '' : undefined
  if (kind === 'pipeline.watch' && s.acting) return { text: 'watching the pipeline', tone: 'wait' }
  if (kind === 'github.pr') return s.acting ? { text: 'opening the PR', tone: 'wait' } : failed !== undefined ? refused(failed) : undefined
  const opened = c.plan.slice(0, s.at).some(p => p.action?.kind === 'github.pr') ? c.prNow : undefined
  // Mergeable on GitHub, but a review is still ahead (or under way): not ready to merge yet.
  const pr = opened === 'ready to merge' && c.plan.slice(s.at).some(p => p.ends === 'verdict') ? 'review pending' : opened
  const approval = s.approved && !s.acting ? { approved: s.approved.at } : {}
  if (c.queue && !pr?.startsWith('checks failed')) return { text: `${ordinal(c.queue)} in merge queue`, tone: 'wait', ...approval }
  if (failed !== undefined) return pr?.startsWith('checks failed') ? ofPr(pr) : refused(failed, agentCatchingUp(c))
  // A merge waiting for the user, updated with its base; once approved, it merges by itself.
  if (s.catchUp) return { text: `updating with ${s.catchUp.base}`, tone: 'wait', ...approval }
  if (updating) return { text: updating, tone: 'wait', ...approval }
  if (s.approved && !s.acting) return { text: pr && pr !== 'ready to merge' ? pr : '', tone: 'wait', ...approval }
  // The merge runs: it waits for the checks, then merges.
  if (s.acting && kind && MERGES.includes(kind)) return pr && pr !== 'ready to merge' && kind === 'github.merge' ? ofPr(pr) : { text: 'merging', tone: 'wait' }
  return pr ? ofPr(pr) : undefined
}

// Which branch a task's work goes into, for the branch line of its sheet and
// card: its PR's base as the engine last read it, else the branch the next
// step names (the PR's base, the branch it lands on), else the last one the
// plan names, else the project's working branch. pending: its PR is still to open.
export interface BranchLine { head: string, base: string, commits?: number, pending?: true }
export function branchLine(c: Pick<Card, 'branch' | 'pr' | 'plan' | 'state'>, projectBase?: string): BranchLine | undefined {
  if (!c.branch) return
  if (c.pr) return { head: c.branch, base: c.pr.base, ...(c.pr.commits ? { commits: c.pr.commits } : {}) }
  const target = (s: PlannedStep) => { const f = s.action && actionField(s.action.kind); return f ? s.action![f] : undefined }
  const at = c.state?.started && !c.state.done ? c.state.at : c.plan.length
  const step = c.plan.slice(at).find(target) ?? c.plan.slice(0, at).reverse().find(target)
  const base = step ? target(step) : projectBase
  if (!base) return
  return { head: c.branch, base, ...(step?.action?.kind === 'github.pr' && c.plan.indexOf(step) >= at ? { pending: true as const } : {}) }
}

// An approved merge on its way: what it waits for, in a few words (its place
// in the merge queue, its checks, its machine back online…), from the task's
// approval kept on the server. undefined once it merged, failed or was
// refused (the user's turn again), or when no merge was approved.
export function mergeWaits(c: Pick<Card, 'plan' | 'state' | 'stopped' | 'yourTurn' | 'prNow' | 'held' | 'queue' | 'queueOut' | 'sameFiles'>): string | undefined {
  const s = c.state
  if (!s?.approved || s.done || c.stopped || c.yourTurn || !waitsToMerge(c.plan[s.at])) return
  const pr = c.prNow && c.prNow !== 'ready to merge' && c.prNow !== 'merged' ? c.prNow : undefined
  return cardStatus(c)?.text || pr || 'waiting for its turn to merge'
}

// A merge the user may accept now: its review passed, not accepted yet. Whatever
// its PR's state (an update with its base, its worker on a conflict or red
// checks, its worker ended): the engine's work on it never hides Accept.
export function mayAccept(c: Pick<Card, 'plan' | 'state' | 'stopped' | 'userLabel'>): boolean {
  const s = c.state
  return !!c.userLabel && !!s?.started && !s.done && !s.acting && !s.approved && !c.stopped && waitsToMerge(c.plan[s.at])
}

// An approved merge that can go on now: its Merge loading. Not while its checks are red.
export const mergeGoesNow = (c: Parameters<typeof mergeWaits>[0]) => mergeWaits(c) !== undefined && !redAtMerge(c)

// How long an update with the base may run before its conflict counts as stuck.
const CATCH_UP_STUCK_MS = 3 * 60_000

// A merge waiting for the user whose PR the engine or its worker is bringing
// up to date (an update with its base, a conflict or red checks handed to the
// worker, GitHub's read of the updated PR): what goes on, in a few words. Not
// the user's turn meanwhile: off Your turn and Tasks to handle. undefined once
// it needs the user (its worker asks a question or a permission, or waits; a
// stuck update) or the PR is clean. The step's own badge is cleared or held
// back meanwhile (cardOf), so any yourTurn left is a real wait for the user.
export function prUpdating(c: Pick<Card, 'plan' | 'state' | 'stopped'> & Partial<Pick<Card, 'yourTurn' | 'asks'>>, now = Date.now()): string | undefined {
  const s = c.state
  if (!s?.started || s.done || s.acting || c.stopped || c.yourTurn || c.asks || !waitsToMerge(c.plan[s.at])) return
  if (s.agent) return s.agent.waits ? undefined : s.agent.kind === 'catch-up' ? `the worker is solving a conflict with ${s.catchUp?.base ?? 'its base'}` : 'the worker is fixing the PR'
  if (s.catchUp) return now - s.catchUp.at < CATCH_UP_STUCK_MS ? `updating with ${s.catchUp.base}` : undefined
  if (s.caughtUp && !caughtUpSettled(s.caughtUp, undefined, now)) return `updated with ${s.caughtUp.base}, GitHub is checking it`
}

// An approved merge that waits on something the engine cannot do by itself (a
// conflict or red checks no agent is on, its worker ended, its machine down):
// what, in plain words. The user's way out is Start the worker
// (pmMechanic.ts startWorkerFor). undefined: the merge goes on alone. Work
// handed to its worker that waits counts even once it is the user's turn (no
// coordinator took it over: agent.told 'user').
export function mergeStuck(c: Parameters<typeof mergeWaits>[0], now = Date.now()): string | undefined {
  const s = c.state
  const handed = !!s?.agent?.waits && !s.done && !c.stopped && waitsToMerge(c.plan[s.at])
  if (!handed && mergeWaits(c) === undefined) return
  if (s!.agent?.waits === AGENT_ENDED) return 'Its worker ended before finishing what the merge needs. Start it again to finish; the merge then goes on.'
  if (s!.agent?.waits) return `${s!.agent.waits}. Start the worker again to go on with the merge.`
  if (!s || s.agent) return
  if (s.catchUp && now - s.catchUp.at >= CATCH_UP_STUCK_MS) return `Its PR conflicts with ${s.catchUp.base} and no agent is solving it. Start the worker to solve the conflict; the merge then goes on.`
  if (redAtMerge(c)) return 'Its PR\'s checks failed and no agent is fixing them. Start the worker to fix them; the merge then goes on.'
}

// A step the coordinator holds that waits on the user: past its time limit,
// or its rechecks stopped until the user writes (step wait --until-user), or
// the user just asked the coordinator to look (askCoordinator, the log line
// below). For the To do tab's line and its Ask the coordinator button.
// reason: the coordinator's last `step wait` reason at this step; asked: when
// the user asked, while no new time limit or wait came since (the button says Asked).
export const ASKED_COORDINATOR = 'asked the coordinator to check the '
export interface CoordinatorWait { step: string, since: number, reason?: string, asked?: number }
export function coordinatorWait(c: Pick<Card, 'holder' | 'plan' | 'state' | 'log' | 'stopped'>): CoordinatorWait | undefined {
  const s = c.state, step = s?.started && !s.done ? c.plan[s.at] : undefined
  if (c.holder !== 'coordinator' || !step || c.stopped) return
  const since = s!.since ?? 0, log = c.log.filter(e => e.at >= since)
  const asked = log.findLast(e => e.by === 'user' && e.text.startsWith(ASKED_COORDINATOR))?.at
  const over = s!.yourTurn?.reason === 'timeout'
  if (!over && s!.waitUser === undefined && asked === undefined) return
  const reason = log.findLast(e => e.text.startsWith(`${step.id}: next recheck `))?.text.split('. ').slice(1).join('. ')
  const still = asked !== undefined && !over && !((s!.waitUser ?? 0) > asked)
  return { step: step.id, since, ...(reason ? { reason } : {}), ...(still ? { asked } : {}) }
}
