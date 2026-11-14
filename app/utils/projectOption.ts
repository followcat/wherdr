import { shownKey } from '#shared/pm/projectKey'

// A project as a ProjectSelect option: its name, and its key badge in its color.
export interface ProjectOption { label: string, value: string, disabled?: boolean, badge?: { text: string, color?: string } }
export const projectOption = (p: { key: string, label?: string, name: string, color?: string }, value = p.key): ProjectOption =>
  ({ label: p.name, value, badge: { text: shownKey(p), color: p.color } })
