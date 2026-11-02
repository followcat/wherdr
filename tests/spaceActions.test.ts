import { describe, expect, it } from 'vitest'
import { closeSummary, moveTargets, paneSpaceEntries, spaceCall, spaceResult, verifySpaceRename } from '../shared/spaceActions'
import { reduceSnapshot } from '../server/utils/snapshot'
import layouts from './fixtures/snapshot-layouts.json'
import { closeConfirm, paneCloseConfirm } from '../app/utils/spaceConfirm'

const R = 'abcd1234'

describe('spaceCall', () => {
  it('new tab: never any focus, cleaned label', () => {
    expect(spaceCall({ op: 'tab.create', workspace_id: 'w1', label: '  dev   api ' })).toEqual({
      machine: '', method: 'tab.create', params: { workspace_id: 'w1', label: 'dev api', focus: false },
    })
    expect(spaceCall({ op: 'tab.create', workspace_id: 'w2' }).params).toEqual({ workspace_id: 'w2', focus: false })
    // Folder of the new tab: absolute path only.
    expect(spaceCall({ op: 'tab.create', workspace_id: 'w2', cwd: '/home/user/dev' }).params).toEqual({ workspace_id: 'w2', cwd: '/home/user/dev', focus: false })
    expect(spaceCall({ op: 'tab.create', workspace_id: 'w2', cwd: '~/dev' }).params).toEqual({ workspace_id: 'w2', focus: false })
  })

  it('goes to the object\'s machine, with local IDs', () => {
    expect(spaceCall({ op: 'tab.close', tab_id: `${R}~w3:t2` })).toEqual({ machine: R, method: 'tab.close', params: { tab_id: 'w3:t2' } })
    expect(spaceCall({ op: 'workspace.close', workspace_id: `${R}~w3` })).toEqual({ machine: R, method: 'workspace.close', params: { workspace_id: 'w3' } })
  })

  it('rename: space or tab, name required and bounded', () => {
    expect(spaceCall({ op: 'workspace.rename', workspace_id: 'w1', label: 'api' }).params).toEqual({ workspace_id: 'w1', label: 'api' })
    expect(spaceCall({ op: 'tab.rename', tab_id: 'w1:t2', label: 'x'.repeat(80) }).params).toEqual({ tab_id: 'w1:t2', label: 'x'.repeat(60) })
    expect(() => spaceCall({ op: 'tab.rename', tab_id: 'w1:t2', label: '   ' })).toThrow(/empty name/)
  })

  it('split: right or down, without focus', () => {
    expect(spaceCall({ op: 'pane.split', pane_id: `${R}~w1:p2`, direction: 'down' })).toEqual({
      machine: R, method: 'pane.split', params: { target_pane_id: 'w1:p2', direction: 'down', focus: false },
    })
    expect(() => spaceCall({ op: 'pane.split', pane_id: 'w1:p2', direction: 'left' })).toThrow(/direction/)
    // Folder of the new pane: absolute only.
    expect(spaceCall({ op: 'pane.split', pane_id: 'w1:p2', direction: 'right', cwd: '/srv/app' }).params).toEqual({ target_pane_id: 'w1:p2', direction: 'right', cwd: '/srv/app', focus: false })
    expect(spaceCall({ op: 'pane.split', pane_id: 'w1:p2', direction: 'right', cwd: 'app' }).params).toEqual({ target_pane_id: 'w1:p2', direction: 'right', focus: false })
  })

  it('reorder: before another space of the same machine, or at the end, without focus', () => {
    expect(spaceCall({ op: 'workspace.move', workspace_id: `${R}~w3`, before_workspace_id: `${R}~w1` })).toEqual({
      machine: R, method: 'workspace.move_block', params: { workspace_ids: ['w3'], before_workspace_id: 'w1' },
    })
    expect(spaceCall({ op: 'workspace.move', workspace_id: 'w2', before_workspace_id: null })).toEqual({
      machine: '', method: 'workspace.move_block', params: { workspace_ids: ['w2'], before_workspace_id: null },
    })
    expect(() => spaceCall({ op: 'workspace.move', workspace_id: 'w2', before_workspace_id: `${R}~w1` })).toThrow(/another machine/)
    expect(() => spaceCall({ op: 'workspace.move', workspace_id: 'w2', before_workspace_id: 'w2' })).toThrow(/destination/)
    expect(() => spaceCall({ op: 'workspace.move', workspace_id: 'w2:p1', before_workspace_id: null })).toThrow(/invalid workspace/)
  })

  it('move: to a tab, a new tab of its space, a new space', () => {
    expect(spaceCall({ op: 'pane.move', pane_id: 'w1:p2', to: { tab_id: 'w2:t1' } }).params).toEqual({
      pane_id: 'w1:p2', destination: { type: 'tab', tab_id: 'w2:t1', split: 'right' }, focus: false,
    })
    expect(spaceCall({ op: 'pane.move', pane_id: `${R}~w4:p9`, to: 'new_tab' })).toEqual({
      machine: R, method: 'pane.move', params: { pane_id: 'w4:p9', destination: { type: 'new_tab', workspace_id: 'w4' }, focus: false },
    })
    expect(spaceCall({ op: 'pane.move', pane_id: 'w1:p2', to: 'new_workspace' }).params.destination).toEqual({ type: 'new_workspace' })
  })

  it('refuses a tab of another machine, unknown IDs or actions', () => {
    expect(() => spaceCall({ op: 'pane.move', pane_id: 'w1:p2', to: { tab_id: `${R}~w1:t1` } })).toThrow(/another machine/)
    expect(() => spaceCall({ op: 'pane.move', pane_id: 'w1:p2', to: 'ailleurs' })).toThrow(/destination/)
    expect(() => spaceCall({ op: 'tab.close', tab_id: 'w1' })).toThrow(/invalid tab/)
    expect(() => spaceCall({ op: 'workspace.close', workspace_id: '-oProxy' })).toThrow(/invalid workspace/)
    expect(() => spaceCall({ op: 'pane.zoom', pane_id: 'w1:p1' })).toThrow(/unknown action/)
    expect(() => spaceCall(null)).toThrow(/unknown action/)
  })
})

describe('spaceResult', () => {
  it('returns the created or moved IDs, prefixed for a remote machine', () => {
    const split = spaceCall({ op: 'pane.split', pane_id: `${R}~w1:p1`, direction: 'right' })
    expect(spaceResult(split, { type: 'pane_info', pane: { pane_id: 'w1:p2', tab_id: 'w1:t1' } })).toEqual({ pane_id: `${R}~w1:p2`, tab_id: `${R}~w1:t1` })
    const tab = spaceCall({ op: 'tab.create', workspace_id: 'w1' })
    expect(spaceResult(tab, { tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p3' } })).toEqual({ tab_id: 'w1:t2', pane_id: 'w1:p3' })
    const move = spaceCall({ op: 'pane.move', pane_id: 'w1:p2', to: 'new_workspace' })
    expect(spaceResult(move, { move_result: { pane: { pane_id: 'w2:p1', tab_id: 'w2:t1' } } })).toEqual({ pane_id: 'w2:p1', tab_id: 'w2:t1' })
    expect(spaceResult(spaceCall({ op: 'tab.close', tab_id: 'w1:t1' }), { type: 'ok' })).toEqual({})
  })
})

const pane = (id: string, tab: string, agent: string | null = null) => ({
  pane_id: id, workspace_id: tab.split(':')[0], tab_id: tab, agent, agent_status: agent ? 'idle' : 'unknown',
})
const panes = [pane('w1:p1', 'w1:t1', 'claude'), pane('w1:p2', 'w1:t1', 'codex'), pane('w1:p3', 'w1:t1'), pane('w1:p4', 'w1:t2'), pane('w2:p1', 'w2:t1'), pane('w2:p2', 'w2:t1'), pane('w3:p1', 'w3:t1')]
const state = reduceSnapshot({ ...layouts, panes })

describe('closeSummary', () => {
  it('counts the agents a close would stop', () => {
    const s = closeSummary(state.panes.filter(p => p.tab === 'w1:t1'))
    expect(s.agents.map(p => p.agent)).toEqual(['claude', 'codex'])
    expect(s.shells).toBe(1)
    expect(closeSummary(state.panes.filter(p => p.workspace === 'w3'))).toEqual({ agents: [], shells: 1 })
  })
})

describe('moveTargets', () => {
  it('the other tabs of the machine, those of its space first', () => {
    const t = moveTargets(state, 'w2:p1')
    expect(t.map(x => [x.tab_id, x.sameWorkspace])).toEqual([['w1:t1', false], ['w1:t2', false], ['w3:t1', false]])
    const u = moveTargets(state, 'w1:p4')
    expect(u.map(x => x.tab_id)).toEqual(['w1:t1', 'w2:t1', 'w3:t1'])
    expect(u[0]).toMatchObject({ label: 'dev', workspaceLabel: 'herdr-web', sameWorkspace: true, panes: 3 })
  })

  it('never to another machine', () => {
    const remote = reduceSnapshot({ ...layouts, panes }, R)
    const both = { workspaces: [...state.workspaces, ...remote.workspaces], tabs: [...state.tabs!, ...remote.tabs!], panes: [...state.panes, ...remote.panes] }
    expect(moveTargets(both, `${R}~w1:p4`).every(x => x.tab_id.startsWith(`${R}~`))).toBe(true)
    expect(moveTargets(both, 'w1:p4').some(x => x.tab_id.includes('~'))).toBe(false)
    expect(moveTargets(both, 'w9:p9')).toEqual([])
  })
})

describe('paneSpaceEntries', () => {
  it('new tab from any pane, even alone in its space', () => {
    // w3: a single tab, a single pane (agent card, direct agent view).
    expect(paneSpaceEntries(state, 'w3:p1')).toEqual(['tab.create', 'workspace.rename'])
  })

  it('tabs renamable and closable when the space has several', () => {
    expect(paneSpaceEntries(state, 'w1:p4')).toEqual(['tab.create', 'tab.rename', 'tab.close', 'workspace.rename', 'workspace.close'])
  })

  it('a single tab with several panes: the space closes, not the tab', () => {
    expect(paneSpaceEntries(state, 'w2:p2')).toEqual(['tab.create', 'workspace.rename', 'workspace.close'])
    expect(paneSpaceEntries(state, 'w9:p9')).toEqual([])
  })

  it('each action only once ("Rename space" is not duplicated)', () => {
    for (const p of state.panes) {
      const e = paneSpaceEntries(state, p.id)
      expect(new Set(e).size).toBe(e.length)
      expect(e.filter(x => x === 'workspace.rename')).toHaveLength(1)
    }
  })
})

describe('closeConfirm', () => {
  // French non-breaking spaces (« », : ?): compared as spaces.
  const fr = (_: string, b: string) => b.replace(/\u00a0/g, ' ')
  const en = (a: string) => a
  const tab = state.panes.filter(p => p.tab === 'w1:t1')

  it('names the agents that will be stopped', () => {
    const c = closeConfirm({ kind: 'tab', label: 'dev', panes: tab }, fr)
    expect(closeConfirm({ kind: 'tab', label: 'dev', panes: tab }, (_: string, b: string) => b).message).toContain('«\u00a0dev\u00a0»\u00a0?')
    expect(c.message).toBe('Fermer l’onglet « dev » ? 3 panneaux seront fermés. 2 agents y tournent : Claude, Codex. Ils seront arrêtés. Son terminal sera fermé aussi.')
    expect(c.action).toBe('Fermer et arrêter 2 agents')
    expect(closeConfirm({ kind: 'tab', label: 'dev', panes: tab }, en).action).toBe('Close and stop 2 agents')
  })

  it('warns when the last tab takes its space with it', () => {
    const c = closeConfirm({ kind: 'tab', label: '1', panes: state.panes.filter(p => p.workspace === 'w3'), lastTab: true, workspaceLabel: 'notes' }, fr)
    expect(c.message).toBe('Fermer l’onglet « 1 » ? C’est son dernier onglet : l’espace « notes » sera fermé aussi. 1 panneau sera fermé. Son terminal sera fermé.')
    expect(c.action).toBe('Fermer l’onglet')
  })

  it('space without agents, or with many agents', () => {
    expect(closeConfirm({ kind: 'workspace', label: 'api', panes: state.panes.filter(p => p.workspace === 'w2') }, en))
      .toEqual({ message: 'Close space “api”? 2 panes will close. Its 2 terminals will close.', action: 'Close space' })
    const many = ['claude', 'codex', 'claude', 'claude', 'codex'].map((a, i) => ({ ...tab[0]!, id: `w1:p${i}`, agent: a, name: `a${i}` }))
    const c = closeConfirm({ kind: 'workspace', label: 'x', panes: many }, fr)
    expect(c.message).toContain('5 agents y tournent : Claude « a0 », Codex « a1 », Claude « a2 » et 2 autres.')
    expect(c.action).toBe('Fermer et arrêter 5 agents')
  })

  it('names the tabs of a space and counts its panes', () => {
    const panes = state.panes.filter(p => p.workspace === 'w2')
    expect(closeConfirm({ kind: 'workspace', label: 'api', panes, tabs: ['main', 'logs'] }, en).message)
      .toBe('Close space “api”? Its 2 tabs (“main”, “logs”) and 2 panes will close. Its 2 terminals will close.')
    expect(closeConfirm({ kind: 'workspace', label: 'api', panes, tabs: ['main', 'logs', 'a', 'b'] }, fr).message)
      .toContain('Ses 4 onglets (« main », « logs », « a » et 1 autre) et 2 panneaux seront fermés.')
  })
})

describe('rename confirmation', () => {
  for (const kind of ['workspace', 'tab'] as const) {
    it(`${kind}: refuses an acknowledged rename without the requested name`, () => {
      const key = `${kind}_id`
      const id = kind === 'tab' ? 'w1:t1' : 'w1'
      const call = spaceCall({ op: `${kind}.rename`, [key]: id, label: 'new' })
      expect(() => verifySpaceRename(call, { [`${kind}s`]: [{ [key]: id, label: 'old' }] })).toThrow('Rename failed')
      expect(() => verifySpaceRename(call, {})).toThrow('Rename failed')
      expect(() => verifySpaceRename(call, { [`${kind}s`]: [{ [key]: id, label: 'new' }] })).not.toThrow()
    })
  }
})

describe('paneCloseConfirm', () => {
  const fr = (_: string, b: string) => b.replace(/\u00a0/g, ' ')
  const en = (a: string) => a
  const agent = { ...state.panes.find(p => p.agent === 'claude')!, name: 'review', label: null, stopped: undefined }
  const shell = { ...agent, agent: null, name: 'build' }
  const base = { process: { state: 'unknown' as const }, tabLabel: 'dev', workspaceLabel: 'api', tabPanes: 1, workspaceTabs: 1, closesTab: true, closesWorkspace: true }

  it('lone pane of its space: one close, the space goes too', () => {
    const c = paneCloseConfirm({ ...base, pane: agent }, en)
    expect(c.message).toBe('Close the conversation with Claude “review”? Claude “review” will be stopped. It is the last pane of space “api”: the space closes too.')
    expect(c.action).toBe('Close conversation')
    expect(paneCloseConfirm({ ...base, pane: agent }, fr).message).toContain('l’espace sera fermé aussi')
  })

  it('only pane of its tab: the tab goes, the other tabs stay', () => {
    const c = paneCloseConfirm({ ...base, pane: agent, workspaceTabs: 3, closesWorkspace: false }, en)
    expect(c.message).toContain('It is the only pane of tab “dev”: the tab closes too. The other 2 tabs of space “api” stay open.')
    expect(paneCloseConfirm({ ...base, pane: agent, workspaceTabs: 2, closesWorkspace: false }, fr).message)
      .toContain('L’autre onglet de l’espace « api » reste ouvert.')
  })

  it('does not repeat the agent kind for a pane named after it', () => {
    const unnamed = { ...agent, name: null, label: null, agent: 'omp' }
    expect(paneCloseConfirm({ ...base, pane: unnamed }, en).message).toMatch(/^Close the conversation with Omp\? Omp will be stopped\./)
  })

  it('pane among others: only it closes', () => {
    const c = paneCloseConfirm({ ...base, pane: shell, process: { state: 'running', command: 'npm test' }, tabPanes: 3, closesTab: false, closesWorkspace: false }, en)
    expect(c.message).toBe('Close the terminal “build” in space “api”? The running command “npm test” will be stopped. Only this pane closes: the other 2 panes of tab “dev” stay open.')
    expect(c.action).toBe('Close terminal')
    expect(paneCloseConfirm({ ...base, pane: shell, process: { state: 'idle' }, tabPanes: 2, closesTab: false, closesWorkspace: false }, en).message)
      .toBe('Close the terminal “build” in space “api”? Only this pane closes: the other pane of tab “dev” stays open.')
  })
})
