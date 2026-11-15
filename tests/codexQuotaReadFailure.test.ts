import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { localFs } from '../server/utils/fsx'

const state = vi.hoisted(() => ({ machines: [] as unknown[] }))
vi.mock('../server/utils/coreQuotaMachines', () => ({ coreQuotaMachines: async () => state.machines }))
vi.mock('../server/utils/coreAdminDeps', () => ({ coreAdminDeps: () => ({}) }))
import { forgetQuotas, readQuotas } from '../server/utils/quotas'

it('keeps the machine\'s last good Codex reading while its read fails, then takes the new account', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-read-failure-'))
  const now = new Date()
  const dir = path.join(home, '.codex/sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'rollout-test.jsonl')
  const write = (account: string, used: number) => fs.writeFileSync(file, [
    JSON.stringify({ type: 'session_meta', payload: { creator_account_id: account } }),
    JSON.stringify({ timestamp: now.toISOString(), payload: { rate_limits: { primary: { used_percent: used, window_minutes: 300 } } } }),
  ].join('\n'))
  let fail = false
  state.machines = [{
    key: 'host-a', label: 'Host A', home, local: false, status: 'online', info: () => ({}),
    fs: { ...localFs, statMany: async (files: string[]) => {
      if (fail && files.includes(file)) throw new Error('unreachable')
      return localFs.statMany(files)
    } },
  }]
  try {
    write('account-a', 52)
    expect((await readQuotas(true)).codex!.five!.used).toBe(52)
    write('account-b', 8)
    fail = true
    // The read failed: the last good reading stays, with its own age (WHR-337).
    expect((await readQuotas(true)).codex!.five!.used).toBe(52)
    fail = false
    expect((await readQuotas(true)).codex!.five!.used).toBe(8)
  } finally {
    state.machines = []
    forgetQuotas()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
