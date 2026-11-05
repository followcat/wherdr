// New version notice: version comparison, update command depending on the
// installation mode (shared by server / app, no dependency).

// Install modes of wherdr 3 (bin/lib/core.mjs installKind; wherdr 3 is not a Herdr plugin):
// npm: started from a temporary package folder (npx / bunx / pnpm dlx wherdr).
// npm-global: the package installed by `npm i -g wherdr` (<prefix>/lib/node_modules/wherdr).
// brew: the same package, installed by the Homebrew formula (the project's tap).
// native: a source checkout (git clone, npm ci, npm run build).
export type InstallMode = 'native' | 'npm' | 'npm-global' | 'brew'

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
  // Stable releases newer than current, among the latest 100 API entries.
  // Optional so cached state and older API responses remain usable.
  behind?: number
  missed?: string[] // newest first, at most five versions (including latest)
  behindAtLeast?: boolean // the API page was full: the count is a lower bound
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

const MODES: InstallMode[] = ['npm', 'npm-global', 'brew']
export function installMode(env: string | undefined): InstallMode {
  return MODES.find(m => m === env) ?? 'native'
}

// The command that updates wherdr in each install mode.
export function updateCommand(mode: InstallMode): string {
  if (mode === 'npm') return 'npx wherdr@latest'
  if (mode === 'npm-global') return 'npm install -g wherdr@latest && wherdr restart'
  if (mode === 'brew') return 'brew upgrade wherdr && brew services restart wherdr'
  return 'git pull && npm ci && npm run build'
}

// Modes the server can update and restart by itself;
// not npx (a temporary folder: running `npx wherdr@latest` again is the
// update); not a checkout (local changes, build of several minutes).
export function oneTapMode(mode: InstallMode): boolean {
  return mode === 'npm-global' || mode === 'brew'
}
