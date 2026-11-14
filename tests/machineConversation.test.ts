import { describe, expect, it } from 'vitest'
import type { HerdrState } from '../shared/types'
import { conversationIn, machineConversation, readConversationMemory } from '../app/utils/machineConversation'

const s = {
  ok: true,
  machines: [{ key: '', status: 'online' }, { key: 'remote', status: 'online' }, { key: 'remote/review', baseKey: 'remote', status: 'online' }, { key: 'away', status: 'offline' }],
  workspaces: [{ id: 'local', machine: '' }, { id: 'remote', machine: 'remote' }, { id: 'review', machine: 'remote/review' }],
  panes: [{ id: 'local-agent', workspace: 'local' }, { id: 'remote-agent', workspace: 'remote' }, { id: 'coord', workspace: 'remote' }, { id: 'review-agent', workspace: 'review', tab: 'review-tab' }],
  tabs: [{ id: 'review-tab', workspace: 'review' }],
} as HerdrState
const groups = [{ id: '*group:work', name: 'Work', machines: ['away', 'remote', ''] }, { id: '*group:empty', name: 'Empty', machines: [] }]
const local = { pane: 'local-agent' }
const remote = { pane: 'remote-agent' }
const choose = (pick: string, memory = {}, current = local) => machineConversation(s, pick, groups, memory, current)

describe('conversation selection on the machine bar', () => {
  it('keeps All and a conversation that belongs to the new selection', () => {
    expect(choose('*')).toBeUndefined()
    expect(choose('')).toBeUndefined()
    expect(choose('*group:work')).toBeUndefined()
    expect(choose('remote', { remote: { pane: 'coord' } }, remote)).toBeUndefined()
  })
  it('restores independent device histories for machines and groups', () => {
    const memory = readConversationMemory(JSON.stringify({ remote, '*group:work': { tab: 'review-tab' }, '': local }))
    expect(choose('remote', memory)).toEqual(remote)
    expect(choose('*group:work', memory, { pane: 'missing' })).toEqual({ tab: 'review-tab' })
    expect(choose('', memory, remote)).toEqual(local)
  })
  it('opens the empty state for missing, deleted or moved history', () => {
    expect(choose('remote')).toBeNull()
    expect(choose('remote', { remote: { pane: 'deleted' } })).toBeNull()
    expect(choose('remote', { remote: local })).toBeNull()
    expect(choose('*group:work', {}, { pane: 'missing' })).toBeNull()
    expect(choose('*group:empty')).toBeNull()
    expect(choose('away')).toBeNull()
  })
  it('includes named sessions by the workspace base machine, including tab plans', () => {
    expect(conversationIn(s, { pane: 'review-agent' }, 'remote', groups)).toBe(true)
    expect(conversationIn(s, { tab: 'review-tab' }, 'remote', groups)).toBe(true)
    expect(conversationIn(s, { pane: 'local-agent' }, 'remote', groups)).toBe(false)
  })
  it('places a coordinator by its project\'s tab machines, not the machine it runs on (WHR-152)', () => {
    const st = { ...s, panes: s.panes.map(p => (p.id === 'coord' ? { ...p, coreAddress: 'remote/t1' } : p)) } as HerdrState
    const pinned = [{ terminal: 'remote/t1', tabMachines: ['', 'away'] }]
    // Runs on remote, pinned to a group of this machine and away: it stays open on those tabs only.
    expect(conversationIn(st, { pane: 'coord' }, '', groups, pinned)).toBe(true)
    expect(conversationIn(st, { pane: 'coord' }, 'remote', groups, pinned)).toBe(false)
    expect(machineConversation(st, '', groups, {}, { pane: 'coord' }, pinned)).toBeUndefined()
    // Pinned to every tab, and a plain agent on the same machine keeps its own place.
    expect(conversationIn(st, { pane: 'coord' }, 'away', groups, [{ terminal: 'remote/t1', tabMachines: null }])).toBe(true)
    expect(conversationIn(st, { pane: 'remote-agent' }, '', groups, pinned)).toBe(false)
  })
  it('ignores broken storage and invalid entries', () => {
    for (const raw of ['null', '[]', 'broken', '42']) expect(readConversationMemory(raw)).toEqual({})
    expect(readConversationMemory('{"remote":{"pane":"remote-agent"},"bad":7}')).toEqual({ remote })
  })
})
