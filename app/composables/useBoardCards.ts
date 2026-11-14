// The board, read once for every task card on screen in the chats
// (ChatTaskCard.vue): read again every 15 s while one shows and the page is
// visible, and after an action in a task's sheet. No card on screen, no read.
import type { Board, Card } from '#shared/pm/board'
import { storedTaskId } from '#shared/pm/projectKey'

const board = ref<Board | null>(null)
let users = 0
let timer: ReturnType<typeof setInterval> | undefined
let stopTick: (() => void) | undefined
const load = () => api<Board>('/api/pm/board').then((b) => { board.value = b }, () => {})

// The card of a task, by any key its project had, archived ones too; undefined until the board is read, null when unknown.
export function useBoardCard(id: MaybeRefOrGetter<string>) {
  onMounted(() => {
    if (users++) return
    load()
    timer = setInterval(() => { if (!document.hidden) load() }, 15_000)
    stopTick = watch(taskSheetTick, load)
  })
  onBeforeUnmount(() => {
    if (--users) return
    clearInterval(timer)
    stopTick?.()
  })
  const found = computed<Card | null | undefined>(() => {
    const b = board.value
    if (!b) return undefined
    const want = storedTaskId(b.projects, toValue(id)) ?? toValue(id)
    return b.cards.find(c => c.id === want) ?? null
  })
  // An archived task is not on the board: its card read on its own (null: unknown).
  const archived = useArchivedCard(() => toValue(id), () => found.value === null)
  return computed<Card | null | undefined>(() => (found.value === null ? archived.value : found.value))
}
