import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.exec }) }
})
import { tailnetFacts } from '../bin/lib/tailnet.mjs'

beforeEach(() => { vi.useFakeTimers(); mocks.exec.mockReset() })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const status = JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.90.1.2'] }, Peer: {} })

it('finishes both slow CLI reads inside the handshake window', async () => {
  mocks.exec.mockImplementation((_bin, args) => new Promise(resolve => {
    setTimeout(() => resolve({ stdout: args[0] === 'status' ? status : '{}' }), 3500)
  }))
  let facts: unknown
  void tailnetFacts(7683, '/fake/tailscale', null).then(value => { facts = value })
  await vi.advanceTimersByTimeAsync(3500)
  expect(facts).toMatchObject({ readable: true, running: true, funnel: false })
})

it.each(['status', 'serve'])('keeps a silent %s read unknown after its deadline', async silent => {
  mocks.exec.mockImplementation((_bin, args, opts) => args[0] === silent
    ? new Promise((_resolve, reject) => { setTimeout(() => reject(new Error('Timed out')), opts.timeout) })
    : Promise.resolve({ stdout: args[0] === 'status' ? status : '{}' }))
  let facts: unknown
  void tailnetFacts(7683, '/fake/tailscale', null).then(value => { facts = value })
  await vi.advanceTimersByTimeAsync(4499)
  expect(facts).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(facts).toMatchObject({ readable: silent !== 'status', funnel: null })
})
