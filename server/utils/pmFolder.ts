// A project's folder: on a machine herdr-core reaches, inside its home
// folder. A git repository by default; the New sheet also takes a folder
// without git (plain), creates a missing one (create) and runs git init on a
// new or empty one (gitInit). Resolves to the absolute path and whether it is git.
import { posix as px } from 'node:path'
import { underHome } from './actions'
import { coreAdminDeps } from './coreAdminDeps'
import { homeOf, machineOn, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import { HerdrError } from './herdr'
import { isPlainFolder } from '../../shared/pm/coordinator'
import type { FolderOptions, FolderProbe } from '../../shared/pm/newProject'
import type { Project } from '../../shared/pm/project'
import type { PmStore } from './pmStore'

// Prints "missing", or "dir" then "git", "remote" (it has an origin) and "empty" when they hold.
export const PROBE_SCRIPT = `[ -e "$1" ] || { echo missing; exit 0; }
[ -d "$1" ] || exit 5
echo dir; [ -e "$1/.git" ] && { echo git; git -C "$1" remote get-url origin >/dev/null 2>&1 && echo remote; }; [ -z "$(ls -A "$1" 2>/dev/null)" ] && echo empty; exit 0`
// $2 = create: mkdir -p a missing folder; $3 = init: git init a new or empty one.
export const PREPARE_SCRIPT = `if [ ! -e "$1" ]; then [ "$2" = create ] || exit 3; mkdir -p "$1" || exit 4; fi
[ -d "$1" ] || exit 5
if [ "$3" = init ] && [ ! -e "$1/.git" ] && [ -z "$(ls -A "$1" 2>/dev/null)" ]; then git -C "$1" init -q || exit 6; fi
[ -e "$1/.git" ] && echo git; exit 0`

async function resolve(deps: CoreAdminDeps, machine: string, folder: string) {
  const { on } = machineOn(deps, machine)
  const home = await homeOf(deps, on)
  const dir = home && underHome(folder, home)
  if (!dir) throw new HerdrError('bad_input', 'path: a folder inside the home folder')
  return { on, dir }
}

export async function probeFolder(machine: string, folder: string, deps = coreAdminDeps()): Promise<FolderProbe> {
  const { on, dir } = await resolve(deps, machine, folder)
  const r = await exec(deps, on, PROBE_SCRIPT, [dir])
  if (r.code !== 0) throw new HerdrError('bad_path', 'This path is a file, not a folder')
  const lines = r.out.split('\n')
  return { path: dir, exists: !lines.includes('missing'), git: lines.includes('git'), remote: lines.includes('remote'), empty: lines.includes('empty') }
}

// A project added without git whose folder has become a repository: the flag
// goes. A failed probe changes nothing and is returned, so a refusal never
// claims the folder has no git. Workspaces and their members are left alone.
export async function refreshGit(deps: CoreAdminDeps & { store: PmStore }, p: Project): Promise<{ project: Project, error?: unknown }> {
  if (!isPlainFolder(p) || p.workspace) return { project: p }
  try {
    if (!(await probeFolder(p.machine, p.path, deps)).git) return { project: p }
  } catch (error) { return { project: p, error } }
  return { project: await deps.store.markGit(p.key) }
}

export async function pmFolderCheck(machine: string, folder: string, opts: FolderOptions = {}, deps = coreAdminDeps()) {
  const { on, dir } = await resolve(deps, machine, folder)
  const r = await exec(deps, on, PREPARE_SCRIPT, [dir, opts.create ? 'create' : '', opts.gitInit ? 'init' : ''])
  if (r.code === 3) throw new HerdrError('bad_path', 'This folder does not exist')
  if (r.code === 6) throw new HerdrError('core', 'git init failed in this folder')
  if (r.code !== 0) throw new HerdrError('bad_path', `Could not prepare the folder ${px.basename(dir)}`)
  const git = r.out.split('\n').includes('git')
  if (!git && !opts.plain) throw new HerdrError('not_git', 'This folder is not a git repository')
  return { path: dir, git }
}
