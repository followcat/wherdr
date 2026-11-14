// WHR-138: on herdr-core, a tab's menu offers a new tab like this one or chosen,
// rename and close; a space's menu offers close, except a project's own space.
// Both closes confirm with what stops, then close each terminal on its own.
import { afterEach, expect, it, vi } from 'vitest'
import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime'
import { readBody } from 'h3'
import { herdrState } from '~/composables/useHerdr'
import { answerConfirm, confirmState, renameAs, renameTarget, type MenuItem } from '~/composables/useUi'
import { paneWorkspaceItems, tabItems, workspaceItems } from '~/composables/useSpaces'
import type { Pane } from '#shared/types'

const { navigate, toast } = vi.hoisted(() => ({ navigate: vi.fn(), toast: vi.fn() }))
mockNuxtImport('navigateTo', () => navigate)
mockNuxtImport('toast', () => toast)

const closed: string[] = []
let failing = ''
registerEndpoint('/api/close', { method: 'POST', handler: async (e) => {
  const { pane_id } = await readBody<{ pane_id: string }>(e)
  if (pane_id === failing) throw createError({ statusCode: 500, statusMessage: 'terminal busy' })
  closed.push(pane_id)
  return { ok: true }
} })

const pane = (id: string, tab: string, extra: Partial<Pane> = {}): Pane => ({ id, coreAddress: `host/${id}`, workspace: 's1', tab, tabLabel: null, agent: null, name: null, label: null, status: null, title: '', cwd: '/project', agentSession: null, ...extra })
const setState = (panes: Pane[]) => {
  herdrState.value = { ok: true, panes, workspaces: [{ id: 's1', label: 'api', number: 1, status: null, worktree: false }],
    tabs: [...new Set(panes.map(p => p.tab))].map((id, i) => ({ id, workspace: 's1', label: `tab${i + 1}`, number: i + 1, layout: null })) } as never
}
const labels = (items: MenuItem[]) => items.map(i => i.label ?? (i.kind === 'separator' ? '—' : ''))
const pick = (items: MenuItem[], label: string) => items.find(i => i.label === label)!.run!()

afterEach(() => {
  herdrState.value = { ok: false, panes: [], workspaces: [] }
  closed.length = 0
  failing = ''
  toast.mockReset()
  renameTarget.value = null
  if (confirmState.open) answerConfirm(false)
})

it('tab menu: two clear new-tab entries, then rename and close', () => {
  setState([pane('p1', 't1', { agent: 'claude' })])
  expect(labels(tabItems('t1'))).toEqual(['New tab like this one', 'New tab…', '—', 'Rename tab', 'Close tab'])
  // Folder unknown: nothing to copy, only the sheet.
  setState([pane('p1', 't1', { cwd: null })])
  expect(labels(tabItems('t1'))[0]).toBe('New tab…')
  // Named in herdr-app's document: the terminal's name would not show, no rename.
  setState([pane('p1', 't1')])
  herdrState.value = { ...herdrState.value, tabs: herdrState.value.tabs!.map(t => ({ ...t, docName: true as const })) }
  expect(labels(tabItems('t1'))).not.toContain('Rename tab')
})

it('rename tab opens the rename sheet on its terminal, titled for a tab', () => {
  setState([pane('p1', 't1')])
  pick(tabItems('t1'), 'Rename tab')
  expect(renameTarget.value).toBe('p1')
  expect(renameAs.value).toBe('tab')
})

it('space menu: close space, except on a coordinator\'s or a task agent\'s space', () => {
  setState([pane('p1', 't1'), pane('p2', 't2')])
  expect(labels(workspaceItems('s1'))).toEqual(['New tab', '—', 'Close space'])
  // An agent's row: its "Space" group.
  expect(labels(paneWorkspaceItems(pane('p1', 't1'))).slice(1)).toEqual(['New tab', 'Close space'])
  for (const pm of [{ task: 'demo-1' }, { coordinator: true as const }]) {
    setState([pane('p1', 't1'), pane('p2', 't2', pm)])
    expect(labels(workspaceItems('s1'))).toEqual(['New tab'])
    expect(labels(paneWorkspaceItems(pane('p1', 't1'))).slice(1)).toEqual(['New tab'])
  }
})

it('close space: confirms the terminals and agents it stops, closes each, names one that failed', async () => {
  setState([pane('p1', 't1', { agent: 'claude' }), pane('p2', 't2'), pane('p3', 't3', { agent: 'codex' })])
  failing = 'p2'
  pick(workspaceItems('s1'), 'Close space')
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  expect(confirmState.message).toContain('Close space “api”? Its 3 terminals stop.')
  expect(confirmState.message).toContain('2 agents will be interrupted')
  expect(confirmState.action).toBe('Close space')
  answerConfirm(true)
  await vi.waitFor(() => expect(toast).toHaveBeenCalled())
  expect(closed).toEqual(['p1', 'p3'])
  expect(toast).toHaveBeenCalledWith(expect.stringMatching(/^“.+” could not be closed/), true)
})

it('close tab: closes only its terminals, after the same confirmation', async () => {
  setState([pane('p1', 't1', { agent: 'claude' }), pane('p2', 't2')])
  pick(tabItems('t1'), 'Close tab')
  await vi.waitFor(() => expect(confirmState.open).toBe(true))
  expect(confirmState.message).toContain('Close tab “tab1”? Its terminal stops.')
  expect(confirmState.message).toContain('1 agent will be interrupted')
  answerConfirm(true)
  await vi.waitFor(() => expect(closed).toEqual(['p1']))
})
