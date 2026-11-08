import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { KIND_PROBE_SCRIPT, USER_PATH_SETUP } from '../server/utils/agentAvailability'
import { kindsOf, PATH_SETUP, type CoreAdminDeps } from '../server/utils/coreCreate'

const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })

function bin(home: string, dir: string, ...names: string[]) {
  const d = path.join(home, dir)
  mkdirSync(d, { recursive: true })
  for (const name of names) {
    writeFileSync(path.join(d, name), '#!/bin/sh\nexit 0\n')
    chmodSync(path.join(d, name), 0o755)
  }
  return d
}

function home(...versions: string[]) {
  const h = mkdtempSync(path.join(os.tmpdir(), 'wherdr-agent-path-'))
  tmp.push(h)
  for (const v of versions) bin(h, `.nvm/versions/node/${v}/bin`, 'node')
  return h
}

function alias(h: string, target: string) {
  mkdirSync(path.join(h, '.nvm/alias'), { recursive: true })
  writeFileSync(path.join(h, '.nvm/alias/default'), target + '\n')
}

// A service-like machine PATH: the system tools the snippet shells out to,
// and nothing else — what a contributor's own ~/bin or /usr/bin holds stays
// out of the test.
function sysPath(h: string, ...extra: string[]) {
  const sys = path.join(h, 'sys')
  mkdirSync(sys, { recursive: true })
  for (const tool of ['sh', 'ls', 'sed', 'sort', 'tail']) {
    const real = execFileSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim()
    if (!existsSync(path.join(sys, tool))) symlinkSync(real, path.join(sys, tool))
  }
  return [sys, ...extra].join(':')
}

// The probe as machine.exec runs it, in a systemd-like environment.
function probe(h: string, envPath: string, env: Record<string, string>, ...commands: string[]) {
  return execFileSync('sh', ['-c', KIND_PROBE_SCRIPT, 'sh', ...commands], { env: { HOME: h, PATH: envPath, ...env }, encoding: 'utf8' }).split('\n').filter(Boolean)
}
const found = (h: string, envPath: string, command: string, env: Record<string, string> = {}) =>
  execFileSync('sh', ['-c', `${USER_PATH_SETUP}; command -v "$1"`, 'sh', command], { env: { HOME: h, PATH: envPath, ...env }, encoding: 'utf8' }).trim()

describe('the agent PATH on a machine', () => {
  it('finds an agent installed under the nvm default alias', () => {
    const h = home('v18.20.8', 'v24.19.0')
    bin(h, '.nvm/versions/node/v24.19.0/bin', 'claude')
    for (const target of ['v24.19.0', '24.19.0']) {
      alias(h, target)
      expect(probe(h, sysPath(h), {}, 'claude', 'codex')).toEqual(['claude'])
      expect(found(h, sysPath(h), 'claude')).toBe(path.join(h, '.nvm/versions/node/v24.19.0/bin/claude'))
    }
  })

  it('uses the newest installed version when there is no alias', () => {
    const h = home('v8.0.0', 'v18.20.8', 'v24.19.0', 'v24.6.0')
    bin(h, '.nvm/versions/node/v24.19.0/bin', 'codex')
    for (const v of ['v8.0.0', 'v18.20.8', 'v24.19.0', 'v24.6.0']) bin(h, `.nvm/versions/node/${v}/bin`, 'marker')
    expect(probe(h, sysPath(h), {}, 'codex', 'gemini')).toEqual(['codex'])
    expect(found(h, sysPath(h), 'marker')).toBe(path.join(h, '.nvm/versions/node/v24.19.0/bin/marker'))
  })

  it('honours NVM_DIR over ~/.nvm', () => {
    const h = home('v18.20.8')
    const nvmDir = path.join(h, 'nvm-elsewhere')
    bin(nvmDir, 'versions/node/v24.19.0/bin', 'claude')
    expect(probe(h, sysPath(h), { NVM_DIR: nvmDir }, 'claude', 'codex')).toEqual(['claude'])
    expect(found(h, sysPath(h), 'claude', { NVM_DIR: nvmDir })).toBe(path.join(nvmDir, 'versions/node/v24.19.0/bin/claude'))
    // Without NVM_DIR, ~/.nvm is used and its older version has no claude.
    expect(probe(h, sysPath(h), {}, 'claude')).toEqual([])
  })

  it('falls back to the newest version when the alias names none', () => {
    const h = home('v18.20.8', 'v24.19.0')
    bin(h, '.nvm/versions/node/v24.19.0/bin', 'claude')
    for (const target of ['v99.0.0', 'lts/*', 'node']) {
      alias(h, target)
      expect(found(h, sysPath(h), 'claude'), target).toBe(path.join(h, '.nvm/versions/node/v24.19.0/bin/claude'))
    }
  })

  it('keeps finding agents in the user folders without nvm', () => {
    const h = home()
    bin(h, '.local/bin', 'codex')
    bin(h, '.opencode/bin', 'opencode')
    expect(probe(h, sysPath(h), {}, 'claude', 'codex', 'opencode')).toEqual(['codex', 'opencode'])
    expect(found(h, sysPath(h), 'codex')).toBe(path.join(h, '.local/bin/codex'))
    expect(found(h, sysPath(h), 'opencode')).toBe(path.join(h, '.opencode/bin/opencode'))
  })

  it('still sees what the machine PATH has, and the launch line finds the same program', () => {
    const h = home('v24.19.0')
    const outside = bin(h, 'elsewhere', 'devin')
    bin(h, '.nvm/versions/node/v24.19.0/bin', 'claude')
    const envPath = sysPath(h, outside)
    const run = (script: string) => execFileSync('sh', ['-c', script, 'sh', 'claude', 'devin'], { env: { HOME: h, PATH: envPath }, encoding: 'utf8' })
    expect(run(`${USER_PATH_SETUP}; for cmd do command -v "$cmd" || echo missing "$cmd"; done`).split('\n').filter(Boolean))
      .toEqual([path.join(h, '.nvm/versions/node/v24.19.0/bin/claude'), path.join(outside, 'devin')])
    // The probe and the launch line share one snippet: they never disagree.
    expect(run(`${KIND_PROBE_SCRIPT}`).split('\n').filter(Boolean)).toEqual(['claude', 'devin'])
    expect(PATH_SETUP).toBe(USER_PATH_SETUP)
    expect(run(`${PATH_SETUP}; command -v claude`).trim()).toBe(path.join(h, '.nvm/versions/node/v24.19.0/bin/claude'))
  })
})

describe('the availability probe', () => {
  it('lists an agent that only exists under nvm', async () => {
    const h = home('v24.19.0')
    bin(h, '.nvm/versions/node/v24.19.0/bin', 'claude')
    const envPath = sysPath(h)
    // machine.exec answered by running the script for real, in a service-like environment.
    const deps = {
      call: async (method: string, params: object) => {
        const argv = (params as { argv?: string[] }).argv
        if (method !== 'machine.exec' || !argv) throw new Error(`unexpected ${method}`)
        const r = spawnSync(argv[0]!, argv.slice(1), { env: { HOME: h, PATH: envPath }, encoding: 'utf8' })
        return { code: r.status, stdout: Buffer.from(r.stdout || '').toString('base64') } as never
      },
      machines: () => [], panes: () => [], workspaces: () => [],
      settle: async () => {}, recent: async () => [], remember: async () => {},
    } satisfies CoreAdminDeps
    expect(await kindsOf(deps, `test-${Date.now()}`)).toEqual(['claude'])
  })
})
