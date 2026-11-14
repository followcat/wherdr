// A task agent's row: its title, role badge and how long it has been in its state.
import type { Pane } from '../../shared/types'
import type { TaskAgent } from '../../shared/pm/taskAgents'

const MAX_TITLE = 60

// '<KEY-n> <task title>' (without the key when a badge shows it), cut at 60
// characters; '' when the user renamed the pane (its own name stays) or the pane is no task's.
export function taskAgentTitle(pane: Pick<Pane, 'label'>, agent?: TaskAgent, withKey = true): string {
  if (!agent || pane.label?.trim()) return ''
  const title = (withKey ? `${agent.shown} ${agent.title.trim()}` : agent.title.trim()).trim()
  return title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1).trimEnd()}…` : title
}

// '8 min', '2 h', '3 d'; '' without a known start (or a clock behind it).
export function stateDuration(since: number | undefined, now: number): string {
  if (since === undefined || now < since) return ''
  const min = Math.floor((now - since) / 60_000)
  if (min < 60) return `${Math.max(1, min)} min`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h} h` : `${Math.floor(h / 24)} d`
}

// Agents of the same task as one row, at the place of the task's first agent;
// its lead (the most urgent agent, first on a tie) sets the row's state group.
// Rows of no task stay alone.
export function groupTaskAgents<T>(items: T[], taskOf: (item: T) => string | undefined, urgencyOf: (item: T) => number): { lead: T, agents: T[] }[] {
  const out: { lead: T, agents: T[] }[] = []
  const byTask = new Map<string, { lead: T, agents: T[] }>()
  for (const item of items) {
    const task = taskOf(item)
    const group = task === undefined ? undefined : byTask.get(task)
    if (group) {
      group.agents.push(item)
      if (urgencyOf(item) < urgencyOf(group.lead)) group.lead = item
      continue
    }
    const entry = { lead: item, agents: [item] }
    if (task !== undefined) byTask.set(task, entry)
    out.push(entry)
  }
  return out
}
