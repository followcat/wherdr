import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSocketProbe } from '../app/utils/socketProbe'

describe('socket wake probes', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  function setup() {
    let socket = { readyState: 1, send: vi.fn() }
    const probe = createSocketProbe(() => socket)
    const reconnect = vi.fn(() => { socket = { readyState: 0, send: vi.fn() } })
    return { probe, reconnect, get socket() { return socket } }
  }
  it('shares one promise and ping across simultaneous healthy wakes', async () => {
    const s = setup()
    const first = s.probe.probe()
    expect(s.probe.probe()).toBe(first)
    const wakes = [1, 2, 3].map(() => s.probe.recover(s.reconnect))
    expect(s.socket.send).toHaveBeenCalledTimes(1)
    s.probe.pong(s.socket)
    await Promise.all(wakes)
    expect(await first).toBe(true)
    expect(s.reconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('replaces a silent socket only once for overlapping waiters', async () => {
    const s = setup()
    const wakes = [1, 2, 3].map(() => s.probe.recover(s.reconnect))
    await vi.advanceTimersByTimeAsync(1600)
    await Promise.all(wakes)
    expect(s.reconnect).toHaveBeenCalledTimes(1)
    // The replacement is still CONNECTING: leave it to its watchdog.
    await s.probe.recover(s.reconnect)
    expect(s.reconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels without reporting a network failure or retaining timers', async () => {
    const s = setup()
    const wake = s.probe.recover(s.reconnect)
    s.probe.cancel()
    await wake
    expect(s.reconnect).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('ignores late pongs from a replaced socket', async () => {
    const s = setup()
    const old = s.socket
    const first = s.probe.probe()
    s.reconnect()
    s.socket.readyState = 1
    const next = s.probe.probe()
    expect(await first).toBeNull()
    s.probe.pong(old)
    await vi.advanceTimersByTimeAsync(1600)
    expect(await next).toBe(false)
  })
  it('treats a send exception as a real failure', async () => {
    const s = setup()
    s.socket.send.mockImplementation(() => { throw new Error('offline') })
    await s.probe.recover(s.reconnect)
    expect(s.reconnect).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
