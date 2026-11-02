import { afterEach, expect, it, vi } from 'vitest'
import { PANE_RE } from '../shared/ids'
import { HerdrError } from '../server/utils/herdr'

// Exercise the route's on-demand inspection without a live Herdr session.
async function preview(pane: string, call = vi.fn()) {
  vi.stubGlobal('defineApi', (fn: unknown) => fn)
  vi.stubGlobal('getQuery', () => ({ pane }))
  vi.stubGlobal('PANE_RE', PANE_RE)
  vi.stubGlobal('HerdrError', HerdrError)
  vi.stubGlobal('herdr', call)
  const { default: handler } = await import('../server/api/close-preview.get')
  return (handler as unknown as () => Promise<unknown>)()
}
afterEach(() => vi.unstubAllGlobals())

it.each(['w1:p2', 'a1b2c3d4~w1:p2'])('inspects the targeted pane with a bounded routed call: %s', async pane => {
  const call = vi.fn().mockResolvedValueOnce({ process_info: { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10 }] } }).mockResolvedValueOnce({ pane: { tokens: { wherdr_split_prompt: '10' } } })
  expect(await preview(pane, call)).toEqual({ state: 'idle' })
  expect(call).toHaveBeenNthCalledWith(1, 'pane.process_info', { pane_id: pane }, 3000)
  expect(call).toHaveBeenNthCalledWith(2, 'pane.get', { pane_id: pane }, 3000)
})
it('falls back to unknown on remote failure or unsupported process information', async () => {
  expect(await preview('w1:p2', vi.fn().mockRejectedValue(new Error('unavailable')))).toEqual({ state: 'unknown' })
  expect(await preview('w1:p2', vi.fn().mockResolvedValue({}))).toEqual({ state: 'unknown' })
})
it('rejects invalid pane IDs without inspecting a process', async () => {
  const call = vi.fn()
  await expect(preview('invalid', call)).rejects.toThrow('Invalid pane')
  expect(call).not.toHaveBeenCalled()
})

it('does not treat a lone shell running a builtin as idle', async () => {
  const call = vi.fn().mockResolvedValueOnce({ process_info: { shell_pid: 10, foreground_process_group_id: 10, foreground_processes: [{ pid: 10 }] } }).mockResolvedValueOnce({ pane: { tokens: {} } })
  expect(await preview('w1:p2', call)).toEqual({ state: 'unknown' })
})
