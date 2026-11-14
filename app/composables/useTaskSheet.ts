// A task's sheet over the page the user is on (TaskSheetHost.vue, in app.vue):
// ?task=ID on the current route, so it survives a reload and can be linked.
// The board shows its own sheet from the same parameter (BoardView.vue).
import type { LocationQuery } from 'vue-router'

// Bumped by an action in a sheet (merge, try again, start…): the board, the
// open sheet and Tasks to handle read again.
export const taskSheetTick = ref(0)
export const taskChanged = () => { taskSheetTick.value++ }

// A task's agent at work again (its question answered here, in its
// conversation, by a coordinator's tell or on another device): every task list
// (Tasks to review, Tasks to handle, the board) reads again at once, and once
// more a moment later, after the server saved the answer. TaskSheetHost.vue, always mounted.
export function watchTaskAgents() {
  let again: ReturnType<typeof setTimeout> | undefined
  const working = () => new Set((herdrState.value?.panes ?? []).filter(p => p.task && p.status === 'working').map(p => p.id))
  watch(working, (now, before) => {
    if (![...now].some(id => !before.has(id))) return
    taskChanged()
    clearTimeout(again)
    again = setTimeout(taskChanged, 2000)
  })
}

const without = (q: LocationQuery) => Object.fromEntries(Object.entries(q).filter(([k]) => k !== 'task'))

export function openTaskSheet(id: string) {
  const router = useRouter()
  const { path, query } = router.currentRoute.value
  return router.push({ path, query: { ...query, task: id } })
}

// Back to the page as it was: the entry openTaskSheet pushed is left (so Back
// does not open the sheet again); a linked or reloaded one only drops ?task.
export function closeTaskSheet() {
  const router = useRouter()
  const { path, query } = router.currentRoute.value
  if (query.task === undefined) return
  const before = router.resolve({ path, query: without(query) })
  if (history.state?.back === before.fullPath) router.back()
  else router.replace(before)
}
