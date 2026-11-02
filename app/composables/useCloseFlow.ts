import { checkoutMessage, planClose, taskStopMessage, tasksClosing, widerClose, type CloseKind, type ClosePlan, type CheckoutStatus } from '~/utils/closeFlow'

interface CloseStatus { git: boolean, modified?: number, untracked?: number, truncated?: boolean }

// What a close confirmation says about its target, written from the plan
// computed right now (names, counts, what stops).
export type CloseText = (plan: ClosePlan) => { message: string, action: string }

// Asks, then checks the structure again before closing: if the close would now
// take more than what was shown (a pane added to the space, the last other pane
// gone, a worktree group…), the updated confirmation is shown again. A target
// that disappeared closes nothing.
export async function confirmClose(kind: CloseKind, id: string, text: CloseText): Promise<ClosePlan | null> {
  let shown: ClosePlan | null = null
  for (let round = 0; round < 4; round++) {
    const plan = planClose(herdrState.value, kind, id)
    if (!plan.workspaces.length) return null
    if (shown && !widerClose(shown, plan)) return plan
    if (!(await askClose(kind, plan, text(plan)))) return null
    shown = plan
  }
  return null
}

async function askClose(kind: CloseKind, plan: ClosePlan, { message, action }: { message: string, action: string }): Promise<boolean> {
  const statuses: CheckoutStatus[] = []
  try {
    for (const w of plan.workspaces) {
      if (!w.repo && !w.worktree) continue
      const pane = herdrState.value.panes.find(p => p.workspace === w.id && p.cwd)
      if (!pane) throw new Error(tl(`Git status unavailable for “${w.label}”.`, `État Git indisponible pour « ${w.label} ».`))
      const changes = await api<CloseStatus>(`/api/close/status?pane=${encodeURIComponent(pane.id)}`)
      if (!changes.git) throw new Error(tl(`Git status unavailable for “${w.label}”.`, `État Git indisponible pour « ${w.label} ».`))
      statuses.push({
        label: w.label,
        modified: changes.modified || 0,
        untracked: changes.untracked || 0,
        truncated: changes.truncated,
      })
    }
  } catch (err) {
    toast((err as Error).message, true)
    return false
  }
  const details = statuses.length || plan.group ? `\n${checkoutMessage(statuses, plan.group, tl)}` : ''
  const processes = plan.group
    ? tl(` ${plan.panes.length} panes and their processes will close.`, ` ${plan.panes.length} panes et leurs processus seront fermés.`)
    : ''
  const groupAction = plan.group ? tl('Close group', 'Fermer le groupe') : action
  // herdr-projects tasks it stops (the repo's space closes its tasks' spaces): named, and said on the button.
  await refreshBoardLinks()
  const tasks = taskStopMessage(tasksClosing(plan, kind, boardLinksNow()), tl)
  const text = `${message}${processes}${tasks ? `\n\n${tasks.message}` : ''}${details}`
  return await askConfirm(text, tasks?.action || groupAction)
}
