import { describe, expect, it } from 'vitest'
import { checkoutMessage, planClose, widerClose } from '../app/utils/closeFlow'
import { spaceCall } from '../shared/spaceActions'
import type { HerdrState, Pane, Workspace } from '../shared/types'

const ws = (id: string, worktree: boolean): Workspace => ({ id, label: id, number: 1, status: null, worktree, repo: 'repo' })
const pane = (id: string, workspace: string): Pane => ({ id, workspace, tab: `${workspace}:t1`, tabLabel: '1', agent: null, name: null, label: null, status: null, title: null, cwd: '/tmp/repo', agentSession: null })
const state: HerdrState = {
  ok: true,
  workspaces: [ws('w1', false), ws('w2', true)],
  tabs: [
    { id: 'w1:t1', workspace: 'w1', label: '1', number: 1, layout: null },
    { id: 'w2:t1', workspace: 'w2', label: '1', number: 1, layout: null },
  ],
  panes: [pane('w1:p1', 'w1'), pane('w2:p1', 'w2')],
}
const tl = (_en: string, fr: string) => fr

describe('confirmation de fermeture du groupe', () => {
  it('closes the group when the last pane or tab of the main repository goes', () => {
    for (const [kind, id] of [['pane', 'w1:p1'], ['tab', 'w1:t1'], ['workspace', 'w1']] as const) {
      const plan = planClose(state, kind, id)
      expect(plan.group).toBe(true)
      expect(plan.workspaces.map(w => w.id)).toEqual(['w1', 'w2'])
    }
    expect(spaceCall({ op: 'tab.close', tab_id: 'w1:t1', close_group: true })).toEqual({
      machine: '', method: 'workspace.close', params: { workspace_id: 'w1', close_group: true },
    })
    expect(spaceCall({ op: 'tab.close', tab_id: 'a1b2c3d4~w1:t1', close_group: true })).toEqual({
      machine: 'a1b2c3d4', method: 'workspace.close', params: { workspace_id: 'w1', close_group: true },
    })
  })

  it('keeps the ordinary close for a linked checkout or a pane that is not the last', () => {
    expect(planClose(state, 'pane', 'w2:p1').group).toBe(false)
    const more = { ...state, panes: [...state.panes, pane('w1:p2', 'w1')] }
    expect(planClose(more, 'pane', 'w1:p1').group).toBe(false)
  })

  it('announces the kept files and the clean and modified states', () => {
    const clean = checkoutMessage([{ label: 'main', modified: 0, untracked: 0 }], false, tl)
    expect(clean).toContain('aucune modification')
    expect(clean).toContain('branches et les dossiers')
    const dirty = checkoutMessage([{ label: 'test', modified: 2, untracked: 1 }], true, tl)
    expect(dirty).toContain('groupe de worktrees')
    expect(dirty).toContain('2 fichier(s) modifié(s), 1 non suivi(s)')
    expect(dirty).toContain('modifications non commitées conservées')
  })
})

describe('close scope', () => {
  const two: HerdrState = {
    ok: true,
    workspaces: [{ ...ws('w9', false), repo: undefined }],
    tabs: [
      { id: 'w9:t1', workspace: 'w9', label: 'a', number: 1, layout: null },
      { id: 'w9:t2', workspace: 'w9', label: 'b', number: 2, layout: null },
    ],
    panes: [pane('w9:p1', 'w9'), pane('w9:p2', 'w9'), { ...pane('w9:p3', 'w9'), tab: 'w9:t2' }],
  }

  it('says which tabs and whether the space go with a pane', () => {
    expect(planClose(two, 'pane', 'w9:p1')).toMatchObject({ tabs: [], closesWorkspace: false, group: false })
    expect(planClose(two, 'pane', 'w9:p3')).toMatchObject({ tabs: ['w9:t2'], closesWorkspace: false })
    const lone = { ...two, panes: [two.panes[0]!], tabs: [two.tabs![0]!] }
    expect(planClose(lone, 'pane', 'w9:p1')).toMatchObject({ tabs: ['w9:t1'], closesWorkspace: true })
    expect(planClose(two, 'tab', 'w9:t1')).toMatchObject({ tabs: ['w9:t1'], closesWorkspace: false })
    expect(planClose(two, 'workspace', 'w9')).toMatchObject({ tabs: ['w9:t1', 'w9:t2'], closesWorkspace: true })
    expect(planClose(two, 'workspace', 'w9').panes).toHaveLength(3)
  })

  it('detects a close that grew while it was being confirmed', () => {
    const shown = planClose(two, 'pane', 'w9:p1')
    // The other pane of the tab closed meanwhile: the tab would go too.
    const alone = { ...two, panes: two.panes.filter(p => p.id !== 'w9:p2') }
    expect(widerClose(shown, planClose(alone, 'pane', 'w9:p1'))).toBe(true)
    // A pane added to the space: closing the space takes more.
    const space = planClose(two, 'workspace', 'w9')
    const more = { ...two, panes: [...two.panes, { ...pane('w9:p4', 'w9'), tab: 'w9:t2' }] }
    expect(widerClose(space, planClose(more, 'workspace', 'w9'))).toBe(true)
    // Unchanged, or narrower: no new confirmation.
    expect(widerClose(shown, planClose(two, 'pane', 'w9:p1'))).toBe(false)
    expect(widerClose(space, planClose({ ...two, panes: two.panes.slice(0, 2), tabs: [two.tabs![0]!] }, 'workspace', 'w9'))).toBe(false)
    // A worktree group appearing is always wider.
    expect(widerClose({ ...shown, group: false }, { ...shown, group: true })).toBe(true)
  })
})
