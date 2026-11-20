// A workspace member has no coordinator of its own: on the home tabs it shows
// where its workspace does, and its tasks' badges take its own color and a dashed border.
import { afterEach, expect, it } from 'vitest'
import type { Pane } from '#shared/types'
import { coordinators, isMemberBadge, paneBadge } from '~/composables/useCoordinators'
import { machineGroups, projectOnBarItem } from '~/composables/useMachineBar'

afterEach(() => { coordinators.value = []; machineGroups.value = [] })

it('places a member on its workspace\'s tab only, and badges its tasks in its color', () => {
  machineGroups.value = [{ id: 'work', name: 'Work', machines: ['host-a'] }, { id: 'home', name: 'Home', machines: ['host-b'] }]
  coordinators.value = [
    { project: 'WS', name: 'Workspace', machines: ['host-a'], workspace: { group: 'work', working: 0, waiting: [], members: [{ key: 'US', name: 'Users', color: 'green', working: 0, waiting: [] }] } },
    { project: 'ME', name: 'Mine', machines: ['host-b'] },
  ]
  expect(projectOnBarItem('US', 'work')).toBe(true)
  expect(projectOnBarItem('US', 'home')).toBe(false)
  expect(paneBadge({ id: 'p', task: 'US-2' } as Pane)).toEqual({ text: 'US-2', color: 'green' })
})

it('tells a member\'s key or task id (its badge dashed) from a workspace\'s or project\'s', () => {
  coordinators.value = [{ project: 'WS', name: 'Workspace', workspace: { working: 0, waiting: [], members: [{ key: 'PAY', label: 'PY', name: 'Pay', working: 0, waiting: [] }] } }, { project: 'ME', name: 'Mine' }]
  expect(['PY-3', 'PAY', 'PY', 'WS-1', 'ME', 'PAYX'].map(isMemberBadge)).toEqual([true, true, true, false, false, false])
})
