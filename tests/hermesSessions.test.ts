import { execFileSync, spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HERMES_ENVIRON_SH, hermesHome, hermesNodeEnviron, hermesToolbarSession, hermesTuiSession, parseEnviron } from '../server/utils/hermesSessions'

const H = '/home/user'
const LOCAL = 'local-' + 'a'.repeat(64)
const STAMP = '20261117_101500_abc123'
const none = () => null
const FILE = '/tmp/hermes-tui-active-session-x1.json'

describe('hermesHome', () => {
  it('defaults to ~/.hermes', () => {
    expect(hermesHome({}, H, ['hermes'], none)).toBe(`${H}/.hermes/state.db`)
  })
  it('expands ~ and $VAR in HERMES_HOME; an undefined variable is unknown', () => {
    expect(hermesHome({ HERMES_HOME: '~/h' }, H, ['hermes'], none)).toBe(`${H}/h/state.db`)
    expect(hermesHome({ HERMES_HOME: '${D}/h', D: '/srv' }, H, ['hermes'], none)).toBe('/srv/h/state.db')
    expect(hermesHome({ HERMES_HOME: '$NOPE/h' }, H, ['hermes'], none)).toBeNull()
    expect(hermesHome({ HERMES_HOME: 'relative' }, H, ['hermes'], none)).toBeNull()
  })
  it('-p / --profile wins, under the root of HERMES_HOME', () => {
    expect(hermesHome({}, H, ['hermes', '-p', 'work'], () => 'other')).toBe(`${H}/.hermes/profiles/work/state.db`)
    expect(hermesHome({ HERMES_HOME: '/srv/profiles/a' }, H, ['hermes', '--profile=b'], none)).toBe('/srv/profiles/b/state.db')
    expect(hermesHome({}, H, ['hermes', '--profile', 'default'], () => 'work')).toBe(`${H}/.hermes/state.db`)
    expect(hermesHome({}, H, ['hermes', '-p', '../x'], none)).toBeNull()
    expect(hermesHome({}, H, ['hermes', '-p'], none)).toBeNull()
    expect(hermesHome({}, H, ['hermes', '--', '-p', 'work'], none)).toBe(`${H}/.hermes/state.db`)
  })
  it('trusts a HERMES_HOME already under profiles/<name> over the sticky profile', () => {
    expect(hermesHome({ HERMES_HOME: `${H}/.hermes/profiles/a` }, H, ['hermes'], () => 'b')).toBe(`${H}/.hermes/profiles/a/state.db`)
  })
  it('follows the sticky active_profile of the root', () => {
    const roots: string[] = []
    const read = (root: string) => (roots.push(root), '﻿work\n')
    expect(hermesHome({ HERMES_HOME: '/srv/h' }, H, ['hermes'], read)).toBe('/srv/h/profiles/work/state.db')
    expect(roots).toEqual(['/srv/h'])
    expect(hermesHome({}, H, ['hermes'], () => 'default')).toBe(`${H}/.hermes/state.db`)
    expect(hermesHome({}, H, ['hermes'], () => 'Bad Name')).toBeNull()
  })
})

describe('hermesTuiSession', () => {
  const env = (extra = {}) => ({ HERMES_TUI_ACTIVE_SESSION_FILE: FILE, ...extra })
  it('reads the session id the TUI wrote', () => {
    expect(hermesTuiSession(env(), () => JSON.stringify({ session_id: LOCAL }))).toBe(LOCAL)
    expect(hermesTuiSession(env(), () => JSON.stringify({ session_id: STAMP }))).toBe(STAMP)
  })
  it('falls back to HERMES_TUI_RESUME only while the file is empty', () => {
    expect(hermesTuiSession(env({ HERMES_TUI_RESUME: STAMP }), () => '')).toBe(STAMP)
    expect(hermesTuiSession(env(), () => '')).toBeNull()
    expect(hermesTuiSession(env({ HERMES_TUI_RESUME: 'nope' }), () => '')).toBeNull()
    expect(hermesTuiSession(env({ HERMES_TUI_RESUME: STAMP }), () => JSON.stringify({ session_id: LOCAL }))).toBe(LOCAL)
  })
  it('refuses other files, unreadable files, bad JSON and bad ids', () => {
    let read = 0
    const reader = () => (read++, JSON.stringify({ session_id: LOCAL }))
    expect(hermesTuiSession({}, reader)).toBeNull()
    expect(hermesTuiSession({ HERMES_TUI_ACTIVE_SESSION_FILE: 'hermes-tui-active-session-x.json' }, reader)).toBeNull()
    expect(hermesTuiSession({ HERMES_TUI_ACTIVE_SESSION_FILE: '/etc/passwd' }, reader)).toBeNull()
    expect(read).toBe(0)
    expect(hermesTuiSession(env(), () => null)).toBeNull()
    expect(hermesTuiSession(env(), () => '{"session_id"')).toBeNull()
    expect(hermesTuiSession(env(), () => '{"session_id":"local-abc"}')).toBeNull()
  })
})

describe('hermesToolbarSession', () => {
  it('reads a complete id on the last non-empty line', () => {
    expect(hermesToolbarSession(`> hi\n ☤ sonnet │ ${STAMP} \n\n`)).toBe(STAMP)
    expect(hermesToolbarSession(` ☤ claude-x │ ${LOCAL} `)).toBe(LOCAL)
  })
  it('gives null for a truncated, missing or earlier bar', () => {
    expect(hermesToolbarSession(` ☤ sonnet │ ${LOCAL.slice(0, 40)}`)).toBeNull()
    expect(hermesToolbarSession(` ☤ sonnet │ ${STAMP}\n> typing`)).toBeNull()
    expect(hermesToolbarSession(`id ${STAMP}`)).toBeNull()
    expect(hermesToolbarSession('')).toBeNull()
  })
})

describe('environ', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64')
  it('drops a variable set twice', () => {
    expect(parseEnviron('A=1\0B=x=y\0A=2\0')).toEqual({ B: 'x=y' })
  })
  it('keeps the single Node candidate on Linux only', () => {
    const one = `12 ${b64(`HERMES_TUI_ACTIVE_SESSION_FILE=${FILE}\0HOME=${H}\0`)}\n13 ${b64('PATH=/bin\0')}\n`
    expect(hermesNodeEnviron(one, 'linux')).toMatchObject({ HERMES_TUI_ACTIVE_SESSION_FILE: FILE })
    expect(hermesNodeEnviron(one, 'darwin')).toBeNull()
    const two = one + `14 ${b64(`HERMES_TUI_ACTIVE_SESSION_FILE=${FILE}\0`)}\n`
    expect(hermesNodeEnviron(two, 'linux')).toBeNull()
    expect(hermesNodeEnviron('', 'linux')).toBeNull()
  })
})

describe.runIf(process.platform === 'linux')('HERMES_ENVIRON_SH', () => {
  it('finds a real Node child of the launcher (Node 24+ comm is MainThread)', async () => {
    const node = JSON.stringify(process.execPath)
    const launcher = spawn('sh', ['-c', `${node} -e "setTimeout(() => {}, 10000)" & wait`], {
      env: { PATH: process.env.PATH, HERMES_TUI_ACTIVE_SESSION_FILE: FILE }, stdio: 'ignore',
    })
    try {
      let out = ''
      for (let i = 0; i < 50 && !out; i++) {
        await new Promise(r => setTimeout(r, 100))
        out = execFileSync('sh', ['-c', HERMES_ENVIRON_SH, 'sh', String(launcher.pid)], { encoding: 'utf8' })
      }
      expect(hermesNodeEnviron(out, 'linux')).toMatchObject({ HERMES_TUI_ACTIVE_SESSION_FILE: FILE })
    } finally {
      execFileSync('sh', ['-c', `pkill -P ${launcher.pid}; kill ${launcher.pid}`])
    }
  })
})
