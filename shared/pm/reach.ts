// Other projects a project's coordinator may read or act on (Project.reach),
// set by the user only, in the project's General tab. Empty: its own project only.
// Guards, merges, approvals, settings, autopilot limits, workflow and automation
// proposals of another project always stay with that project's coordinator and the user.
import { projectPlace } from './places'

export type ReachLevel = 'read' | 'act'
export interface Reach { project: string, level: ReachLevel }

export const REACH_SETTING = 'Other projects this coordinator may act on'
export const READ_COMMANDS = ['list', 'show', 'read', 'plan', 'incidents']
export const ACT_COMMANDS = [...READ_COMMANDS, 'task add', 'task start', 'task stop', 'task edit', 'task note', 'task order', 'task tag', 'task link', 'task check', 'task remove', 'tell', 'report back', 'report close']
const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

// The level `self` has on project `other` (fixed keys); undefined: none.
export const reachLevel = (self: { reach?: Reach[] } | undefined, other: string) => self?.reach?.find(r => r.project === other)?.level

// Why `self`'s coordinator may not run `command` on project `other` (shown keys
// for the text), or undefined when it may.
export function reachRefusal(self: { key: string, reach?: Reach[] } | undefined, other: string, command: string, shown = { self: self?.key ?? '', other }) {
  const level = reachLevel(self, other)
  if (level === 'act' ? ACT_COMMANDS.includes(command) : level === 'read' && READ_COMMANDS.includes(command)) return undefined
  if (!ACT_COMMANDS.includes(command)) return `${command} on project ${shown.other} stays with its own coordinator and the user, whatever the setting`
  const needs = READ_COMMANDS.includes(command) ? 'Read or Act' : 'Act'
  return `Your token acts on project ${shown.self}${level ? ` and reads project ${shown.other}` : ' only'}: ${command} on project ${shown.other} needs ${needs} for ${shown.other} in "${REACH_SETTING}", which only the user sets, in ${projectPlace(shown.self, 'general', true)}`
}

// The setting as sent by the sheet: [{ project, level }], the project's own key left out.
export function cleanReach(raw: unknown, self?: string): { reach?: Reach[], error?: string } {
  if (!Array.isArray(raw) || raw.length > 50) return { error: 'a list of { project, level }' }
  const reach: Reach[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r?.project !== 'string' || !KEY_RE.test(r.project) || (r.level !== 'read' && r.level !== 'act')) return { error: 'each entry: a project key and read or act' }
    if (r.project !== self && !reach.some(x => x.project === r.project)) reach.push({ project: r.project, level: r.level })
  }
  return { reach }
}

// The lines of its instructions (AGENTS.md); none without the setting.
// name: a project's shown key, from its fixed one (undefined: removed).
export function reachLines(reach: Reach[] | undefined, name: (key: string) => string | undefined) {
  const list = (reach ?? []).flatMap(r => { const k = name(r.project); return k ? [`- ${k}: ${r.level === 'act' ? 'Act' : 'Read'}`] : [] })
  if (!list.length) return []
  return ['## Other projects', '',
    `The user lets you work on these projects too (${REACH_SETTING}):`, ...list,
    `Read: ${READ_COMMANDS.join(', ')}. Act: also ${ACT_COMMANDS.slice(READ_COMMANDS.length).join(', ')}, with the same rules as on your project. A task's id names its project; commands that name a project take \`--project <KEY>\`. Their guards, merges, approvals, settings, autopilot, workflow and automations stay with their own coordinator and the user. Each action is written to their log with your name, and their coordinator is told.`, '']
}
