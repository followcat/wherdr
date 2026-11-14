import { existsSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { MIGRATION_GUIDE } from '../bin/lib/hc.mjs'

afterEach(() => vi.unstubAllGlobals())

// The server's first plugin: without HC_SOCKET it logs why and exits at startup.
async function plugin() {
  vi.stubGlobal('defineNitroPlugin', (setup: unknown) => setup)
  return await import('../server/plugins/0.hc-socket')
}

it('exits at startup with a log line naming HC_SOCKET when it is unset', async () => {
  const { requireHcSocket } = await plugin()
  const exit = vi.fn()
  const log = vi.fn()
  requireHcSocket({}, exit, log)
  expect(exit).toHaveBeenCalledWith(1)
  expect(log).toHaveBeenCalledOnce()
  expect(log.mock.calls[0]![0]).toMatch(/^wherdr: HC_SOCKET is not set: .*docs\/migrate-from-v2\.md/)
  // The guide it names is a real page.
  expect(existsSync(new URL(`../${MIGRATION_GUIDE}`, import.meta.url))).toBe(true)
})

it('starts normally when HC_SOCKET is set', async () => {
  const { requireHcSocket } = await plugin()
  const exit = vi.fn()
  const log = vi.fn()
  requireHcSocket({ HC_SOCKET: '/run/hc.sock' }, exit, log)
  expect(exit).not.toHaveBeenCalled()
  expect(log).not.toHaveBeenCalled()
})

it('wires process.exit as the Nitro plugin', async () => {
  const setup = (await plugin()).default as unknown as () => void
  vi.stubEnv('HC_SOCKET', '')
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    setup()
    expect(exit).toHaveBeenCalledWith(1)
    expect(error.mock.calls[0]![0]).toContain('HC_SOCKET')
  } finally {
    exit.mockRestore()
    error.mockRestore()
    vi.unstubAllEnvs()
  }
})
