// Action buttons (shared/uiActions.ts) on the server: `wherdr pm ui action`
// stores the card in the coordinator's record; GET /api/ui/card reads it as it
// stands now; POST /api/ui/act runs it on the user's click, through the task
// sheet's own handlers, once its stamp still holds.
import { randomBytes } from 'node:crypto'
import type { Turn } from '../../shared/pm/coordinator'
import { shownTaskId } from '../../shared/pm/projectKey'
import { taskPlan, type Task } from '../../shared/pm/run'
import { actionBlock, actionLabel, actionRefusal, actionStamp, cardNow, cardOutcome, changeStamp, defaultChoice, keepCards, outcomeText, settingStamp, type CardChoice, type ProjectChange, type SettingChange, type UiAction, type UiCard } from '../../shared/uiActions'
import { MAIN } from '../../shared/pm/coordinator'
import { tellCardOutcome } from './cardOutcome'
import { HerdrError } from './herdr'
import { userStep } from './pmBoard'
import type { PmLaunchDeps } from './pmLaunch'
import { resumeTask } from './pmStop'
import type { PmStore } from './pmStore'
import { patchSettings, readSettings } from './settings'

async function stampOf(store: PmStore, kind: UiAction, task: Task | null) {
  if (!task) return { stamp: null, plan: [] }
  const [t, p] = [await store.workflow(task.project), await store.project(task.project)]
  const plan = t ? taskPlan(t, task, p ?? undefined) : []
  return { stamp: actionStamp(kind, task, plan), plan }
}

// `ui action <kind> <task>`: scope, the coordinator's key (its record keeps the card).
export async function addAction(store: PmStore, o: { scope: string, turn: Turn, by: string, kind: UiAction, task: Task }) {
  if (o.turn !== 'user') throw new HerdrError('refused', 'ui action is only for a turn that comes from the user, never in a wake')
  const shown = shownTaskId(await store.projects(), o.task.id)
  const { stamp, plan } = await stampOf(store, o.kind, o.task)
  const why = actionRefusal(o.kind, stamp, shown)
  if (why) throw new HerdrError('refused', why)
  const rec = await store.coordinator(o.scope)
  if (!rec) throw new HerdrError('not_found', 'No coordinator for this project')
  const now = Date.now()
  const card: UiCard = { id: randomBytes(8).toString('hex'), by: o.by, at: now, kind: o.kind, task: o.task.id, shown, label: actionLabel(o.kind, shown, plan, o.task), stamp: stamp!, state: 'open' }
  await store.saveCoordinator({ ...rec, cards: keepCards(rec.cards ?? [], card, now) })
  return {
    button: card.label,
    note: `Nothing ran: the user clicks it. End your reply with this block, after the sentence that explains it:\n${actionBlock(card.id)}`,
  }
}

// `wherdr alfred setting set <key> <value> --propose`: a card in Alfred's
// reply; only the user's Apply changes the setting.
export async function addSettingCard(store: PmStore, o: { turn: Turn, by: string, change: SettingChange, label: string }) {
  if (o.turn !== 'user') throw new HerdrError('refused', 'setting set --propose is only for a turn that comes from the user, never in a wake')
  const rec = await store.coordinator(MAIN)
  if (!rec) throw new HerdrError('not_found', 'No Alfred record')
  const now = Date.now()
  const card: UiCard = { id: randomBytes(8).toString('hex'), by: o.by, at: now, kind: 'setting', task: '', shown: '', label: o.label, setting: o.change, stamp: settingStamp(o.change.key, o.change.before), state: 'open' }
  await store.saveCoordinator({ ...rec, cards: keepCards(rec.cards ?? [], card, now) })
  return { proposed: true, note: `Nothing changed: the user clicks Apply. End your reply with this block, after the sentence that explains it:\n${actionBlock(card.id)}` }
}

// `wherdr alfred <change> --propose` (project add, template, guards…): a card
// in Alfred's reply; only the user's Apply makes the change.
export async function addChangeCard(store: PmStore, o: { turn: Turn, by: string, change: ProjectChange, label: string }) {
  if (o.turn !== 'user') throw new HerdrError('refused', '--propose is only for a turn that comes from the user, never in a wake')
  const rec = await store.coordinator(MAIN)
  if (!rec) throw new HerdrError('not_found', 'No Alfred record')
  const now = Date.now()
  const card: UiCard = { id: randomBytes(8).toString('hex'), by: o.by, at: now, kind: 'change', task: '', shown: '', label: o.label, change: o.change, stamp: changeStamp(o.change.lines), state: 'open' }
  await store.saveCoordinator({ ...rec, cards: keepCards(rec.cards ?? [], card, now) })
  return { proposed: true, change: o.change.lines, note: `Nothing changed: the user clicks Apply. End your reply with this block, after the sentence that explains it:\n${actionBlock(card.id)}` }
}

async function find(store: PmStore, id: unknown) {
  if (typeof id !== 'string') return null
  for (const rec of await store.coordinators()) {
    const card = rec.cards?.find(c => c.id === id)
    if (card) return { rec, card }
  }
  return null
}

// The card as it stands now (stale once its task changed), or null.
export async function readCard(store: PmStore, id: unknown, settingsFile?: string): Promise<UiCard | null> {
  const hit = await find(store, id)
  if (!hit) return null
  const s = hit.card.setting
  if (s) return cardNow(hit.card, settingStamp(s.key, (await readSettings(settingsFile))[s.key]), Date.now())
  // A project change is checked again at the click (its dry run): here, its age only.
  if (hit.card.change) return cardNow(hit.card, hit.card.stamp, Date.now())
  const task = await store.task(hit.card.task)
  const { stamp } = await stampOf(store, hit.card.kind as UiAction, task)
  const card = cardNow(hit.card, stamp, Date.now()), turn = task?.step?.yourTurn
  // Its step's action refused at an earlier click: still said after a reload.
  return card.state === 'open' && card.kind === 'step' && turn?.reason === 'action' ? { ...card, refused: turn.badge } : card
}

// The user's click. A CLI token never clicks: only the app's own session.
// Not open (done, stale): nothing runs, the card says why.
// cancel: the user's Cancel, the card runs nothing more.
// applyChange: makes a project change while its dry run still shows `lines`
// (null: it no longer does; else the outcome's lines, one per project of a
// `v2 import`), server/utils/alfredCli.ts. choice: the card's checkboxes.
export type ApplyChange = (argv: string[], lines: string[], choice?: CardChoice) => Promise<string[] | null>
type ActDeps = PmLaunchDeps & { settingsFile?: string, applyChange?: ApplyChange }
// Its outcome is told to the agent whose reply holds the card (cardOutcome.ts):
// a click on a card no longer open changes nothing and tells nothing.
export async function actOnCard(deps: ActDeps, id: unknown, authorization: unknown, cancel = false, choice?: CardChoice): Promise<UiCard> {
  if (authorization) throw new HerdrError('forbidden', 'Only the user\'s click in wherdr runs an action, never a token')
  const before = await find(deps.store, id)
  const tell = (text: string) => tellCardOutcome(deps, before!.rec.project, text).catch(() => {})
  let card: UiCard
  // A check that fails at the click (a folder no longer a repository): not applied, and why.
  try { card = await act(deps, id, cancel, choice) }
  catch (e) {
    if (before?.card.state === 'open' && !cancel && e instanceof HerdrError) await tell(cardOutcome(before.card, e.message))
    throw e
  }
  const turned = before && (before.card.state !== card.state || card.refused)
  if (turned) await tell(cardOutcome(card, card.refused))
  return card
}

async function act(deps: ActDeps, id: unknown, cancel: boolean, choice?: CardChoice): Promise<UiCard> {
  const card = await readCard(deps.store, id, deps.settingsFile)
  if (!card) throw new HerdrError('not_found', 'Unknown action')
  // Stale at the click (changed since, too old): kept so, and said once to the agent.
  if (card.state !== 'open') return card.state === 'stale' && !cancel ? save(deps.store, card) : card
  if (cancel) return save(deps.store, { ...card, state: 'dismissed', outcome: { text: 'Cancelled by you', at: Date.now() } })
  const s = card.setting
  if (s) {
    await patchSettings({ [s.key]: s.after }, { file: deps.settingsFile })
    return save(deps.store, { ...card, state: 'done', outcome: { text: 'Applied by you', at: Date.now() } })
  }
  const c = card.change
  if (c) {
    if (!deps.applyChange) throw new HerdrError('unavailable', 'Project changes are not applied here')
    const made = await deps.applyChange(c.argv, c.lines, c.picks ? choice ?? defaultChoice(c) : undefined)
    return save(deps.store, made ? { ...card, state: 'done', outcome: { text: 'Applied by you', at: Date.now(), ...(made.length ? { lines: made } : {}) } } : { ...card, state: 'stale' })
  }
  if (card.kind === 'open') return card
  const task = card.kind === 'resume' ? await resumeTask(deps, card.task, 'continue', { who: 'user' }, 'user') : await userStep(deps, card.task)
  // The step's action refused (a merge on a PR in conflict, red checks): the
  // card stays open with its reason, as the task sheet shows it, for a retry.
  const turn = task.step?.yourTurn
  if (card.kind === 'step' && turn?.reason === 'action') return { ...card, refused: turn.badge }
  const same = card.kind === 'step' && (await stampOf(deps.store, 'step', task)).stamp === card.stamp
  return save(deps.store, { ...card, state: 'done', outcome: { text: outcomeText(card, same ? task : undefined), at: Date.now() } })
}

async function save(store: PmStore, card: UiCard) {
  const hit = await find(store, card.id)
  if (hit) await store.saveCoordinator({ ...hit.rec, cards: hit.rec.cards!.map(c => (c.id === card.id ? card : c)) })
  return card
}
