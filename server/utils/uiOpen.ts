// `ui open` on the server, for `wherdr alfred` and `wherdr pm`: checks the
// link and the turn (shared/uiOpen.ts), then sends the event on /ws/events to
// the one app the user is on: of those showing the agent's own conversation,
// the one they used last (shared/uiOpen.ts `uiTarget`).
import type { Pane } from '../../shared/types'
import type { Turn } from '../../shared/pm/coordinator'
import { uiBlock, uiLink, uiOpenRefusal, uiShow, uiTarget, type UiClient, type UiOpenEvent } from '../../shared/uiOpen'
import { linkTarget, UI_TARGETS, uiTargetList } from '../../shared/uiTargets'
import { folderPath, showBlock, type UiShowEvent } from '../../shared/uiShow'
import { shownTaskId } from '../../shared/pm/projectKey'
import type { Task } from '../../shared/pm/run'
import { HerdrError } from './herdr'
import type { PmStore } from './pmStore'

type Client = UiClient & { send: (data: string) => void }

export interface UiOpenDeps { store: PmStore, panes: () => Pane[], clients: () => Iterable<Client> }

// The agent's own conversation and the open app the user is on now.
async function userApp(deps: UiOpenDeps, scope: string, give: string) {
  const terminal = (await deps.store.coordinator(scope))?.terminal
  const pane = terminal ? deps.panes().find(p => p.coreAddress === terminal) : undefined
  const to = pane ? uiTarget([...deps.clients()], pane.id, Date.now()) : null
  if (!pane || !to) throw new HerdrError('not_found', `No open wherdr is in use on your conversation now: give the user the ${give} instead`)
  return { pane, to }
}
function send(to: Client, event: UiOpenEvent | UiShowEvent, give: string) {
  try { to.send(JSON.stringify(event)) }
  catch { throw new HerdrError('not_found', `The wherdr the user is on just closed: give the user the ${give} instead`) }
}

// scope: the token's (MAIN or a project key); by: the name the app shows.
export async function openUi(deps: UiOpenDeps, o: { scope: string, main: boolean, raw: unknown, turn: Turn, by: string }) {
  const link = uiLink(o.raw)
  const own = (o.main ? null : await deps.store.project(o.scope)) ?? { key: o.scope }
  const why = uiOpenRefusal(link, o.turn, own, o.main)
  if (why) throw new HerdrError('refused', why)
  const { pane, to } = await userApp(deps, o.scope, 'link')
  const show = uiShow(to.device, link!)
  const event: UiOpenEvent = { type: 'ui-open', pane: pane.id, link: link!, by: o.by, show }
  send(to, event, 'link')
  const where = show === 'panel' ? 'in the Settings panel beside your conversation' : 'as a card above the message field'
  const target = linkTarget(link!)
  const lit = target ? `, ${UI_TARGETS[target].label} highlighted${show === 'card' ? ' once the user taps the card' : ''}` : ''
  return {
    opened: link,
    'opened on': to.device ?? 'phone',
    note: `Shown ${where}${lit} on the user's ${to.device ?? 'phone'}; the user closes it. Nothing was changed. End your reply with this block, so the card stays in the conversation:\n${uiBlock(link!)}`,
  }
}

// `ui targets`: the settings `ui open --target <id>` can highlight.
export const uiTargetsList = () => ({ targets: uiTargetList(), note: 'Highlight one with ui open --target <id> (add --project <KEY> for a project.… target), in a turn of the user' })

// `ui show file <path> | shots <task>`: the file (inside the agent's folder) or
// the task's screenshots, beside the conversation of the app the user is on.
export async function showUi(deps: UiOpenDeps, o: { scope: string, turn: Turn, by: string } & ({ what: 'file', path: string } | { what: 'shots', task: Task })) {
  if (o.turn !== 'user') throw new HerdrError('refused', 'ui show is only for a turn that comes from the user, never in a wake')
  const give = o.what === 'file' ? 'path' : 'task'
  const { pane, to } = await userApp(deps, o.scope, give)
  let arg: string
  if (o.what === 'file') {
    const p = folderPath(o.path, pane.cwd)
    if (!p) throw new HerdrError('refused', 'Only a file of your own folder: a path relative to it (docs/plan.md), with no ~ or ..')
    arg = p
  } else {
    if (!Object.values(o.task.step?.shots ?? {}).some(l => l.length)) throw new HerdrError('refused', 'This task has no screenshots yet')
    arg = shownTaskId(await deps.store.projects(), o.task.id)
  }
  send(to, { type: 'ui-show', pane: pane.id, what: o.what, arg, by: o.by }, give)
  const device = to.device ?? 'phone'
  const approve = o.what === 'shots' ? ` It approves nothing: for the user's approval, add ui action step ${arg}.` : ''
  return {
    shown: `${o.what} ${arg}`,
    note: `Shown ${device === 'computer' ? 'beside your conversation' : 'as a card above the message field'} on the user's ${device}; the user closes it.${approve} End your reply with this block, so the card stays in the conversation:\n${showBlock(o.what, arg)}`,
  }
}
