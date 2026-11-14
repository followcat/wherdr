import { conversationIn, machineConversation, readConversationMemory, type Conversation } from '~/utils/machineConversation'

// Device-local history, deliberately outside synced settings. Drafts stay owned
// by useDraft: switching the route follows the ordinary conversation lifecycle.
export function useMachineConversation() {
  const route = useRoute()
  let memory = readConversationMemory(null)
  try { memory = readConversationMemory(localStorage.getItem('machineConversations')) } catch { /* storage unavailable */ }
  const viewed = (): Conversation | null => route.path.startsWith('/a/') ? { pane: String(route.params.pane) }
    : route.path.startsWith('/t/') ? { tab: String(route.params.tab) } : null
  function remember() {
    const view = viewed()
    const pick = machineBarPick.value
    if (pick === null || !view || !conversationIn(herdrState.value, view, pick, machineGroups.value, coordinatorPlaces.value)) return
    if (Object.hasOwn(memory, pick) && JSON.stringify(memory[pick]) === JSON.stringify(view)) return
    memory = { ...memory, [pick]: view }
    try { localStorage.setItem('machineConversations', JSON.stringify(memory)) } catch { /* storage unavailable */ }
  }
  let reopen = false
  let historyTarget: string | null = null
  const router = useRouter()
  // History pops reopen the previous view. Push/replace navigations express
  // a new choice (search, cards, links) and must keep their chosen destination.
  // New hash links have no router state; back/forward entries do, even
  // when Vue Router reports a zero history delta. Explicit pushes emit no pop.
  function onPop(event: PopStateEvent) {
    historyTarget = event.state != null ? router.resolve(location.hash.slice(1) || '/').fullPath : null
  }
  if (import.meta.client) window.addEventListener('popstate', onPop)
  onBeforeUnmount(() => {
    if (import.meta.client) window.removeEventListener('popstate', onPop)
  })
  function open(destination: Conversation | null | undefined) {
    if (destination === undefined) return
    const path = destination === null ? '/' : 'pane' in destination ? panePath(destination.pane) : tabTarget(destination.tab)
    void navigateTo(path, { replace: true })
  }
  watch(() => route.fullPath, () => {
    const restore = reopen && historyTarget === route.fullPath
    historyTarget = null
    if (viewed()) {
      reopen = false
      if (restore) {
        const destination = machineConversation(herdrState.value, machineBarPick.value, machineGroups.value, memory, viewed(), coordinatorPlaces.value)
        if (destination !== undefined) { open(destination); return }
      }
    }
    remember()
  })
  watch(herdrState, remember, { immediate: true })
  return () => {
    const destination = machineConversation(herdrState.value, machineBarPick.value, machineGroups.value, memory, viewed(), coordinatorPlaces.value)
    // Phones keep the list first; restore only when history reopens a view
    // outside the new filter, leaving explicit conversation choices alone.
    // The board stays: it follows the tab itself (BoardView.vue).
    if (desk.value && !route.path.startsWith('/board')) open(destination)
    else { reopen = true; historyTarget = null }
    remember()
  }
}
