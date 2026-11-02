// Claude Code on API billing (API key, Console credits): its status line carries
// no rate limits. wherdr tells that apart from "not set up" and "read failed",
// and shows a muted label instead of gauges.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasCommands } from './helpers/commands'
import type { Quotas } from '../shared/types'
import { claudeApiBilling, claudeSetupState, mergeQuotas, readClaude } from '../server/utils/quotas'
import { createShellFs, localFs } from '../server/utils/fsx'
import { claudeApiShown, claudeInstallCommand, claudeSuggestion, machineQuotaRows, quotaRows } from '../app/utils/quotas'

const hasPython = hasCommands('python3')
const bound = { version: 1, account: 'aaaaaaaaaaaaaaaa', at: 1 }
const limits = { five_hour: { used_percentage: 12, resets_at: 1 }, seven_day: { used_percentage: 40, resets_at: 2 } }
const ours = '#!/bin/sh\n# claude-account _wherdr total_api_duration_ms'
const wired = '{ "statusLine": { "command": "sh /h/.claude/wherdr-statusline.sh" } }'

describe('API billing detection', () => {
  it('subscription with limits: ok', () => {
    const status = { rate_limits: limits, _wherdr: bound }
    expect(claudeApiBilling(status)).toBe(false)
    expect(claudeSetupState({ status, account: true, statusline: null, settings: null })).toBe('ok')
  })

  it('API billing, snapshot without limits: api, with or without a fingerprint', () => {
    const status = { session_id: 's', cost: { total_api_duration_ms: 900 }, _wherdr: bound }
    expect(claudeApiBilling(status)).toBe(true)
    expect(claudeSetupState({ status, account: true, statusline: null, settings: null })).toBe('api')
    const anon = { ...status, _wherdr: { ...bound, account: null } }
    expect(claudeSetupState({ status: anon, account: false, statusline: ours, settings: wired })).toBe('api')
  })

  it('a gateway spend limit is not API billing; an unbound snapshot stays ok', () => {
    expect(claudeApiBilling({ rate_limits: { spend_limit: { used_percentage: 5 } }, _wherdr: bound })).toBe(false)
    expect(claudeSetupState({ status: { cwd: '/' }, account: false, statusline: null, settings: null })).toBe('ok')
  })

  it('not set up: missing; an older status line without a snapshot: outdated', () => {
    expect(claudeSetupState({ status: null, account: false, statusline: null, settings: null })).toBe('missing')
    expect(claudeSetupState({ status: null, account: false, statusline: ours, settings: wired })).toBe('pending')
    expect(claudeSetupState({ status: null, account: false, statusline: '# claude-account _wherdr', settings: wired })).toBe('outdated')
  })

  it('read failure: throws, so the machine gets no state at all', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-api-'))
    const refused = createShellFs(async () => ({ code: 255, stdout: Buffer.alloc(0), stderr: 'Connection closed' }), { statTtlMs: 0 })
    await expect(readClaude(refused, home)).rejects.toMatchObject({ code: 'unreachable' })
    const ok = createShellFs(async (script, args = []) => {
      const r = spawnSync('sh', ['-c', script, 'sh', ...args])
      return { code: r.status, stdout: r.stdout, stderr: r.stderr.toString('utf8') }
    }, { statTtlMs: 0 })
    await expect(readClaude(ok, home)).resolves.toEqual({ q: null, setup: 'missing' })
    const out = mergeQuotas([{ key: '', label: 'Server', claude: null, codex: null, setup: null }])
    expect(out.claudeSetup).toBeUndefined()
    fs.rmSync(home, { recursive: true, force: true })
  })

  it.skipIf(!hasPython)('status line: API snapshot after a response, back to subscription after the next exchange', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wherdr-api-'))
    try {
      const env = { PATH: process.env.PATH, HOME: home }
      execFileSync('sh', ['-c', claudeInstallCommand], { env, stdio: 'pipe' })
      fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'acct' } }))
      const run = (status: object) => execFileSync('sh', [path.join(home, '.claude/wherdr-statusline.sh')], { env, input: JSON.stringify(status) })
      const file = path.join(home, '.cache/herdr-web/claude-status.json')

      // No API response yet in the session: nothing is known, nothing written.
      run({ session_id: 'a', cost: { total_cost_usd: 0, total_api_duration_ms: 0 } })
      expect(fs.existsSync(file)).toBe(false)
      expect((await readClaude(localFs, home)).setup).toBe('pending')

      // API billing: response, no rate limits.
      run({ session_id: 'a', cost: { total_cost_usd: 0.4, total_api_duration_ms: 1200 } })
      const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
      expect(snap._wherdr.account).toMatch(/^[0-9a-f]{16}$/)
      expect(JSON.stringify(snap)).not.toContain('acct')
      expect(await readClaude(localFs, home)).toEqual({ q: null, setup: 'api' })

      // Switched to a subscription: the next exchange carries limits.
      run({ session_id: 'b', cost: { total_api_duration_ms: 300 }, rate_limits: { five_hour: { used_percentage: 30 } } })
      const sub = await readClaude(localFs, home)
      expect(sub.setup).toBe('ok')
      expect(sub.q!.five!.used).toBe(30)

      // Same subscription session, limits not passed this time: still a subscription.
      run({ session_id: 'b', cost: { total_api_duration_ms: 600 } })
      expect((await readClaude(localFs, home)).setup).toBe('ok')

      // Another session on API billing: api again.
      run({ session_id: 'c', cost: { total_api_duration_ms: 50 } })
      expect((await readClaude(localFs, home)).setup).toBe('api')
    } finally { fs.rmSync(home, { recursive: true, force: true }) }
  })
})

describe('API billing on the home screen', () => {
  const five = (used: number) => ({ used, resetsAt: 2000, minutes: 300 })
  const sub = { five: five(30), week: null, at: 5 }

  it('a single machine on API billing: label at the top, no gauge, no setup prompt', () => {
    const q: Quotas = { claude: null, codex: null, claudeSetup: [{ key: '', state: 'api', installable: true }] }
    expect(claudeApiShown(q, null)).toBe(true)
    expect(quotaRows(q)).toEqual([])
    expect(claudeSuggestion(q, '', true)).toBeNull()
    expect(claudeApiShown(q, null, ['claude'])).toBe(false)
  })

  it('subscription unchanged: no label', () => {
    const q: Quotas = { claude: sub, codex: null, claudeSetup: [{ key: '', state: 'ok', installable: true }] }
    expect(claudeApiShown(q, null)).toBe(false)
    expect(quotaRows(q).map(r => r.key)).toEqual(['claude'])
  })

  it('a subscription machine and an API machine: each under its own machine', () => {
    const q = mergeQuotas([
      { key: 'laptop', label: 'Laptop', claude: { ...sub, account: 'aaaaaaaaaaaaaaaa' }, codex: null, setup: { key: 'laptop', state: 'ok', installable: true } },
      { key: 'server', label: 'Server', claude: null, codex: null, setup: { key: 'server', state: 'api', installable: true } },
    ])
    expect(quotaRows(q)).toEqual([])
    expect(claudeApiShown(q, null)).toBe(false)
    expect(machineQuotaRows(q, 'laptop').map(r => r.q.five!.used)).toEqual([30])
    expect(claudeApiShown(q, 'laptop')).toBe(false)
    expect(machineQuotaRows(q, 'server')).toEqual([])
    expect(claudeApiShown(q, 'server')).toBe(true)
  })
})
