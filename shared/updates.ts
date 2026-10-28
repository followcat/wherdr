// New version notice: version comparison, update command depending on the
// installation mode, and the state of a one-tap update (shared by server / app,
// no dependency).

// npm: started from a temporary package folder (npx / bunx / pnpm dlx wherdr).
// npm-global: the package installed by `npm i -g wherdr` (<prefix>/lib/node_modules/wherdr).
// brew: the same package, installed by the Homebrew formula (the project's tap).
// plugin: the copy the Herdr plugin runs in native mode (~/wherdr/app).
export type InstallMode = 'native' | 'npm' | 'npm-global' | 'brew' | 'plugin'

// One-tap update (bin/lib/updater.mjs): written by the updater to
// ~/wherdr/update.json, read back by the server for the app.
export type UpdateState = 'installing' | 'restarting' | 'checking' | 'rolling-back' | 'done' | 'rolled-back' | 'failed'
export interface UpdateJob {
  state: UpdateState
  from: string
  to: string
  mode: InstallMode
  // Error of a failed update, in English (also in ~/wherdr/update.log).
  message?: string
  startedAt: number
  updatedAt: number
}

export interface UpdateInfo {
  current: string
  // Latest published release, if newer than `current`; otherwise null.
  latest: string | null
  url: string | null
  // The latest release could be read (check enabled, GitHub reachable).
  checked: boolean
  mode: InstallMode
  command: string
  // wherdr can update itself from the app in this mode (button Update).
  oneTap: boolean
  // How far behind upstream: published releases newer than `current`, and
  // their version list (newest first, capped). 0 / [] when up to date.
  behind: number
  missed: string[]
  // Latest release publish time (ms epoch), when a newer release exists.
  latestAt: number | null
}

// "v1.2.3", "1.2.3-beta.1" -> [1, 2, 3]; null if unreadable. Pre-releases
// are ignored (never offered: GitHub's "latest" release is never one).
export function parseVersion(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(v).trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

// > 0 if a is newer than b; 0 if equal or unreadable.
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a), y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!
  return 0
}

const MODES: InstallMode[] = ['npm', 'npm-global', 'brew', 'plugin']
export function installMode(env: string | undefined): InstallMode {
  return MODES.find(m => m === env) ?? 'native'
}

// `repo`: owner/name of the GitHub repository (the Herdr plugin installs from it).
export function updateCommand(mode: InstallMode, repo: string): string {
  if (mode === 'npm') return 'npx wherdr@latest'
  if (mode === 'npm-global') return 'npm install -g wherdr@latest && wherdr restart'
  if (mode === 'brew') return 'brew upgrade wherdr && brew services restart wherdr'
  if (mode === 'plugin') return `herdr plugin install ${repo} --yes`
  return 'git pull && npm ci && npm run build'
}

// Modes the server can update and restart by itself;
// not npx (a temporary folder: running `npx wherdr@latest` again is the
// update); not a checkout (local changes, build of several minutes).
export function oneTapMode(mode: InstallMode): boolean {
  return mode === 'plugin' || mode === 'npm-global' || mode === 'brew'
}

// An update still in progress (not finished, and not abandoned: an updater
// killed half-way leaves a state that stops counting after 10 minutes).
export function updateRunning(job: UpdateJob | null, now: number): boolean {
  return !!job && !['done', 'rolled-back', 'failed'].includes(job.state) && now - job.updatedAt < 10 * 60_000
}
