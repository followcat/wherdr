// WHR-455: the repository folders a written path is also tried in.
import { describe, expect, it } from 'vitest'
import { repoDirs } from '../server/utils/writtenPlaces'

const H = '/home/demo'
const store = {
  enabled: async () => true,
  runs: async () => [
    { task: 'AB-1', machine: '', worktree: '~/wt/old', terminal: 't0', startedAt: 1 },
    { task: 'AB-1', machine: '', worktree: '~/wt/AB-1', terminal: 't1', startedAt: 2 },
  ],
  coordinators: async () => [{ project: 'WS', terminal: 'c1' }, { project: 'AB', terminal: 'c2' }],
  projects: async () => [
    { key: 'WS', kind: 'workspace', machine: '', path: '~/ws' },
    { key: 'AB', machine: '', path: '~/ab', workspace: 'WS' },
    { key: 'CD', machine: 'm2', path: '~/cd', workspace: 'WS' },
  ],
} as never

describe('repoDirs', () => {
  it('a task agent: its run\'s worktree', async () => {
    expect(await repoDirs({ task: 'AB-1', coreAddress: 't1' }, H, store)).toEqual(['/home/demo/wt/AB-1'])
  })
  it('a coordinator: its clone; a workspace\'s: its root then each member\'s clone on that machine', async () => {
    expect(await repoDirs({ coordinator: true, coreAddress: 'c2' }, H, store)).toEqual(['/home/demo/ab'])
    expect(await repoDirs({ coordinator: true, coreAddress: 'c1' }, H, store)).toEqual(['/home/demo/ws', '/home/demo/ab'])
  })
  it('any other agent: none', async () => {
    expect(await repoDirs({ coreAddress: 'x' }, H, store)).toEqual([])
  })
})
