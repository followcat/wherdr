import { describe, expect, it } from 'vitest'
import type { MachineInfo, Pane } from '../shared/types'
import { readyLists, sortReady } from '../shared/spaces'
import {
  isBacklotDaemonPane,
  isStudioGroup,
  studioGroupRows,
  studioRoleTitle,
  studioRowGroup,
  withoutBacklotDaemons,
  type StudioHomeRow,
} from '../app/utils/studioGroups'

const pane = (id: string, over: Partial<Pane> = {}): Pane => ({
  id,
  machine: 'm1',
  workspace: 'w1',
  tab: 'w1:t1',
  tabLabel: null,
  agent: 'claude',
  name: null,
  label: null,
  status: 'idle',
  title: null,
  cwd: null,
  agentSession: null,
  coreAddress: id,
  ...over,
})
const rowOf = (p: Pane) => ({ kind: 'pane' as const, key: p.id, pane: p, lead: p, individual: true as const })
const machine: MachineInfo = { key: 'm1', label: 'Host A', local: false, status: 'online', error: null, session: 'work' }

describe('backlot daemon filtering', () => {
  it('recognizes stage and server daemons by name or role, and only them', () => {
    expect(isBacklotDaemonPane(pane('p1', { name: 'backlot-stage' }))).toBe(true)
    expect(isBacklotDaemonPane(pane('p2', { name: 'backlot-server' }))).toBe(true)
    expect(isBacklotDaemonPane(pane('p3', { labels: { 'backlot.role': 'stage' } }))).toBe(true)
    expect(isBacklotDaemonPane(pane('p4', { backlotRole: 'server' }))).toBe(true)
    expect(isBacklotDaemonPane(pane('p5', { backlotRole: 'producer' }))).toBe(false)
    expect(withoutBacklotDaemons([
      pane('keep', { backlotRole: 'producer' }),
      pane('drop', { backlotRole: 'stage' }),
    ]).map(p => p.id)).toEqual(['keep'])
  })
})

describe('studio groups', () => {
  const producer = pane('w1:p1', {
    backlotRole: 'producer',
    labels: { 'backlot.studio': 'acme-shop', 'backlot.role': 'producer', 'herdr.tab': 'producer' },
  })
  const actor = pane('w1:p2', {
    backlotRole: 'actor-t2-c1',
    labels: { 'backlot.studio': 'acme-shop', 'backlot.role': 'actor-t2-c1', 'herdr.tab': 'actor-b t2' },
    status: 'working',
  })

  it('groups every role of one studio and machine under the first role, leaving other rows alone', () => {
    const plain = rowOf(pane('w1:p0', { status: 'idle' }))
    const rows = studioGroupRows([plain, rowOf(producer), rowOf(actor)], [machine])
    expect(rows[0]).toBe(plain)
    const group = rows[1]
    expect(isStudioGroup(group)).toBe(true)
    if (!isStudioGroup(group)) throw new Error('not a studio group')
    expect(rows).toHaveLength(2)
    expect(group.key).toBe('m1:acme-shop')
    expect(group.title).toBe('acme-shop')
    expect(group.machineKey).toBe('m1')
    expect(group.machineLabel).toBe('Host A')
    expect(group.session).toBe('work')
    expect(group.rows.map(r => r.pane.id)).toEqual(['w1:p1', 'w1:p2'])
    expect(group.panes.map(p => p.id)).toEqual(['w1:p1', 'w1:p2'])
  })

  it('keeps the same studio on different machines in separate groups', () => {
    const remoteActor = pane('w1:p3', { ...actor, id: 'w1:p3', machine: 'm2' })
    const groups = studioGroupRows([rowOf(producer), rowOf(remoteActor)], [machine]).filter(isStudioGroup)
    expect(groups.map(g => g.key)).toEqual(['m1:acme-shop', 'm2:acme-shop'])
  })

  it('groups all Hollywood roles in one Hollywood group per machine, even without a studio label', () => {
    const h1 = pane('w1:h1', { backlotRole: 'hollywood', labels: { 'backlot.role': 'hollywood' } })
    const h2 = pane('w1:h2', { backlotRole: 'hollywood', labels: { 'backlot.role': 'hollywood' } })
    const rows = studioGroupRows([rowOf(h1), rowOf(h2)], [machine])
    expect(rows).toHaveLength(1)
    const group = rows[0]
    expect(isStudioGroup(group)).toBe(true)
    if (!isStudioGroup(group)) throw new Error('not a studio group')
    expect(group.key).toBe('m1:hollywood')
    expect(group.title).toBe('Hollywood')
    expect(group.panes).toHaveLength(2)
  })

  it('uses the most urgent role as lead and counts every waiting role', () => {
    const waiting = { ...actor, status: 'blocked' as const }
    const rows = studioGroupRows([rowOf(producer), rowOf(waiting)], [machine])
    const group = rows[0]
    expect(isStudioGroup(group)).toBe(true)
    if (!isStudioGroup(group)) throw new Error('not a studio group')
    expect(group.lead.id).toBe(waiting.id)
    expect(studioRowGroup(group)).toBe('blocked')
    expect(group.waitingCount).toBe(1)
  })

  it('takes part in ready unread/read lists and in recent and name sorting', () => {
    const doneActor = { ...actor, status: 'done' as const, stateSeq: 20 }
    const group = studioGroupRows([rowOf({ ...producer, status: 'done' as const, stateSeq: 3 }), rowOf(doneActor)], [machine])[0]
    const zulu = rowOf(pane('w1:z', { status: 'idle', stateSeq: 30, title: 'Zulu' }))
    const alpha = rowOf(pane('w1:a', { status: 'idle', stateSeq: 1, title: 'Alpha' }))
    const rows: StudioHomeRow[] = [zulu, group, alpha]
    expect(readyLists(rows, true)[0]).toEqual([group])
    expect(sortReady(rows, 'recent', r => isStudioGroup(r) ? r.title : r.lead.title || r.key).slice(0, 2)).toEqual([zulu, group])
    expect(sortReady(rows, 'name', r => isStudioGroup(r) ? r.title : r.lead.title || r.key)).toEqual([group, alpha, zulu])
  })

  it('titles actor rows from herdr.tab with the task after a middle dot', () => {
    expect(studioRoleTitle(actor)).toBe('actor-b · t2')
    expect(studioRoleTitle(producer)).toBe('producer')
  })
})
