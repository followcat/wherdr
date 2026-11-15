// `wherdr pm ui action resume|step|open <task>`: an agent puts a button in its
// reply; only the user's click acts (POST /api/ui/act, server/utils/uiActions.ts),
// through the same handlers as the task sheet. The list of actions is closed.
// Pure: the card, its stamp (what must still hold at the click) and its block.
import type { Task } from './pm/run'
import { stepLabels, type PlannedStep } from './pm/steps'
import type { SyncedSetting } from './settings'
import type { UiTargetId } from './uiTargets'

export const UI_ACTIONS = ['resume', 'step', 'open'] as const
export type UiAction = typeof UI_ACTIONS[number]
export const isUiAction = (v: unknown): v is UiAction => (UI_ACTIONS as readonly unknown[]).includes(v)

// open: waits for a click; done: the click ran it; dismissed: the user's
// Cancel; stale: what it was for has changed (or 24 h passed); the card then
// runs nothing.
export type UiCardState = 'open' | 'done' | 'dismissed' | 'stale'
// A proposed setting change (`wherdr alfred setting set … --propose`): before
// (undefined: the default) → after, and the user's message behind it.
// target: the element "Show me" highlights (shared/uiTargets.ts), if it has one.
export interface SettingChange { key: SyncedSetting, before?: string, after: string, said?: string, target?: UiTargetId }
// A proposed project change (`wherdr alfred project add|template|guards|machine
// …` or `coordinator start … --propose`): the command the click runs, the
// lines its dry run showed (the click runs it only while they still hold), the
// project, and the part of its sheet "Show me" highlights.
// picks (several projects in one card, `v2 import`): the key each line adds,
// null when it cannot be added (the line says why); each a checkbox, on by
// default, or only those of `on` (the command's --only). start: the "Start
// their coordinators" checkbox's default (the command's --start). pm: project
// management was off when it was proposed: a "Turn on project management"
// checkbox (on), switched on by the Apply before the change.
export interface ProjectChange { argv: string[], lines: string[], project: string, said?: string, target?: UiTargetId, picks?: (string | null)[], on?: string[], start?: boolean, pm?: true }
// The user's checkboxes at the click: the keys to add, whether to start their coordinators and to turn project management on.
export interface CardChoice { picks: string[], start: boolean, pm: boolean }
export function cardChoice(body: { picks?: unknown, start?: unknown, pm?: unknown }): CardChoice | undefined {
  if (!Array.isArray(body.picks)) return undefined
  return { picks: body.picks.filter((k): k is string => typeof k === 'string' && /^[A-Z][A-Z0-9]{1,9}$/.test(k)), start: body.start !== false, pm: body.pm !== false }
}
// The checkboxes as the card first shows them, and the choice of an Apply that sends none.
export const defaultChoice = (c: Pick<ProjectChange, 'picks' | 'on' | 'start'>): CardChoice =>
  ({ picks: (c.picks ?? []).filter((k): k is string => !!k && (!c.on || c.on.includes(k))), start: c.start !== false, pm: true })
// With the user's choice, the command the click runs (its argv holds no --only nor --start).
export const choiceArgv = (argv: string[], c?: CardChoice) => (c ? [...argv, '--only', c.picks.join(','), '--start', c.start ? 'yes' : 'no'] : argv)
export interface UiCard {
  id: string, by: string, at: number, kind: UiAction | 'setting' | 'change', task: string, shown: string
  label: string, stamp: string, state: UiCardState, outcome?: { text: string, at: number, lines?: string[] } // lines: per project (v2 import)
  setting?: SettingChange // kind 'setting' only (task and shown are '')
  change?: ProjectChange // kind 'change' only (task and shown are '')
  refused?: string // the click's answer only, never stored: why the step's action was refused
}
export const UI_CARD_MS = 24 * 3600_000
export const UI_CARDS_MAX = 20

// What must still hold at the click, the same thing Decisions keys on: the same
// stop (resume), the same user step entered at the same time (step). null: the
// action has nothing to act on now. open always holds.
export function actionStamp(kind: UiAction, task: Task, plan: PlannedStep[]): string | null {
  if (kind === 'open') return `open:${task.id}`
  if (kind === 'resume') return task.stopped ? `stopped:${task.id}:${task.stopped.at}` : null
  const s = task.step, step = s ? plan[s.at] : undefined
  if (task.stopped || !s?.started || s.done || step?.ends !== 'user') return null
  return `step:${task.id}:${step.id}:${s.since ?? 0}`
}

// Why the agent may not add it now: the task's state says what each action needs.
export function actionRefusal(kind: UiAction, stamp: string | null, shown: string): string | null {
  if (stamp) return null
  return kind === 'resume' ? `${shown} is not stopped: nothing to resume` : `${shown} does not wait on a step of the user's: no button to give`
}

// The button: the step's own label ("Merge", "Approve screenshots").
export function actionLabel(kind: UiAction, shown: string, plan: PlannedStep[], task: Task): string {
  if (kind === 'resume') return `Resume ${shown}`
  if (kind === 'open') return `Open ${shown}`
  const step = plan[task.step?.at ?? -1]
  return step ? stepLabels(step).button : 'Done'
}

// The card as the click finds it: stale once its stamp no longer holds or it is
// over a day old. stampNow: the task's stamp now (null: gone or nothing to act on).
export function cardNow(card: UiCard, stampNow: string | null, now: number): UiCard {
  if (card.state !== 'open') return card
  return stampNow !== card.stamp || now - card.at > UI_CARD_MS ? { ...card, state: 'stale' } : card
}

// after: the task the handler returned, still on the step the card was for
// (its stamp unchanged). A merge the click approved (or put in the queue) has
// not merged yet: the engine merges it once the PR is ready (board.ts mergeWaits).
export function outcomeText(card: Pick<UiCard, 'kind' | 'label'>, after?: Pick<Task, 'queue' | 'step'>): string {
  if (card.kind === 'resume') return 'Resumed by you'
  const waits = !!after?.step && !after.step.done && (!!after.step.approved || !!after.queue)
  return waits ? `${card.label}: approved by you, merges once ready` : `${card.label}: done by you`
}

// What the user did with a card, told to the agent that put it in its reply
// (server/utils/cardOutcome.ts): marked so the chat shows it as from the card.
export const CARD_NOTE = 'From the card: '
export const cardNote = (outcome: string) => `${CARD_NOTE}${outcome}`
export const cardNoteOf = (text: string) => (text.startsWith(CARD_NOTE) ? text.slice(CARD_NOTE.length) : null)
// Applied / Cancelled / Not applied, with the card's one-line summary.
export function cardOutcome(card: Pick<UiCard, 'kind' | 'label' | 'setting' | 'state' | 'outcome'>, refused?: string) {
  const what = card.setting ? `${card.label} (${card.setting.before ?? 'default'} → ${card.setting.after})` : card.label
  if (refused) return `Not applied: ${what}: ${refused}`
  if (card.state === 'stale') return `Not applied: ${what}: this changed since, nothing was applied`
  return `${card.state === 'dismissed' ? 'Cancelled' : 'Applied'}: ${what}${card.outcome?.lines?.length ? `: ${card.outcome.lines.join('; ')}` : ''}`
}

// A setting card holds while the setting still has the value it was proposed
// over: changed since (in Settings, on another device), it runs nothing.
export const settingStamp = (key: string, value: string | undefined) => `setting:${key}:${value ?? ''}`

// Each project change's place: the card's title and what Show me highlights.
export const CHANGE_PLACES: Record<string, { label: (key: string) => string, target?: UiTargetId }> = {
  'project add': { label: k => `New project ${k}` },
  'project template': { label: k => `Project ${k} › Workflow`, target: 'project.workflow' },
  'project guards': { label: k => `Project ${k} › Guards`, target: 'project.guards' },
  'project machine': { label: k => `Project ${k} › Machines` },
  'coordinator start': { label: k => `Project ${k} › Coordinator`, target: 'project.autopilot' },
  'v2 import': { label: () => 'Projects from wherdr v2' },
}
export const changeStamp = (lines: string[]) => `change:${lines.join('\n')}`

// What the card is about: one card per task and action, per setting, or per
// project and change.
const cardAbout = (c: UiCard) => (c.setting ? `setting:${c.setting.key}` : c.change ? `change:${c.label}` : `${c.kind}:${c.task}`)

// The cards a coordinator keeps: the new one first, one per task and action
// (a new one replaces the older), the newest UI_CARDS_MAX of the last day.
export function keepCards(cards: UiCard[], card: UiCard, now: number): UiCard[] {
  const rest = cards.filter(c => cardAbout(c) !== cardAbout(card) && now - c.at <= UI_CARD_MS)
  return [card, ...rest].slice(0, UI_CARDS_MAX)
}

// The block the agent ends its reply with; utils/markdown.ts shows each
// `action <id>` line as the card (ActionCard.vue).
export const actionBlock = (id: string) => `\`\`\`wherdr\naction ${id}\n\`\`\``
const ACTION_LINE = /^action\s+([0-9a-f]{16})$/
export function parseActionLine(line: string): string | null {
  return ACTION_LINE.exec(line.trim())?.[1] ?? null
}
