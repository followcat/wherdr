import { describe, expect, it } from 'vitest'
import { BAR_ALL, barMachineSelection, type MachineGroup } from '../app/utils/machineBar'
import { countsTotal, projectOnTab, projectTabMachines, tabCounts } from '../app/utils/projectTabs'
import { readProjectTabs } from '../shared/settings'

const groups: MachineGroup[] = [
  { id: '*group:personal', name: 'Personal', machines: ['', 'laptop'] },
  { id: '*group:work', name: 'Work', machines: ['devbox'] },
]
const home = { machines: [''] }
const mix = { machines: ['', 'devbox'] } // home in Personal, an allowed machine in Work
const loose = { machines: ['spare'] } // in no group
const on = (p: { machines: string[], paused?: string[], busy?: string[] }, pick: string, override?: string, gs = groups) =>
  projectOnTab(projectTabMachines(p, override, gs), barMachineSelection(pick, gs))

describe('project tabs', () => {
  it('automatic: shown on the tabs holding one of its machines, and on All', () => {
    expect(on(home, '*group:personal')).toBe(true)
    expect(on(home, '*group:work')).toBe(false)
    expect(on(home, BAR_ALL)).toBe(true)
  })

  it('multi-group: shown on each group holding one of its machines', () => {
    expect(on(mix, '*group:personal')).toBe(true)
    expect(on(mix, '*group:work')).toBe(true)
  })

  it('override group: shown on that group only, whatever its machines', () => {
    expect(on(mix, '*group:work', '*group:work')).toBe(true)
    expect(on(mix, '*group:personal', '*group:work')).toBe(false)
    expect(on(home, '*group:work', '*group:work')).toBe(true)
  })

  it('All tabs: shown on every tab', () => {
    expect(projectTabMachines(home, BAR_ALL, groups)).toBeNull()
    expect(on(loose, '*group:work', BAR_ALL)).toBe(true)
    expect(on(loose, 'laptop', BAR_ALL)).toBe(true)
  })

  it('automatic: a machine paused for the project counts only while one of its tasks runs there', () => {
    const paused = { machines: ['', 'devbox'], paused: ['devbox'] }
    expect(projectTabMachines(paused, undefined, groups)).toEqual([''])
    expect(on(paused, '*group:work')).toBe(false)
    expect(on({ ...paused, busy: ['devbox'] }, '*group:work')).toBe(true)
    expect(on(paused, '*group:work', '*group:work')).toBe(true) // a group picked still holds it
  })

  it('deleted group: back to automatic', () => {
    expect(projectTabMachines(home, '*group:gone', groups)).toEqual([''])
    expect(on(home, '*group:personal', '*group:gone')).toBe(true)
  })

  it('no group: shown on All and on its own machines\' tabs only', () => {
    expect(on(loose, BAR_ALL)).toBe(true)
    expect(on(loose, 'spare')).toBe(true)
    expect(on(loose, '*group:personal')).toBe(false)
    expect(on(home, '', undefined, [])).toBe(true)
    expect(on(home, 'laptop', undefined, [])).toBe(false)
  })

  it('machine tab: shown when the project may run there', () => {
    expect(on(mix, 'devbox')).toBe(true)
    expect(on(mix, 'laptop')).toBe(false)
    expect(on(mix, 'laptop', '*group:personal')).toBe(true)
  })

  it('reads the setting: group ids and All only', () => {
    expect(readProjectTabs('{"WHR":"*group:work","SITE":"*","BAD":"laptop","N":3}')).toEqual({ WHR: '*group:work', SITE: '*' })
    expect(readProjectTabs('[]')).toEqual({})
    expect(readProjectTabs('nope')).toEqual({})
    expect(readProjectTabs(null)).toEqual({})
  })
})

describe('tab counts', () => {
  // Agent rows by machine, then Alfred (every tab) and two project coordinators.
  const rows = [
    { base: '', group: 'working' as const },
    { base: 'laptop', group: 'blocked' as const },
    { base: 'devbox', group: 'ready' as const },
  ]
  const coordinators = [
    { tabMachines: null, group: 'ready' as const }, // Alfred
    { tabMachines: projectTabMachines(home, undefined, groups), group: 'blocked' as const }, // waiting for the user
    { tabMachines: projectTabMachines(mix, undefined, groups), group: 'working' as const }, // on both groups
  ]
  const tab = (pick: string) => tabCounts(rows, coordinators, barMachineSelection(pick, groups))

  it('counts the rows and coordinators the tab shows, a waiting coordinator in Your turn', () => {
    expect(tab(BAR_ALL)).toEqual({ blocked: 2, working: 2, ready: 2 })
    expect(tab('*group:personal')).toEqual({ blocked: 2, working: 2, ready: 1 })
    expect(tab('*group:work')).toEqual({ blocked: 0, working: 1, ready: 2 })
    expect(tab('laptop')).toEqual({ blocked: 1, working: 0, ready: 1 })
  })

  it('a tab badge is its counters total', () => {
    expect(countsTotal(tab(BAR_ALL))).toBe(6)
    expect(countsTotal(tab('*group:work'))).toBe(3)
  })
})
