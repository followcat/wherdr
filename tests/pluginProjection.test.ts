import { describe, expect, it } from 'vitest'
import { coreState } from '../shared/coreState'
import type { CoreTerminal } from '../shared/coreInventory'
import type { MachineInfo } from '../shared/types'
import { projectAgents, projectMachines } from '../shared/clientPlugins'

const term = (address: string, extra: Partial<CoreTerminal> = {}): CoreTerminal => ({
  address,
  cwd: '/workspace/demo',
  state: 'live',
  ...extra,
})

describe('plugin projections (shared)', () => {
  it('projects PublicAgent entries with terminal labels and never exposes coreAddress, cwd, session, or socket paths', () => {
    const state = coreState([
      term('t1', {
        name: 'worker-1',
        title: 'Running tests',
        template: 'claude',
        status: { state: 'working' },
        labels: { 'wherdr.task': 'WHR-12', team: 'core' },
      }),
      term('box-a/t2', {
        template: 'codex',
        status: { state: 'idle' },
        labels: { 'herdr.title': 'Remote codex' },
      }),
      term('t3', {}),
    ], [{ name: 'box-a', state: 'connected' }])

    const agents = projectAgents(state.panes)
    const remoteMachine = state.machines!.find(m => !m.local)!
    expect(agents).toHaveLength(3)
    expect(agents[0]).toEqual({
      id: state.panes[0]!.id,
      machine: null,
      name: 'worker-1',
      title: 'Running tests',
      agent: 'claude',
      status: 'working',
      labels: { team: 'core', 'wherdr.task': 'WHR-12' },
    })
    expect(agents[1]).toEqual({
      id: state.panes[1]!.id,
      machine: remoteMachine.key,
      name: 'Remote codex',
      title: null,
      agent: 'codex',
      status: 'idle',
      labels: { 'herdr.title': 'Remote codex' },
    })
    expect(agents[2]).toEqual({
      id: state.panes[2]!.id,
      machine: null,
      name: null,
      title: null,
      agent: null,
      status: 'unknown',
      labels: {},
    })

    for (const a of agents) {
      expect(Object.keys(a).sort()).toEqual(['agent', 'id', 'labels', 'machine', 'name', 'status', 'title'])
      expect('coreAddress' in a).toBe(false)
      expect('cwd' in a).toBe(false)
      expect('agentSession' in a).toBe(false)
      expect('session' in a).toBe(false)
    }

    // Mutating returned PublicAgent or labels leaves source pane state untouched.
    agents[0]!.name = 'tampered'
    agents[0]!.labels['wherdr.task'] = 'TAMPERED'
    const fresh = projectAgents(state.panes)
    expect(fresh[0]!.name).toBe('worker-1')
    expect(fresh[0]!.labels['wherdr.task']).toBe('WHR-12')
    expect(state.panes[0]!.labels?.['wherdr.task']).toBe('WHR-12')
  })

  it('projects PublicMachine entries and copies each entry cleanly', () => {
    const raw: MachineInfo[] = [
      { key: '', label: 'macbook', local: true, status: 'online', error: null, session: 'default' },
      { key: 'srv-1', baseKey: 'srv', label: 'Server 1', local: false, status: 'connecting', error: 'retrying' },
    ]
    const machines = projectMachines(raw)
    expect(machines).toEqual([
      { id: '', groupKey: '', label: 'macbook', local: true, status: 'online' },
      { id: 'srv-1', groupKey: 'srv', label: 'Server 1', local: false, status: 'connecting' },
    ])
    for (const m of machines) {
      expect(Object.keys(m).sort()).toEqual(['groupKey', 'id', 'label', 'local', 'status'])
      expect('error' in m).toBe(false)
      expect('session' in m).toBe(false)
    }

    machines[1]!.label = 'tampered'
    expect(raw[1]!.label).toBe('Server 1')
    expect(projectMachines(raw)[1]!.label).toBe('Server 1')
  })
})
