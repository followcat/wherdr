// Tasks to review (ReviewCard.vue, ReviewSheet.vue): the sheet open or not and
// its filter, kept on the server like the Board's project picker: Follow group
// tab, All, a project (`p:KEY`) or a machine group (its id); null until the
// user picks (then Follow once machine groups exist, else All).
import { syncedRef } from './useSyncedSettings'

export const REVIEW_FOLLOW = 'follow'
export const REVIEW_ALL = 'all'
export const reviewOpen = ref(false)
export const reviewFilter = syncedRef<string | null>('reviewFilter', raw => raw || null, v => v || null)

// The filter as it applies: a group or project removed since it was picked falls back to the default.
export const reviewPick = (known: (v: string) => boolean) => {
  const saved = reviewFilter.value
  return saved && (saved === REVIEW_FOLLOW || saved === REVIEW_ALL || known(saved)) ? saved : machineGroups.value.length ? REVIEW_FOLLOW : REVIEW_ALL
}

// Whether a project's tasks show under that filter: the home tab's projects
// (projectOnBar), every project, one project, or the projects on a group's machines.
export function reviewShows(pick: string, project: string) {
  if (pick === REVIEW_ALL) return true
  if (pick === REVIEW_FOLLOW) return projectOnBar(project)
  if (pick.startsWith('p:')) return pick.slice(2) === project
  const group = machineGroups.value.find(g => g.id === pick)
  return !group || projectOnTab(projectTabPlaces.value.get(project) ?? null, group.machines)
}
