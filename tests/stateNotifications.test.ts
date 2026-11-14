import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { bindFunction } from './stateFunction'

const source = readFileSync('server/utils/state.ts', 'utf8')
function coreDelivery(opts: { viewed?: boolean, allowed?: boolean, taskAgent?: boolean, coordinator?: { target: string, name: string } } = {}) {
  const pane = { id: 'w1:p1', coreAddress: 'm/t1', machine: 'k', workspace: 'w1', agent: 'claude', status: 'blocked', title: 'Example' }
  const pushSend = vi.fn(async () => 1)
  const notify = bindFunction(source, 'notifyCorePane', {
    notificationAllowed: async () => opts.allowed ?? true, isViewed: () => opts.viewed ?? false, notificationTitle: (s: string) => s,
    state: { workspaces: [{ id: 'w1', label: 'demo' }], panes: [pane], machines: [{ key: 'k', label: 'laptop' }, { key: '', label: 'Local' }] },
    isTaskAgent: async () => opts.taskAgent ?? false, coordinatorAt: async () => opts.coordinator,
    agentLabel: () => 'Claude', agentNotificationTitle: (kind: string, who: string) => ({ title: `${who} ${kind}`, titleFr: '' }), pushSend, log: () => {},
  })
  return { notify, pushSend }
}
it('pushes a core agent alert to every device, naming its machine', async () => {
  const d = coreDelivery()
  await d.notify('m/t1', 'needs-you')
  expect(d.pushSend).toHaveBeenCalledWith(expect.objectContaining({ title: 'laptop · Claude blocked', tag: 'pane-w1:p1', body: 'demo · Example' }))
})
it('names a coordinator by its name, not its agent', async () => {
  const d = coreDelivery({ coordinator: { target: 'coordinator:CO', name: 'Pilot' } })
  await d.notify('m/t1', 'needs-you')
  expect(d.pushSend).toHaveBeenCalledWith(expect.objectContaining({ title: 'laptop · Pilot blocked' }))
})
it('pushes nothing for a viewed agent, a muted one or an unknown terminal', async () => {
  for (const [opts, address] of [[{ viewed: true }, 'm/t1'], [{ allowed: false }, 'm/t1'], [{}, 'm/other']] as const) {
    const d = coreDelivery(opts)
    await d.notify(address, 'finished')
    expect(d.pushSend).not.toHaveBeenCalled()
  }
})
it('leaves a project task\'s agent waiting for you to the grouped Decisions push', async () => {
  const d = coreDelivery({ taskAgent: true })
  await d.notify('m/t1', 'needs-you')
  expect(d.pushSend).not.toHaveBeenCalled()
  await d.notify('m/t1', 'finished')
  expect(d.pushSend).toHaveBeenCalledTimes(1)
})
