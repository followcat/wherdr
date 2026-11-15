// The home list's first load (WHR-329): each section it draws from its own
// read (the quotas, Alfred, the coordinators, the tasks to handle, the task
// agents) marks here how that read first ended. Until all have answered, the
// list shows skeletons (HomeSkeleton) instead of the sections that happen to be
// in, then draws everything at once. Latched: later refreshes keep the last
// data. A failed first read, or one still pending at the deadline, shows an
// error and Try again, never the list without that section.
type HomeSection = 'quotas' | 'alfred' | 'coordinators' | 'handle' | 'agents'
type LoadState = 'pending' | 'ok' | 'failed'
const pending = (): Record<HomeSection, LoadState> => ({ quotas: 'pending', alfred: 'pending', coordinators: 'pending', handle: 'pending', agents: 'pending' })
export const homeFirstLoad = reactive(pending())
export const homeListReady = ref(false)
export const homeSectionsLoaded = () => Object.values(homeFirstLoad).every(s => s === 'ok')
export const homeLoadFailed = () => Object.values(homeFirstLoad).some(s => s === 'failed')
// A section's read ended; a failure after a success changes nothing.
export function markHomeLoad(section: HomeSection, ok: boolean) {
  if (ok) homeFirstLoad[section] = 'ok'
  else if (homeFirstLoad[section] !== 'ok') homeFirstLoad[section] = 'failed'
}
// Try again: the sections not in yet read again (ReviewCard watches it).
export const homeRetryTick = ref(0)
export function resetHomeLoad() {
  for (const k of Object.keys(homeFirstLoad) as HomeSection[]) if (homeFirstLoad[k] !== 'ok') homeFirstLoad[k] = 'pending'
}
// A read still pending then counts as failed (a lost request).
export const HOME_LOAD_DEADLINE = 10_000
