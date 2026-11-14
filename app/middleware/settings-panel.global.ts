// Computer with room: Settings opened from a conversation slide in beside it
// (utils/settingsPanel.ts). "Open full page" skips this once.
import { settingsPanelRoute } from '~/utils/settingsPanel'

export default defineNuxtRouteMiddleware((to, from) => {
  if (import.meta.server) return
  if (fullSettingsOnce.value) { fullSettingsOnce.value = false; return }
  const panel = settingsPanelRoute(to, from, sidePanelRoom.value)
  if (panel) return navigateTo(panel)
})
