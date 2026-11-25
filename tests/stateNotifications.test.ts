import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { bindFunction } from './stateFunction'
import { isBacklotDaemonTerminal } from '../shared/backlotDaemon'

const source = readFileSync('server/utils/state.ts', 'utf8')
function coreDelivery(opts: {
  viewed?: boolean, allowed?: boolean, taskAgent?: boolean, coordinator?: { target: string, name: string },
  panes?: Array<Record<string, unknown>>, machines?: Array<Record<string, unknown>>
} = {}) {
  const pane = { id: 'w1:p1', coreAddress: 'm/t1', machine: 'k', workspace: 'w1', agent: 'claude', status: 'blocked', title: 'Example' }
  const pushSend = vi.fn(async () => 1)
  const notify = bindFunction(source, 'notifyCorePane', {
    notificationAllowed: async () => opts.allowed ?? true, isViewed: () => opts.viewed ?? false, notificationTitle: (s: string) => s, isBacklotDaemonTerminal,
    state: {
      workspaces: [{ id: 'w1', label: 'demo' }, { id: 'beefbeefbeefbeef~s7370', label: 'backlot-studio' }],
      panes: opts.panes ?? [pane],
      machines: opts.machines ?? [{ key: 'k', label: 'laptop' }, { key: '', label: 'Local' }],
    },
    isTaskAgent: async () => opts.taskAgent ?? false, coordinatorAt: async () => opts.coordinator,
    agentLabel: () => 'Claude', agentNotificationTitle: (kind: string, who: string) => ({ title: `${who} ${kind}`, titleFr: '' }), pushSend, log: () => {},
  })
  return { notify, pushSend }
}
it('pushes a core agent alert to every device, naming its machine', async () => {
  const d = coreDelivery()
  await d.notify('k', 'm/t1', 'needs-you')
  expect(d.pushSend).toHaveBeenCalledWith(expect.objectContaining({ title: 'laptop · Claude blocked', tag: 'pane-w1:p1', body: 'demo · Example', url: '/#/a/w1%3Ap1' }))
})
it('names a coordinator by its name, not its agent', async () => {
  const d = coreDelivery({ coordinator: { target: 'coordinator:CO', name: 'Pilot' } })
  await d.notify('k', 'm/t1', 'needs-you')
  expect(d.pushSend).toHaveBeenCalledWith(expect.objectContaining({ title: 'laptop · Pilot blocked' }))
})
it('pushes nothing for a viewed agent, a muted one or an unknown terminal', async () => {
  for (const [opts, address] of [[{ viewed: true }, 'm/t1'], [{ allowed: false }, 'm/t1'], [{}, 'm/other']] as const) {
    const d = coreDelivery(opts)
    await d.notify('k', address, 'finished')
    expect(d.pushSend).not.toHaveBeenCalled()
  }
})
it('leaves a project task\'s agent waiting for you to the grouped push of what waits for you', async () => {
  const d = coreDelivery({ taskAgent: true })
  await d.notify('k', 'm/t1', 'needs-you')
  expect(d.pushSend).not.toHaveBeenCalled()
  await d.notify('k', 'm/t1', 'finished')
  expect(d.pushSend).toHaveBeenCalledTimes(1)
})
it('disambiguates t1 across two sessions by (machineKey, address) with deterministic deep links', async () => {
  const secKey = 'beefbeefbeefbeef'
  const d = coreDelivery({
    panes: [
      { id: 'w1:p7431', coreAddress: 't1', machine: '', workspace: 'w1', agent: 'claude', status: 'blocked', title: 'Primary' },
      { id: `${secKey}~s7370:p7431`, coreAddress: 't1', machine: secKey, workspace: `${secKey}~s7370`, agent: 'codex', status: 'blocked', title: 'Director' },
      { id: `${secKey}~s7370:p7432`, coreAddress: 't2', machine: secKey, name: 'backlot-stage', backlotRole: 'stage', workspace: `${secKey}~s7370`, agent: 'claude', status: 'blocked', title: 'Stage' },
    ],
    machines: [
      { key: '', label: 'host-a', local: true },
      { key: secKey, baseKey: '', session: 'backlot', label: 'host-a', local: true },
    ],
  })
  await d.notify(secKey, 't1', 'needs-you')
  expect(d.pushSend).toHaveBeenCalledTimes(1)
  expect(d.pushSend).toHaveBeenCalledWith(expect.objectContaining({
    tag: `pane-${secKey}~s7370:p7431`,
    url: `/#/a/${encodeURIComponent(`${secKey}~s7370:p7431`)}`,
    body: 'backlot-studio · Director',
  }))
  await d.notify(secKey, 't2', 'needs-you')
  expect(d.pushSend).toHaveBeenCalledTimes(1)
})
