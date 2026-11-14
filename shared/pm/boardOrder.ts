// The board's order: the tasks the coordinator put first (`wherdr pm task
// order`) by their place, then the others oldest first. Each column shows its
// cards in this order, Keep the board busy starts to-do tasks in it, and the
// merge queue takes approved merges in it.
import type { Task } from './run'

type Ordered = Pick<Task, 'id' | 'createdAt' | 'order'>

const place = (t: Ordered) => t.order ?? Number.POSITIVE_INFINITY
export const byBoardOrder = (a: Ordered, b: Ordered) =>
  (place(a) === place(b) ? 0 : place(a) < place(b) ? -1 : 1) || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
export const boardOrder = <T extends Ordered>(tasks: T[]): T[] => [...tasks].sort(byBoardOrder)

// `task order <task>…`: the new place of each named task, before every place
// the project's tasks have now, so they come first in their column, in this
// order, and the others keep their order after them. tasks: the project's.
export function orderTasks(tasks: Task[], ids: string[]): { order: Record<string, number> } | { refused: string } {
  if (new Set(ids).size !== ids.length) return { refused: 'Name each task once' }
  for (const id of ids) {
    const t = tasks.find(x => x.id === id)
    if (!t) return { refused: `Unknown task: ${id} (tasks of one project, on its board)` }
    if (t.step?.done) return { refused: `${id} is done: only tasks still on the board are ordered` }
  }
  const first = Math.min(0, ...tasks.map(t => t.order ?? 0)) - ids.length
  return { order: Object.fromEntries(ids.map((id, i) => [id, first + i])) }
}
