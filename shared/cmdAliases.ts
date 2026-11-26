// Command Code names and package entrypoints: one source of truth for every
// module that recognizes the agent. A bare `cmd` (or `cmd.exe`) proves nothing:
// it is the Windows shell, and any command line may carry it as a word — `vim
// cmd`, `ls cmd`, `node build.js cmd`, `/usr/local/bin/cmd`, `cmd /c dir` are
// never Command Code. Only the names below and the package's own entrypoints
// are.

// Self-evident names: a program launched under one of these is Command Code,
// whatever directory it comes from (`/opt/command-code` included).
export const CMD_ALIASES: readonly string[] = ['command-code', 'command_code', 'commandcode', 'cmdc']

// The package's own entrypoints: the bins it installs and the scripts its bins
// run. `.../command-code/bin/cmd` is one of them (the directory proves it), a
// `cmd` anywhere else is not.
export const CMD_ENTRYPOINT_RE = /\/command-code\/(?:dist\/(?:index|cli)\.mjs|bin\/(?:cmd|cmdc|command-code|commandcode|command_code))$/

// What a display or pane title says when it says nothing: the agent's own
// names, so a title repeating one is never offered as a subject.
export const CMD_GENERIC_TITLES: readonly string[] = ['cmd', 'cmdc', 'command code', 'command-code', 'command_code', 'commandcode']

const GENERIC = new Set(CMD_GENERIC_TITLES)
const ALIASES = new Set(CMD_ALIASES)
// Interpreters that run the package's entrypoint script, and the runners that
// hand a package (or its entrypoint) to the program it names.
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno'])
const RUNNERS = new Set(['npx', 'bunx'])

const lower = (value: string | null | undefined) => (value || '').trim().toLocaleLowerCase()
const baseName = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || ''

// A declared kind — core's agent field, a launch template, the app a status
// reports — is a name, not an argv path: `cmd` itself declares Command Code
// there, while `cmd.exe` declares the shell. An unknown kind stays unknown.
export function canonicalCmdAgent(raw: string | null | undefined): 'cmd' | null {
  return GENERIC.has(lower(raw)) ? 'cmd' : null
}

// True only for an alias: never for the Windows shell, never for a path.
export function isCmdAlias(name: string | null | undefined): boolean {
  return ALIASES.has(lower(name))
}

// True only for a proven package entrypoint (`\` accepted as a separator).
export function isCmdEntrypoint(path: string | null | undefined): boolean {
  return CMD_ENTRYPOINT_RE.test((path || '').replace(/\\/g, '/'))
}

// Command Code behind a launch argv, from its program and first argument only:
// an operand that merely mentions one of its names (`vim cmd`, `ls cmd`,
// `node build.js cmd`, `sh -c cmd`) never proves it.
export function cmdProgramFromArgv(argv: readonly string[] | null | undefined): 'cmd' | null {
  const [first, second] = argv ?? []
  if (!first) return null
  const program = baseName(first)
  if (isCmdAlias(program) || isCmdEntrypoint(first)) return 'cmd'
  if (!second) return null
  const name = program.toLocaleLowerCase()
  if (RUNNERS.has(name) && (isCmdAlias(second) || isCmdEntrypoint(second))) return 'cmd'
  if (INTERPRETERS.has(name) && isCmdEntrypoint(second)) return 'cmd'
  return null
}
