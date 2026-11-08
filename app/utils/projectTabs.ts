// The project sheet's tabs, and the one a URL asks for (`?tab=`): General by default.
export const PROJECT_TABS = ['general', 'workflow', 'guards', 'automations', 'autopilot'] as const
export type ProjectTab = typeof PROJECT_TABS[number]
export const projectTab = (q: unknown): ProjectTab => (PROJECT_TABS as readonly unknown[]).includes(q) ? q as ProjectTab : 'general'
