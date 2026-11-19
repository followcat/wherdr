import path from 'node:path'

// Hermes Agent (NousResearch/hermes-agent): exact pane → session identity.
// Every rule returns null on empty, ambiguous, truncated or unknown input: never a guess.

export type HermesEnv = Record<string, string | undefined>

// Same as hermes_constants.PROFILE_ID_RE.
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/
const SESSION_ID = /^(?:local-[0-9a-f]{64}|\d{8}_\d{6}_[0-9a-f]{6})$/
const TUI_FILE = /^hermes-tui-active-session-[^/]+\.json$/

export function hermesSessionId(id: unknown): string | null {
  return typeof id === 'string' && SESSION_ID.test(id) ? id : null
}

// os.path.expanduser(os.path.expandvars(p)); an undefined variable makes the path unknown.
function expandHome(raw: string, env: HermesEnv, home: string): string | null {
  let unknown = false
  const vars = raw.replace(/\$\{([^}]+)\}|\$([A-Za-z0-9_]+)/g, (_, braced: string | undefined, bare: string | undefined) => {
    const value = env[(braced ?? bare)!]
    if (value == null) unknown = true
    return value ?? ''
  })
  if (unknown) return null
  const expanded = vars === '~' || vars.startsWith('~/') ? home + vars.slice(1) : vars
  return path.isAbsolute(expanded) && !expanded.startsWith('~') ? path.normalize(expanded) : null
}

// scan_profile_flag: -p NAME, --profile NAME, --profile=NAME, before `--`.
export function hermesProfileFlag(argv: string[]): string | null | undefined {
  for (let i = 1; i < argv.length && argv[i] !== '--'; i++) {
    const arg = argv[i]!
    if (arg === '-p' || arg === '--profile') return argv[i + 1] ?? null
    if (arg.startsWith('--profile=')) return arg.slice(10)
  }
  return undefined
}

function profileDir(root: string, name: string): string | null {
  if (name === 'default') return root
  return PROFILE_ID.test(name) ? path.join(root, 'profiles', name) : null
}

/**
 * The state.db of the profile a Hermes process serves.
 * `env` and `argv` are the process's own; `home` is its user's home;
 * `activeProfile(root)` reads `<root>/active_profile` (null when absent).
 */
export function hermesHome(env: HermesEnv, home: string, argv: string[], activeProfile: (root: string) => string | null): string | null {
  if (!path.isAbsolute(home)) return null
  const native = path.join(home, '.hermes' + (env.HERMES_DATA_DIR_SUFFIX ?? ''))
  const raw = env.HERMES_HOME?.trim() || ''
  const envHome = raw ? expandHome(raw, env, home) : undefined
  if (envHome === null) return null
  // _hermes_root_of: under the native home → native; <root>/profiles/<name> → <root>; else itself.
  const root = !envHome || envHome === native || envHome.startsWith(native + path.sep)
    ? native
    : path.basename(path.dirname(envHome)) === 'profiles' ? path.dirname(path.dirname(envHome)) : envHome
  const flag = hermesProfileFlag(argv)
  let dir: string | null
  if (flag !== undefined) dir = flag == null ? null : profileDir(root, flag)
  else if (envHome && path.basename(path.dirname(envHome)) === 'profiles') dir = envHome
  else {
    const sticky = activeProfile(root)?.replace(/^﻿/, '').trim()
    dir = sticky && sticky !== 'default' ? profileDir(root, sticky) : (envHome ?? root)
  }
  return dir && path.join(dir, 'state.db')
}

/**
 * `hermes --tui`: the Node process's environment names the file it rewrites as
 * {"session_id": "…"} on every create/resume/switch. Empty before the first create,
 * when HERMES_TUI_RESUME names the resumed session.
 */
export function hermesTuiSession(environ: HermesEnv, readFile: (file: string) => string | null): string | null {
  const file = environ.HERMES_TUI_ACTIVE_SESSION_FILE
  if (!file || !path.isAbsolute(file) || !TUI_FILE.test(path.basename(file))) return null
  const text = readFile(file)
  if (text == null) return null
  if (!text.trim()) return hermesSessionId(environ.HERMES_TUI_RESUME)
  try {
    return hermesSessionId((JSON.parse(text) as { session_id?: unknown })?.session_id)
  } catch {
    return null
  }
}

/** Classic CLI: its bottom bar is ` ☤ <model> │ <session_id> `; a cut-off id gives null. */
export function hermesToolbarSession(screen: string): string | null {
  const last = screen.split('\n').map(l => l.trimEnd()).filter(Boolean).at(-1)
  const m = last?.match(/^\s*☤ [^│]* │ (\S+)$/)
  return m ? hermesSessionId(m[1]) : null
}

/** NUL-separated /proc/<pid>/environ → map; a variable set twice is ambiguous and dropped. */
export function parseEnviron(raw: string): HermesEnv {
  const env: HermesEnv = {}
  const twice = new Set<string>()
  for (const entry of raw.split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    const key = entry.slice(0, eq)
    if (key in env) twice.add(key)
    env[key] = entry.slice(eq + 1)
  }
  for (const key of twice) delete env[key]
  return env
}

/**
 * Shell snippet printing the base64 environment of every node process whose
 * parent is $1 (the pane's Hermes launcher), one `<pid> <base64>` line each.
 * Linux only, same uid (/proc/<pid>/environ is mode 0400): prints nothing elsewhere.
 */
export const HERMES_ENVIRON_SH = `[ -r /proc/self/environ ] || exit 0
for p in $(pgrep -P "$1" 2>/dev/null) "$1"; do
  # Not /proc/<pid>/comm: Node 24+ names its main thread "MainThread".
  case "$(basename "$(readlink "/proc/$p/exe" 2>/dev/null)")" in node|node[0-9]*|nodejs) ;; *) continue ;; esac
  e=$(head -c 262144 "/proc/$p/environ" 2>/dev/null | base64 | tr -d '\\n') || continue
  [ -n "$e" ] && printf '%s %s\\n' "$p" "$e"
done`

/** Output of HERMES_ENVIRON_SH → the single Node candidate's environment, else null. */
export function hermesNodeEnviron(output: string, platform: NodeJS.Platform = process.platform): HermesEnv | null {
  if (platform !== 'linux') return null
  const lines = output.split('\n').filter(l => /^\d+ \S+$/.test(l))
  const envs = lines.map(l => parseEnviron(Buffer.from(l.split(' ')[1]!, 'base64').toString('utf8')))
    .filter(e => e.HERMES_TUI_ACTIVE_SESSION_FILE)
  return envs.length === 1 ? envs[0]! : null
}
