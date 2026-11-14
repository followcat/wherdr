import { projectLink, settingsLink } from '../appLinks'

// Where the user changes a project's settings, as texts name it: the project
// sheet (Settings › Projects › a project) and its tabs, opened by the URL
// `#/settings?section=projects&project=<key>&tab=<tab>` (ProjectsSettings).
// link: with that in-app address, for what an agent tells the user.
export const PROJECT_TABS = ['general', 'workflow', 'guards', 'automations', 'autopilot'] as const
export type ProjectTab = typeof PROJECT_TABS[number]
export const PROJECT_TAB_LABEL: Record<ProjectTab, string> = { general: 'General', workflow: 'Workflow', guards: 'Guards', automations: 'Automations', autopilot: 'Autopilot' }

// No key: the Projects section itself.
export function projectPlace(key?: string, tab: ProjectTab = 'general', link = false): string {
  const k = key?.toUpperCase()
  const name = k ? `Settings › Projects › ${k} › ${PROJECT_TAB_LABEL[tab]}` : 'Settings › Projects'
  return link ? `${name} (\`${k ? projectLink(k, tab) : settingsLink('projects')}\`)` : name
}
