import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { localFs } from '../server/utils/fsx'
import { machineQuotaRows } from '../app/utils/quotas'

const state = vi.hoisted(() => ({ machines: [] as unknown[] }))
vi.mock('../server/utils/coreQuotaMachines', () => ({ coreQuotaMachines: async () => state.machines }))
vi.mock('../server/utils/coreAdminDeps', () => ({ coreAdminDeps: () => ({}) }))
import { readQuotas } from '../server/utils/quotas'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true })
  state.machines = []
  vi.useRealTimers()
})

it('refreshes account membership after the TTL; a failed read keeps the newest good reading, never a delayed poll\'s', async () => {
  const now = Date.parse('2026-10-10T12:00:00Z')
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  let refuse = false
  let pause: (() => Promise<void>) | null = null
  const make = (key: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-refresh-'))
    homes.push(home)
    fs.mkdirSync(path.join(home, '.cache/herdr-web'), { recursive: true })
    return { key, label: key, home, local: true, info: () => ({}), fs: {
      ...localFs,
      readFile: async (p: string) => {
        const value = await localFs.readFile(p)
        if (key === 'server' && p.endsWith('claude-status.json') && pause) {
          const wait = pause
          pause = null
          await wait()
        }
        return value
      },
      statMany: async (ps: string[]) => {
        if (key === 'server' && refuse) throw new Error('unreachable')
        return localFs.statMany(ps)
      },
    } }
  }
  const server = make('server')
  const laptop = make('laptop')
  const desktop = make('desktop')
  state.machines = [server, laptop, desktop]
  const write = (m: typeof server, account: string, used: number, at: number, expired = false) => {
    fs.writeFileSync(path.join(m.home, '.cache/herdr-web/claude-status.json'), JSON.stringify({
      _wherdr: { version: 1, account, at },
      rate_limits: {
        five_hour: { used_percentage: used, resets_at: (now + (expired ? -2 : 1) * 3600000) / 1000 },
        seven_day: { used_percentage: used, resets_at: (now + 86400000) / 1000 },
      },
    }))
  }
  const a = 'aaaaaaaaaaaaaaaa'
  const b = 'bbbbbbbbbbbbbbbb'
  write(server, a, 81, now - 60000)
  write(laptop, a, 98, now)
  write(desktop, a, 3, now - 394 * 60000, true)
  expect((await readQuotas(true)).claude!.five!.used).toBe(98)
  write(server, b, 11, now + 1000)
  vi.setSystemTime(now + 31000)
  const changed = await readQuotas()
  expect(machineQuotaRows(changed, 'server')[0]!.q.five!.used).toBe(11)
  for (const key of ['laptop', 'desktop']) {
    const q = machineQuotaRows(changed, key)[0]!.q
    expect(q.five!.used).toBe(98)
    expect(q.week!.used).toBe(98)
    expect(q.at).toBe(now)
  }
  // A delayed poll started before a login change cannot repopulate the cache
  // after a later poll has already published the new account membership.
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  pause = () => { entered(); return gate }
  const oldPoll = readQuotas(true)
  await waiting
  write(server, a, 99, now + 32000)
  await readQuotas(true)
  release()
  await oldPoll
  const current = await readQuotas()
  expect(current.claudeAccounts).toBeUndefined()
  expect(current.claude!.five!.used).toBe(99)
  refuse = true
  const failed = await readQuotas(true)
  // A failed read keeps the machine's last good reading (WHR-337): the newest
  // one, never the delayed poll's older account.
  expect(failed.claudeAccounts).toBeUndefined()
  expect(failed.claude!.five!.used).toBe(99)
})
