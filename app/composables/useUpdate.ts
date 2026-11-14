// "New wherdr version" notice (/api/update): loaded once per opening
// of the app (the server only asks GitHub once a day). "Hide"
// lasts until the next version, on this device.
// v3 has no one-tap update: the banner's "Update with Alfred" asks Alfred,
// which lives in herdr-core and so outlives wherdr's restart, to run
// docs/update-with-an-agent.md.
import { alfredUpdateRequest, type UpdateInfo } from '#shared/updates'

const DISMISS_KEY = 'wherdr.update.dismissed'
export const updateInfo = ref<UpdateInfo | null>(null)
const dismissed = ref<string>('')
let loaded = false

export function loadUpdate() {
  if (loaded) return
  loaded = true
  try { dismissed.value = localStorage.getItem(DISMISS_KEY) || '' } catch { /* stockage indisponible */ }
  api<UpdateInfo>('/api/update').then((u) => { updateInfo.value = u }).catch(() => { loaded = false })
}

// New version to announce on the home screen (hideable).
export const updateBanner = computed(() => {
  const u = updateInfo.value
  return u?.latest && u.latest !== dismissed.value ? u : null
})

export function dismissUpdate() {
  const v = updateInfo.value?.latest
  if (!v) return
  dismissed.value = v
  try { localStorage.setItem(DISMISS_KEY, v) } catch { /* stockage indisponible */ }
}

// Alfred's conversation opened, with the request sent as the user's turn.
export async function updateWithAlfred(info: UpdateInfo) {
  try { await askAlfred(alfredUpdateRequest(info)) } catch (e) { toast((e as Error).message, true) }
}
