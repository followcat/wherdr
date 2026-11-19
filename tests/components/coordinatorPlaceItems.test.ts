// WHR-476: a project's or workspace's coordinator conversation's header ⋯ menu starts
// with its sidebar row's Open the board, Project/Workspace settings and Autopilot.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport } from '@nuxt/test-utils/runtime'
import { herdrState } from '~/composables/useHerdr'
import { coordinators, paneCoordinatorItems } from '~/composables/useCoordinators'
import { MAIN } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

const { navigate } = vi.hoisted(() => ({ navigate: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)
afterEach(() => { navigate.mockReset(); coordinators.value = [] })

const pane = (coreAddress: string) => ({ id: `w:${coreAddress}`, coreAddress, status: 'idle', agent: 'claude', workspace: 'w', tab: 't' }) as Pane

it('gives a coordinator pane its board, settings and autopilot; none to Alfred or a plain agent', () => {
  herdrState.value = { ok: true, workspaces: [], panes: [] }
  coordinators.value = [
    { project: MAIN, name: 'Alfred', main: true, terminal: 'm/t0' },
    { project: 'CO', name: 'co', terminal: 'm/t1', autopilot: { on: true } as never },
    { project: 'WS', name: 'ws', terminal: 'm/t2', workspace: { members: [] } as never },
  ]
  const co = paneCoordinatorItems(pane('m/t1'))
  expect(co.map(i => i.label ?? i.kind)).toEqual(['Open the board', 'Project settings', 'Autopilot', 'separator'])
  expect(co[2]!.desc).toBe('On')
  const ws = paneCoordinatorItems(pane('m/t2'))
  expect(ws.map(i => i.label ?? i.kind)).toEqual(['Open the board', 'Workspace settings', 'Autopilot', 'separator'])
  expect(ws[2]!.desc).toBe('Off')
  for (const i of ws.slice(0, 3)) i.run?.()
  expect(navigate.mock.calls.map(c => c[0])).toEqual(['/board?project=WS', '/settings?section=projects&project=WS&tab=general', '/settings?section=projects&project=WS&tab=autopilot'])
  expect(paneCoordinatorItems(pane('m/t0'))).toEqual([])
  expect(paneCoordinatorItems(pane('m/t9'))).toEqual([])
})
