import { effectScope } from 'vue'
import type { Pane, ChatResponse } from '#shared/types'
import { chatIntentKey, createChatIntentCache } from '~/utils/chatIntent'
import { tailQuery } from '~/utils/chatTail'

const cache = createChatIntentCache((pane, signal) => api<ChatResponse>(
  `/api/chat?${tailQuery(pane, { token: '', tailStart: null, tail: [] })}`, undefined, signal,
))
let watching = false
// Command Code is never guessed: a speculative tail cannot prove it came
// from the live process the pane now shows (its selection is only bound by
// the identity server on a real read).
const allowed = (pane: Pane) => !locked.value && !netDown.value && !offlineView.value
  && eventsOpen.value && !paneStale(pane) && Boolean(pane.agent) && pane.agent !== 'cmd'
const key = (pane: Pane) => chatIntentKey(pane, herdrState.value.session)

export function useChatIntent() {
  if (!watching) {
    watching = true
    effectScope(true).run(() => {
      // Outlive individual cards so lock/reconnect always invalidates pending reads.
      watch([locked, netDown, offlineView, eventsOpen, () => herdrState.value.session], () => cache.clear(), { flush: 'sync' })
      watch(() => JSON.stringify([herdrState.value.panes.map(key), herdrState.value.machines?.map(m => [m.key, m.status])]), () => cache.clear(), { flush: 'sync' })
    })
  }
  return {
    preload: (pane: Pane) => { if (allowed(pane)) cache.preload(key(pane), pane.id) },
    take: async (pane: Pane) => {
      if (!allowed(pane)) return undefined
      const identity = key(pane)
      const response = await cache.take(identity)
      return allowed(pane) && key(pane) === identity ? response : undefined
    },
  }
}
