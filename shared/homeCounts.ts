// The home list and the Board say the same of a task: its state is the one
// herdr-projects' CLI gives (`list --json`: `state`, and its `group`), not
// the stage its file holds. The task files (shared/boardLinks.ts) still say
// which panes and spaces are the task's; the CLI says where it stands (an
// agent that exited is `error`, which a file at stage `working` cannot tell).
// Without herdr-projects (Herdr alone), no rows: the agents' own state counts.
// Pure functions, tested in tests/homeCounts.test.ts.
import { type MachineLinks, type HomeStat, taskStat, taskLinks, countedPanes } from './boardLinks'
import type { TaskRow, TasksBoard } from './projectsTasks'
import type { Pane } from './types'

const rowKey = (machine: string, id: string) => `${machine}|${id}`

// The CLI's rows by board and id. A board whose CLI did not answer (`error`)
// gives none: its tasks keep what their files say.
export function boardRows(board: TasksBoard | null | undefined): Map<string, TaskRow> {
  const out = new Map<string, TaskRow>()
  for (const m of board?.machines ?? []) {
    if (m.status !== 'ready' || m.error) continue
    for (const r of m.tasks) out.set(rowKey(m.machine, r.id), r)
  }
  return out
}

// The links with each task's group taken from the CLI, where it lists the task.
export function withBoardGroups(links: MachineLinks[], board: TasksBoard | null | undefined): MachineLinks[] {
  const rows = boardRows(board)
  if (!rows.size) return links
  let any = false
  const out = links.map((m) => {
    let changed = false
    const tasks = m.tasks.map((t) => {
      const r = rows.get(rowKey(m.machine, t.id))
      if (!r || r.group === t.group) return t
      changed = true
      return { ...t, group: r.group }
    })
    any ||= changed
    return changed ? { ...m, tasks } : m
  })
  return any ? out : links
}

export { taskStat, type HomeStat } from './boardLinks'
export type HomeCounts = Record<HomeStat, number>

// An agent without a linked task: its own state, as Herdr reads it.
function paneStat(status: string | null): HomeStat | null {
  if (status === 'blocked') return 'blocked'
  if (status === 'working') return 'working'
  if (status === 'done' || status === 'idle') return 'ready'
  return null
}

// The home counters (YOUR TURN, WORKING, READY). `panes`: the agents Herdr
// shows; `keepPane`: those the counters follow (the machine bar's selection,
// reachable); `keepBoard`: the boards they follow, by base machine key.
// A task counts once, whatever helpers (reviewer, planner, attempts) it has
// open and in however many spaces; one that waits for you counts even with
// no agent pane left.
export function homeCounts<P extends Pick<Pane, 'id' | 'agent' | 'status' | 'workspace'>>(
  panes: P[],
  links: MachineLinks[],
  board: TasksBoard | null | undefined,
  keepPane: (p: P) => boolean = () => true,
  keepBoard: (machine: string) => boolean = () => true,
): HomeCounts {
  const out: HomeCounts = { blocked: 0, working: 0, ready: 0 }
  const rows = boardRows(board)
  const kept = panes.filter(p => p.agent && keepPane(p))
  const taskOf = taskLinks(links, kept)
  const seen = new Set<string>()
  for (const p of countedPanes(kept, links)) {
    const link = taskOf(p)
    const k = link ? rowKey(link.machine, link.task.id) : undefined
    const group = (k ? rows.get(k)?.group : undefined) ?? link?.task.group
    if (group && k) {
      if (seen.has(k)) continue
      seen.add(k)
      out[taskStat(group)]++
      continue
    }
    const s = paneStat(p.status)
    if (s) out[s]++
  }
  // Tasks that wait for you with no agent pane counted (it exited, the space was closed).
  for (const m of board?.machines ?? []) {
    if (m.status !== 'ready' || m.error || !keepBoard(m.machine)) continue
    for (const r of m.tasks) {
      if (r.archived || (r.group !== 'needs' && r.group !== 'ready') || seen.has(rowKey(m.machine, r.id))) continue
      seen.add(rowKey(m.machine, r.id))
      out.blocked++
    }
  }
  return out
}
