import { describe, expect, it } from 'vitest'
import { reduceSnapshot } from './helpers/snapshot'
import layouts from './fixtures/snapshot-layouts.json'
import { paneCloseConfirm } from '../app/utils/spaceConfirm'

const pane = (id: string, tab: string, agent: string | null = null) => ({
  pane_id: id, workspace_id: tab.split(':')[0], tab_id: tab, agent, agent_status: agent ? 'idle' : 'unknown',
})
const panes = [pane('w1:p1', 'w1:t1', 'claude'), pane('w1:p2', 'w1:t1', 'codex'), pane('w1:p3', 'w1:t1'), pane('w1:p4', 'w1:t2'), pane('w2:p1', 'w2:t1'), pane('w2:p2', 'w2:t1'), pane('w3:p1', 'w3:t1')]
const state = reduceSnapshot({ ...layouts, panes })

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
