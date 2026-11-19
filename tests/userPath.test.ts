import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { USER_PATH_SH, loginShellPath, mergePath, mergePathOn, pathFromEnvOutput, projectsEnvPath, userPath } from '../bin/lib/userpath.mjs'
import { servicePath } from '../bin/lib/commands.mjs'
import { enableLinger, lingerOn, systemdUnit } from '../bin/lib/service.mjs'

const tmp: string[] = []
afterEach(() => { for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true }) })
// A home with an agent in ~/.local/bin and ~/.bun/bin, and herdr-projects' record of the login PATH.
function home(record?: string) {
  const h = mkdtempSync(path.join(os.tmpdir(), 'wherdr-path-'))
  tmp.push(h)
  for (const d of ['.local/bin', '.bun/bin']) mkdirSync(path.join(h, d), { recursive: true })
  const agent = path.join(h, '.local/bin/claude')
  writeFileSync(agent, '#!/bin/sh\necho agent\n')
  chmodSync(agent, 0o755)
  if (record !== undefined) {
    mkdirSync(path.join(h, '.herdr-projects/data'), { recursive: true })
    writeFileSync(path.join(h, '.herdr-projects/data/env.json'), record)
  }
  return h
}

describe('mergePath', () => {
  it('keeps the first place of each folder, absolute folders only', () => {
    expect(mergePath('/a:/b', ['/b', '/c'], ':relative::/a/', '')).toBe('/a:/b:/c')
    expect(mergePath(undefined, null, '/x')).toBe('/x')
  })
})

describe('a Windows PATH (#870)', () => {
  const win = (PATH: string, first: string[] = []) => userPath({ env: { PATH }, home: 'C:/Users/test', first, exists: () => false, platform: 'win32' })

  it('keeps drive-letter and UNC folders, in order, with `first` in front', () => {
    expect(win('C:/Windows/System32;C:/Windows/System32/OpenSSH', ['C:/Runtime'])).toBe('C:/Runtime;C:/Windows/System32;C:/Windows/System32/OpenSSH')
    expect(win('C:\\Tools\\;relative;\\\\server\\share\\bin;"D:\\Program Files\\Git\\cmd";C:\\')).toBe('C:\\Tools;\\\\server\\share\\bin;D:\\Program Files\\Git\\cmd;C:\\')
  })

  it('counts folders that differ in case or slash as one', () => {
    expect(win('C:\\Windows\\System32;c:/windows/system32/;C:/Git', ['C:/WINDOWS/System32'])).toBe('C:/WINDOWS/System32;C:/Git')
  })

  it('falls back to the inherited PATH rather than an empty one', () => {
    expect(win('relative;also-relative')).toBe('relative;also-relative')
  })

  it('leaves a Unix PATH as it was', () => {
    expect(mergePathOn('linux', '/a:/b/', 'C:/x:/c')).toBe('/a:/b:/x:/c')
    expect(mergePathOn('linux', '/a:/b/', 'C:/x:/c')).toBe(mergePathOn('darwin', '/a:/b/', 'C:/x:/c'))
  })
})

describe('the user\'s PATH', () => {
  it('puts what herdr-projects recorded and the user folders that exist before the PATH it has', () => {
    const h = home(JSON.stringify({ at: 1, PATH: '/opt/agents/bin:/usr/bin', gh: [] }))
    const p = userPath({ env: { PATH: '/usr/bin:/bin' }, home: h }).split(':')
    expect(p.slice(0, 4)).toEqual(['/opt/agents/bin', '/usr/bin', path.join(h, '.local/bin'), path.join(h, '.bun/bin')])
    expect(p.indexOf('/bin')).toBeGreaterThan(p.indexOf(path.join(h, '.bun/bin')))
    expect(p).toContain(path.join(h, '.local/bin'))
    expect(p).toContain(path.join(h, '.bun/bin'))
    // Folders that do not exist are not added.
    expect(p).not.toContain(path.join(h, '.cargo/bin'))
    expect(new Set(p).size).toBe(p.length)
  })

  it('reads the record from HERDR_PROJECTS_DATA_DIR, and survives a missing or broken one', () => {
    const h = home('{broken')
    expect(projectsEnvPath({}, h)).toBe('')
    const data = path.join(h, 'elsewhere')
    mkdirSync(data)
    writeFileSync(path.join(data, 'env.json'), JSON.stringify({ PATH: '/srv/tools/bin' }))
    expect(projectsEnvPath({ HERDR_PROJECTS_DATA_DIR: data }, h)).toBe('/srv/tools/bin')
    expect(projectsEnvPath({}, path.join(h, 'nobody'))).toBe('')
  })

  it('finds an agent in ~/.local/bin from a systemd-like PATH', () => {
    const h = home()
    const PATH = userPath({ env: { PATH: '/usr/bin:/bin' }, home: h })
    expect(execFileSync('sh', ['-c', 'command -v claude'], { env: { PATH }, encoding: 'utf8' }).trim()).toBe(path.join(h, '.local/bin/claude'))
  })

  it('reads the PATH line of a login shell, whatever it prints before', () => {
    expect(pathFromEnvOutput('Welcome!\nHOME=/h\nPATH=/h/.local/bin:/usr/bin\nX=1')).toBe('/h/.local/bin:/usr/bin')
    expect(pathFromEnvOutput('nothing')).toBe('')
    const run = () => ({ status: 0, stdout: 'motd\nPATH=/from/login:/usr/bin\n' })
    expect(loginShellPath({ SHELL: '/bin/zsh' }, run)).toBe('/from/login:/usr/bin')
    expect(loginShellPath({ SHELL: '/bin/zsh' }, () => ({ status: 1, stdout: '' }))).toBe('')
    expect(loginShellPath({ SHELL: '/bin/zsh' }, () => { throw new Error('no shell') })).toBe('')
  })
})

describe('the login service', () => {
  it('runs with the runtime first, then the login shell\'s PATH, the recorded one and the user folders', () => {
    const h = home(JSON.stringify({ PATH: '/recorded/bin' }))
    const p = servicePath('/opt/node22/bin/node', { PATH: '/usr/bin' }, { home: h, login: '/login/bin:/usr/bin' }).split(':')
    expect(p.slice(0, 5)).toEqual(['/opt/node22/bin', '/login/bin', '/usr/bin', '/recorded/bin', path.join(h, '.local/bin')])
    const unit = systemdUnit({ runtime: '/opt/node22/bin/node', args: ['/w/bin/wherdr.mjs', 'run'], env: { PATH: p.join(':') }, log: '/w/wherdr.log' })
    expect(unit).toContain(`Environment="PATH=/opt/node22/bin:/login/bin:/usr/bin:/recorded/bin:`)
  })

  it('turns lingering on for the user, without sudo, and says when it is refused', () => {
    const calls: string[][] = []
    let linger = 'no'
    const run = (cmd: string, args: string[]) => {
      calls.push([cmd, ...args])
      if (args[0] === 'enable-linger') { linger = 'yes'; return { ok: true, out: '' } }
      return { ok: true, out: `${linger}\n` }
    }
    expect(enableLinger('alice', run)).toEqual({ ok: true, already: false })
    expect(calls).toContainEqual(['loginctl', 'enable-linger', 'alice'])
    expect(calls.every(c => c[0] !== 'sudo')).toBe(true)
    expect(enableLinger('alice', run)).toEqual({ ok: true, already: true })
    const refused = (_: string, args: string[]) => (args[0] === 'enable-linger' ? { ok: false, out: 'Access denied' } : { ok: true, out: 'no' })
    expect(enableLinger('bob', refused)).toEqual({ ok: false, already: false })
    expect(lingerOn('bob', () => ({ ok: false, out: '' }))).toBe(false)
  })
})

describe('the same over SSH (a shell that is not a login shell)', () => {
  it('puts the remote record, in its order, and the user folders before the shell\'s PATH', () => {
    const h = home(JSON.stringify({ at: 1, PATH: '/remote/agents:/usr/bin', gh: [] }))
    const out = execFileSync('sh', ['-c', `${USER_PATH_SH}printf %s "$PATH"`], { env: { HOME: h, PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).split(':')
    expect(out.slice(0, 3)).toEqual(['/remote/agents', '/usr/bin', path.join(h, '.local/bin')])
    expect(out).toContain(path.join(h, '.local/bin'))
    expect(new Set(out).size).toBe(out.length)
  })

  it('works without a record, and a record outside HOME', () => {
    const h = home()
    const data = path.join(h, 'd')
    mkdirSync(data)
    writeFileSync(path.join(data, 'env.json'), '{\n  "at": 1,\n  "PATH": "/pretty/bin",\n  "gh": []\n}\n')
    const run = (env: Record<string, string>) => execFileSync('sh', ['-c', `${USER_PATH_SH}printf %s "$PATH"`], { env: { HOME: h, PATH: '/bin', ...env }, encoding: 'utf8' })
    expect(run({})).toContain(path.join(h, '.bun/bin'))
    expect(run({ HERDR_PROJECTS_DATA_DIR: data }).split(':')).toContain('/pretty/bin')
  })
})

describe('one PATH over SSH and on this machine', () => {
  const SSHD_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  // Every POSIX shell this machine has, the remote `sh` being any of them.
  const SHELLS = ['/bin/sh', '/bin/dash', '/bin/bash', '/usr/bin/dash', '/usr/bin/bash'].filter(existsSync)
  const shIn = (shell: string, h: string, env: Record<string, string> = {}, cmd = 'printf %s "$PATH"') =>
    execFileSync(shell, ['-c', `${USER_PATH_SH}${cmd}`], { env: { HOME: h, PATH: SSHD_PATH, ...env }, encoding: 'utf8' })
  const sh = (h: string, env: Record<string, string> = {}, cmd?: string) => shIn('/bin/sh', h, env, cmd)
  const record = (h: string, text: string, dir = '.herdr-projects/data') => {
    mkdirSync(path.join(h, dir), { recursive: true })
    writeFileSync(path.join(h, dir, 'env.json'), text)
  }

  it('gives the same PATH as userPath for the same record, escapes and odd folders included', () => {
    const h = home()
    // Folders whose names JSON escapes, each with an agent in it.
    const odd = ['with "quote"', 'back\\slash', 'tab\there', 'café ünï 🐑'].map(n => path.join(h, n))
    odd.forEach((d, i) => { mkdirSync(d); writeFileSync(path.join(d, `agent${i}`), `#!/bin/sh\necho ${i}\n`, { mode: 0o755 }) })
    const records = [
      JSON.stringify({ at: 1, PATH: [...odd, '/opt/plain/bin', '/usr/bin'].join(':'), gh: [] }, null, 2),
      JSON.stringify({ PATH: odd.join(':') }),
      // Every escape JSON has, the optional ones too (\/, \uXXXX for any character, a surrogate pair).
      '{"PATH":"\\/opt\\/x\\u0041\\u00e9\\u20ac\\ud83d\\udc11\\b\\f\\r\\"\\\\:/y"}',
      // A relative folder, an empty one and a folder with a newline are left out by both.
      JSON.stringify({ PATH: `rel/bin::/opt/z/bin:/opt/line\nbreak:${path.join(h, 'trail')}\n` }),
      // Trimmed and without a trailing slash, as mergePath takes them, then each once.
      JSON.stringify({ PATH: ` /opt/sp/bin \t:/opt/sl/bin//:/opt/sl/bin:/:${path.join(h, '.local/bin')}/` }),
      '{broken', '{"at":1}',
    ]
    for (const text of records) {
      record(h, text)
      const want = userPath({ env: { PATH: SSHD_PATH }, home: h })
      for (const shell of SHELLS) expect(shIn(shell, h), `${shell}: ${text}`).toBe(want)
    }
    record(h, records[0]!)
    expect(sh(h, {}, odd.map((_, i) => `agent${i}`).join('; '))).toBe('0\n1\n2\n3\n')
  })

  it('picks the user\'s agent over an older system-wide one, as their login shell does', () => {
    const h = home()
    // An old copy in a system folder of the session's PATH (an old `npm -g`).
    const sys = path.join(h, 'sys-bin')
    mkdirSync(sys)
    writeFileSync(path.join(sys, 'claude'), '#!/bin/sh\necho old\n', { mode: 0o755 })
    for (const shell of SHELLS) expect(shIn(shell, h, { PATH: `${sys}:${SSHD_PATH}` }, 'claude'), shell).toBe('agent\n')
    expect(execFileSync('sh', ['-c', 'claude'], { env: { PATH: userPath({ env: { PATH: `${sys}:${SSHD_PATH}` }, home: h }) }, encoding: 'utf8' })).toBe('agent\n')
    // The recorded PATH keeps its order, before the session's.
    record(h, JSON.stringify({ PATH: `/opt/b/bin:${path.join(h, '.bun/bin')}:/opt/a/bin` }))
    expect(sh(h).split(':').slice(0, 4)).toEqual(['/opt/b/bin', path.join(h, '.bun/bin'), '/opt/a/bin', path.join(h, '.local/bin')])
  })

  it('adds nothing of a record it cannot decode', () => {
    const h = home()
    const plain = sh(h)
    for (const text of ['{"PATH":"/opt/a/bin', '{"PATH":"/a\\qb"}', '{"PATH":"/a\\u12"}', '{"PATH":"/a\\u0000b"}', '{"PATH":"/a\\ud800b"}', '{"PATH":"/a\\udc00b"}', 'not json', '{"PATH":""}']) {
      record(h, text)
      expect(sh(h)).toBe(plain)
    }
  })

  it('finds the record where HERDR_PROJECTS_HOME puts it, as herdr-projects does', () => {
    const h = home()
    record(h, '{"PATH":"/opt/board/bin"}', 'board/data')
    const env = { HERDR_PROJECTS_HOME: path.join(h, 'board') }
    expect(sh(h, env).split(':')).toContain('/opt/board/bin')
    expect(projectsEnvPath(env, h)).toBe('/opt/board/bin')
    expect(sh(h, env)).toBe(userPath({ env: { PATH: SSHD_PATH, ...env }, home: h }))
  })

  it('only splits and assigns the record: nothing in it is run or expanded', () => {
    const h = home()
    record(h, JSON.stringify({ PATH: '/opt/$(touch pwned)/bin:/opt/`touch pwned2`;touch pwned3:/b*n:/opt/~' }))
    const p = sh(h, {}, 'cd "$HOME" && printf %s "$PATH"').split(':')
    expect(p).toEqual(expect.arrayContaining(['/opt/$(touch pwned)/bin', '/opt/`touch pwned2`;touch pwned3', '/b*n', '/opt/~']))
    expect(['pwned', 'pwned2', 'pwned3'].filter(f => existsSync(path.join(h, f)))).toEqual([])
  })
})
