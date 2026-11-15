import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { machineQuotaRows, quotaLeft } from '../app/utils/quotas'
import { createShellFs, localFs } from '../server/utils/fsx'

const state = vi.hoisted(() => ({ machines: [] as unknown[] }))
vi.mock('../server/utils/coreQuotaMachines', () => ({ coreQuotaMachines: async () => state.machines }))
vi.mock('../server/utils/coreAdminDeps', () => ({ coreAdminDeps: () => ({}) }))
import { readQuotas } from '../server/utils/quotas'

const homes: string[] = []
afterEach(() => {
  state.machines = []
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it.each([
  { code: 255, failure: 'refused session', persistent: false },
  { code: 124, failure: 'timeout', persistent: false },
  { code: 255, failure: 'refused session', persistent: true },
  { code: 124, failure: 'timeout', persistent: true },
])('a $failure: a retry reads the fresh 98/98 file; failing for good, the machine keeps its last good 19/5 with its own age (persistent: $persistent)', async ({ code, persistent }) => {
  const now = Date.parse('2026-10-11T14:50:39Z')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now - 5 * 3600000)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const account = 'aaaaaaaaaaaaaaaa'
  const otherAccount = 'bbbbbbbbbbbbbbbb'
  const make = (key: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-read-failure-'))
    homes.push(home)
    fs.mkdirSync(path.join(home, '.cache/herdr-web'), { recursive: true })
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude/wherdr-statusline.sh'), '# legacy claude-account writer')
    return { key, label: key, home, fs: localFs, local: false, status: 'online', info: () => ({}) }
  }
  const primary = make('primary')
  const shared = make('shared')
  const other = make('other')
  const write = (m: typeof primary, fingerprint: string, five: number, week: number, at: number, expired = false) => {
    // The producer is deliberately unchanged: these are legacy, separate files.
    // All fingerprints are already stable; the login happened hours earlier.
    const file = path.join(m.home, '.cache/herdr-web/claude-status.json')
    fs.writeFileSync(file, JSON.stringify({ rate_limits: {
      five_hour: { used_percentage: five, resets_at: Date.parse(expired ? '2026-10-11T10:40:00Z' : '2026-10-11T15:40:00Z') / 1000 },
      seven_day: { used_percentage: week, resets_at: Date.parse('2026-10-16T09:00:00Z') / 1000 },
    } }))
    fs.utimesSync(file, at / 1000, at / 1000)
    const sidecar = path.join(m.home, '.cache/herdr-web/claude-account')
    fs.writeFileSync(sidecar, fingerprint)
    fs.utimesSync(sidecar, at / 1000, at / 1000)
  }
  let failures = 0
  const observed: number[][] = []
  primary.fs = createShellFs(async (script, args = []) => {
    if (args[0]?.endsWith('/claude-account') && failures > 0) {
      if (Number.isFinite(failures)) failures--
      return { code, stdout: Buffer.alloc(0), stderr: code === 255 ? 'Session open refused by peer' : 'SSH read timed out' }
    }
    const result = spawnSync('sh', ['-c', script, 'sh', ...args])
    if (args[0]?.endsWith('/claude-status.json') && result.stdout[0] === 123) {
      const { rate_limits: r } = JSON.parse(result.stdout.toString())
      observed.push([r.five_hour.used_percentage, r.seven_day.used_percentage])
    }
    return { code: result.status, stdout: result.stdout, stderr: result.stderr.toString() }
  }, { statTtlMs: 0 })
  state.machines = [primary, shared, other]
  write(primary, account, 3, 80, now - 5 * 3600000, true)
  write(shared, account, 3, 72, now - 394 * 60000, true)
  write(other, otherAccount, 11, 25, now - 5 * 3600000, true)
  const displayed = (q: Awaited<ReturnType<typeof readQuotas>>, key: string) => machineQuotaRows(q, key)
    .map(r => [quotaLeft(r.q.five!, Date.now()), quotaLeft(r.q.week!, Date.now())])
  expect(displayed(await readQuotas(true), primary.key)).toEqual([[97, 20]])
  // Five hours later the same fingerprints still identify both accounts.
  vi.setSystemTime(now - 6 * 60000)
  write(primary, account, 81, 95, now - 6 * 60000)
  write(other, otherAccount, 11, 25, now - 10 * 60000)
  // Seed precisely the successful reading the old lastRead fallback could retain.
  expect(displayed(await readQuotas(), primary.key)).toEqual([[19, 5]])
  write(primary, account, 98, 98, now)
  vi.setSystemTime(now)
  failures = persistent ? Infinity : 1
  const fresh = await readQuotas()
  // This proves that the new file was actually read before the account read failed.
  expect(observed.at(-1)).toEqual([98, 98])
  // Failing for good: the last good reading stays, with its own reading time
  // (the app shows `?` once it is past its window; WHR-337).
  expect(displayed(fresh, primary.key)).toEqual(persistent ? [[19, 5]] : [[2, 2]])
  if (persistent) expect(machineQuotaRows(fresh, primary.key)[0]!.q.at).toBe(now - 6 * 60000)
  expect(observed.slice(-2)).toEqual([[98, 98], [98, 98]])
  expect(console.warn).toHaveBeenCalledWith(expect.any(String), 'Claude quota read failed', {
    machine: primary.key, code: 'unreachable', attempt: 1, action: 'retry',
  })
  expect(displayed(fresh, other.key)).toEqual([[89, 75]])
  if (persistent) {
    for (const elapsed of [60000, 120000]) {
      vi.setSystemTime(now + elapsed)
      expect(displayed(await readQuotas(), primary.key)).toEqual([[19, 5]])
    }
  } else {
    expect(displayed(fresh, shared.key)).toEqual([[2, 2]])
    expect(machineQuotaRows(fresh, primary.key)[0]!.q.at).toBe(now)
  }
  expect(console.warn).toHaveBeenCalledTimes(persistent ? 6 : 1)
  failures = 0
  vi.setSystemTime(now + 180000)
  const recovered = await readQuotas()
  expect(displayed(recovered, primary.key)).toEqual([[2, 2]])
  expect(displayed(recovered, shared.key)).toEqual([[2, 2]])
  expect(machineQuotaRows(recovered, primary.key)[0]!.q.at).toBe(now)

  // A second fresh snapshot arrives 4 min 41 s later, while the shared
  // machine's expired file stays unchanged and ages from 394 to 398 minutes.
  const sharedFile = path.join(shared.home, '.cache/herdr-web/claude-status.json')
  const sharedStamp = fs.statSync(sharedFile).mtimeMs
  expect(Math.floor((now - sharedStamp) / 60000)).toBe(394)
  const next = Date.parse('2026-10-11T14:55:20Z')
  write(primary, account, 98, 98, next)
  vi.setSystemTime(next)
  const refreshed = await readQuotas()
  for (const key of [primary.key, shared.key]) {
    expect(displayed(refreshed, key)).toEqual([[2, 2]])
    expect(machineQuotaRows(refreshed, key)[0]!.q.at).toBe(next)
  }
  expect(fs.statSync(sharedFile).mtimeMs).toBe(sharedStamp)
  expect(Math.floor((next - sharedStamp) / 60000)).toBe(398)
  const old = JSON.parse(fs.readFileSync(sharedFile, 'utf8')).rate_limits
  expect([old.five_hour.used_percentage, old.seven_day.used_percentage]).toEqual([3, 72])
})
