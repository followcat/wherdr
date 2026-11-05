import { describe, expect, it } from 'vitest'
import type { Pane, Workspace } from '../shared/types'
import { cleanLabel, conversationSubtitle, coreOwnName, homeTitle, desktopHeaderTitle, spaceTitle } from '../shared/displayTitles'

const p: Pane = { id: 'w1:p1', workspace: 'w1', tab: 'w1:t1', tabLabel: 'agent', agent: 'claude', name: 'claude', label: null, status: 'idle', title: 'Customer portal brief', cwd: '/tmp/demo', agentSession: null }
const w: Workspace = { id: 'w1', label: 'Customer Portal 2', number: 1, status: null, worktree: false }

describe('titres du space', () => {
  it('always takes the space name for the title, including on a thread', () => {
    expect(spaceTitle(p, w)).toBe('Customer Portal 2')
    expect(spaceTitle({ ...p, name: 'hp-demo-t-0001-task', label: 'Pane renommé' }, w)).toBe('Customer Portal 2')
  })
  // herdr-projects 1.x (coordinator/co.rs): a coordinator's agent is named
  // sw-coordinator[-machine|-<repo>], in a tab named after it, in the home
  // folder's space ("~") or its repo's.
  it('names a herdr-projects coordinator by what it coordinates, not by its space', () => {
    const co = (name: string, tabLabel: string | null, space: string) => spaceTitle({ ...p, name, tabLabel }, { ...w, label: space })
    expect(co('sw-coordinator', 'Coordinator', '~')).toBe('Coordinator')
    expect(co('sw-coordinator-demo-app', 'demo-app coordinator', 'demo-app')).toBe('demo-app coordinator')
    expect(co('sw-coordinator-machine', 'devbox coordinator', '~')).toBe('devbox coordinator')
    expect(co('sw-coordinator-demo-app-2', 'demo-app coordinator', 'demo-app')).toBe('demo-app coordinator')
    // Its tab renamed: from its agent's name.
    expect(co('sw-coordinator', 'notes', '~')).toBe('Coordinator')
    expect(co('sw-coordinator-machine', null, '~')).toBe('Machine coordinator')
    expect(co('sw-coordinator-demo-app', null, 'demo-app')).toBe('demo-app coordinator')
    // Any other agent: its space's name.
    expect(co('claude', 'Coordinator', 'demo-app')).toBe('demo-app')
  })
  it('garde le sujet de conversation en secondaire', () => {
    expect(conversationSubtitle(p, w)).toBe('Customer portal brief')
  })
  it('hides redundant and generic titles', () => {
    expect(conversationSubtitle({ ...p, title: 'Customer Portal 2' }, w)).toBe('')
    expect(conversationSubtitle({ ...p, title: 'Claude Code' }, w)).toBe('')
    expect(conversationSubtitle({ ...p, title: 'claude' }, w)).toBe('')
  })
})

describe('cleanLabel', () => {
  it('drops herdr-projects invisible markers', () => {
    expect(cleanLabel('Wherdr\u2800')).toBe('Wherdr')
    expect(cleanLabel('Customer Portal\u28002\u2800')).toBe('Customer Portal 2')
    expect(cleanLabel('Wherdr\u200B')).toBe('Wherdr')
    expect(cleanLabel(null)).toBe('')
  })
})

describe('desktop header title', () => {
  it('shows the renamed pane', () => {
    expect(desktopHeaderTitle({ ...p, label: ' Review ' }, w, false)).toBe('Review')
    expect(desktopHeaderTitle({ ...p, label: 'Review' }, w, true)).toBe('Review')
  })
  it('keeps the space name when the pane was not renamed', () => {
    expect(desktopHeaderTitle(p, w, false)).toBe('Customer Portal 2')
  })
})

describe('coreOwnName', () => {
  it('keeps a given name and drops a name that is only the hc address', () => {
    expect(coreOwnName({ coreAddress: 'box/t2', label: 'Parser-agent-5' })).toBe('Parser-agent-5')
    expect(coreOwnName({ coreAddress: 't2', label: 't2' })).toBe('')
    expect(coreOwnName({ coreAddress: 'box/t3', label: 't3' })).toBe('')
    expect(coreOwnName({ coreAddress: undefined, label: 'legacy' })).toBe('')
  })
})

describe('homeTitle', () => {
  it('is the own name of a core terminal, else its space', () => {
    const core = { ...p, coreAddress: 'box/t4', label: 'Parser-agent-5' }
    expect(homeTitle(core, w)).toBe('Parser-agent-5')
    expect(homeTitle({ ...core, label: 't4' }, w)).toBe('Customer Portal 2')
    expect(homeTitle({ ...p, label: 'legacy' }, w)).toBe('Customer Portal 2')
  })
})
