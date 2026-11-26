import { describe, expect, it } from 'vitest'
import { CMD_ALIASES, CMD_ENTRYPOINT_RE, CMD_GENERIC_TITLES, canonicalCmdAgent, cmdProgramFromArgv, isCmdAlias, isCmdEntrypoint } from '../shared/cmdAliases'

describe('Command Code names', () => {
  it('names the agent from a declared kind, whatever its spelling', () => {
    for (const raw of ['cmd', 'CMD', ' cmd ', 'command-code', 'Command-Code', 'command_code', 'COMMANDCODE', 'cmdc', 'Command Code'])
      expect(canonicalCmdAgent(raw), raw).toBe('cmd')
  })

  it('leaves the Windows shell and every other kind alone', () => {
    for (const raw of ['cmd.exe', 'CMD.EXE', 'claude', 'codex', 'command-codes', 'command_code_x', '', ' ', null, undefined])
      expect(canonicalCmdAgent(raw), String(raw)).toBeNull()
  })

  it('accepts only its own aliases, never a path nor the shell', () => {
    for (const name of CMD_ALIASES) expect(isCmdAlias(name.toLocaleUpperCase()), name).toBe(true)
    for (const name of ['cmd', 'cmd.exe', '/usr/bin/cmd', 'command-code/x', 'claude', 'commandcode2', '', null, undefined])
      expect(isCmdAlias(name), String(name)).toBe(false)
  })

  it('accepts the package entrypoints only', () => {
    for (const entrypoint of [
      '/usr/lib/node_modules/command-code/dist/cli.mjs',
      '/opt/command-code/dist/index.mjs',
      '/opt/command-code/bin/cmd',
      'C:\\Users\\alice\\AppData\\Roaming\\npm\\node_modules\\command-code\\bin\\cmdc',
      '/x/command-code/bin/commandcode',
      '/x/command-code/bin/command_code',
      '/x/command-code/bin/command-code',
    ]) expect(isCmdEntrypoint(entrypoint), entrypoint).toBe(true)
  })

  it('refuses a bare cmd and every lookalike of the package path', () => {
    for (const path of [
      'cmd', 'cmd.exe', '/usr/bin/cmd', '/usr/local/bin/cmd.exe',
      '/opt/command-code/index.js', '/srv/command-code/tools/build.js',
      'command-code/dist/cli.mjs', '/opt/my-command-code/bin/cmd',
      '/srv/command-code/dist/cli.mjs/extra', '', null, undefined,
    ]) expect(isCmdEntrypoint(path), String(path)).toBe(false)
  })
})

describe('Command Code behind a launch argv', () => {
  it('recognizes its own program and the package entrypoint', () => {
    expect(cmdProgramFromArgv(['command-code'])).toBe('cmd')
    expect(cmdProgramFromArgv(['cmdc', '--resume', 'session-a'])).toBe('cmd')
    expect(cmdProgramFromArgv(['/usr/local/bin/command_code'])).toBe('cmd')
    expect(cmdProgramFromArgv(['/opt/command-code/bin/cmd'])).toBe('cmd')
  })

  it('recognizes a runner or an interpreter that runs the package', () => {
    expect(cmdProgramFromArgv(['npx', 'command-code'])).toBe('cmd')
    expect(cmdProgramFromArgv(['npx', '-y', 'cmdc'])).toBeNull() // options before the package: unproven
    expect(cmdProgramFromArgv(['bunx', 'cmdc'])).toBe('cmd')
    expect(cmdProgramFromArgv(['bunx', '/opt/command-code/bin/cmd'])).toBe('cmd')
    expect(cmdProgramFromArgv(['node', '/usr/lib/node_modules/command-code/dist/cli.mjs'])).toBe('cmd')
    expect(cmdProgramFromArgv(['/usr/bin/node', '/opt/command-code/bin/command-code'])).toBe('cmd')
    expect(cmdProgramFromArgv(['bun', '/opt/command-code/dist/index.mjs'])).toBe('cmd')
    expect(cmdProgramFromArgv(['deno', '/opt/command-code/bin/cmdc'])).toBe('cmd')
  })

  it('never takes a word that only mentions it for the agent', () => {
    const others: (readonly string[] | null | undefined)[] = [
      [], ['cmd'], ['cmd.exe'], ['cmd', '/c', 'dir'], ['/usr/bin/cmd'], ['/usr/local/bin/cmd.exe'],
      ['vim', 'cmd'], ['ls', 'cmd'], ['git', 'log', '--grep=cmd'],
      ['node', 'build.js', 'cmd'], ['sh', '-c', 'cmd'], ['npx', 'vim', 'cmd'],
      ['node', '/srv/command-code/tools/build.js'], ['python', '/opt/command-code/dist/index.mjs'],
      null, undefined,
    ]
    for (const argv of others) expect(cmdProgramFromArgv(argv), JSON.stringify(argv)).toBeNull()
  })
})

describe('the generic titles of Command Code', () => {
  it('covers every name the agent goes by, and nothing else', () => {
    expect([...CMD_GENERIC_TITLES].sort()).toEqual(['cmd', 'cmdc', 'command code', 'command-code', 'command_code', 'commandcode'])
    expect(CMD_ALIASES.every(name => CMD_GENERIC_TITLES.includes(name))).toBe(true)
    expect(CMD_ENTRYPOINT_RE.test('/opt/command-code/bin/cmd')).toBe(true)
  })
})
