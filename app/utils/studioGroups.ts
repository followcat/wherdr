// Studio groups of the Home list (backlot): role terminals carrying
// backlot.studio fold into one row per studio and machine; Hollywood's roles
// fold into one Hollywood row per machine. Pure (tested).
import type { MachineInfo, Pane } from '../../shared/types'
import { leadPane, paneGroup, type Row, type RowGroup } from '../../shared/spaces'
import { isBacklotDaemonTerminal } from '../../shared/backlotDaemon'
import type { IndividualAgentRow } from './homeAgentRows'

export interface StudioGroup {
  kind: 'studio'
  key: string
  machineKey: string
  studioId: string
  title: string
  machineLabel: string
  session: string
  rows: IndividualAgentRow[]
  panes: Pane[]
  lead: Pane
  waitingCount: number
}
export type StudioHomeRow = Row | StudioGroup

export const isBacklotDaemonPane = (p: Pick<Pane, 'name' | 'labels' | 'backlotRole'>): boolean => isBacklotDaemonTerminal(p)
export const withoutBacklotDaemons = <P extends Pick<Pane, 'name' | 'labels' | 'backlotRole'>>(panes: readonly P[]): P[] => panes.filter(p => !isBacklotDaemonPane(p))

export const isStudioGroup = (row: Row | StudioGroup | null | undefined): row is StudioGroup => row?.kind === 'studio'
export const studioRowGroup = (group: StudioGroup): RowGroup => paneGroup(group.lead)

const roleOf = (p: Pane) => p.labels?.['backlot.role'] ?? p.backlotRole
const studioOf = (p: Pane): { id: string, title: string } | null => {
  if (isBacklotDaemonPane(p)) return null
  if (roleOf(p) === 'hollywood') return { id: 'hollywood', title: 'Hollywood' }
  const id = (p.backlotStudio ?? p.labels?.['backlot.studio'] ?? '').trim()
  return id ? { id, title: id } : null
}
const individualOf = (pane: Pane): IndividualAgentRow => ({ kind: 'pane', key: pane.id, pane, lead: pane, individual: true })

/** A role row's title: the person's tab (`actor-b t2`) read as `actor-b · t2`. */
export function studioRoleTitle(pane: Pane): string {
  const tab = pane.labels?.['herdr.tab']?.trim()
  if (tab) {
    const parts = tab.split(/\s+/)
    return parts.length > 1 ? `${parts[0]} · ${parts.slice(1).join(' ')}` : parts[0]!
  }
  return roleOf(pane) || pane.label?.trim() || pane.name?.trim() || pane.id
}

/**
 * Rows of the Home list with backlot roles grouped. The group stands at its
 * first role's place; every other row keeps its object and its place.
 */
export function studioGroupRows(rows: readonly Row[], machines: readonly MachineInfo[] = []): StudioHomeRow[] {
  // A shell-only space holding a studio terminal is split so that terminal can
  // join its group; its other terminals stay ordinary individual rows.
  const expanded = rows.flatMap(row => row.kind === 'space' && row.panes.some(studioOf)
    ? row.panes.map(individualOf)
    : [row])
  type Draft = Omit<StudioGroup, 'lead' | 'waitingCount'> & { panes: Pane[], rows: IndividualAgentRow[] }
  const drafts = new Map<string, Draft>()
  const out: StudioHomeRow[] = []
  for (const row of expanded) {
    const pane = row.kind === 'pane' ? row.pane : null
    const studio = pane ? studioOf(pane) : null
    if (!pane || !studio) {
      out.push(row)
      continue
    }
    const machineKey = pane.machine || ''
    const session = pane.session || 'default'
    const key = `${session}:${machineKey}:${studio.id}`
    let draft = drafts.get(key)
    if (!draft) {
      const machine = machines.find(m => m.key === machineKey)
      draft = {
        kind: 'studio',
        key,
        machineKey,
        studioId: studio.id,
        title: studio.title,
        machineLabel: machine?.label || machineKey || 'local',
        session,
        rows: [],
        panes: [],
      }
      drafts.set(key, draft)
      out.push(draft as StudioGroup)
    }
    draft.rows.push(row.kind === 'pane' && 'individual' in row ? row as IndividualAgentRow : individualOf(pane))
    draft.panes.push(pane)
  }
  for (const draft of drafts.values()) {
    const group = draft as StudioGroup
    group.lead = leadPane(draft.panes)!
    group.waitingCount = draft.panes.filter(p => paneGroup(p) === 'blocked').length
  }
  return out
}

/** Same group object while its panes and presentation are unchanged. */
export function createStudioRowReuse() {
  const seen = new Map<string, StudioGroup>()
  return (rows: StudioHomeRow[]): StudioHomeRow[] => rows.map((row) => {
    if (!isStudioGroup(row)) return row
    const old = seen.get(row.key)
    if (old && old.title === row.title && old.machineLabel === row.machineLabel && old.session === row.session
      && old.panes.length === row.panes.length && old.panes.every((p, i) => p === row.panes[i])) return old
    if (seen.size > 300) seen.clear()
    seen.set(row.key, row)
    return row
  })
}
