// A project's folder: on a machine herdr-core reaches, inside its home
// folder, and a git repository. Resolves to the absolute path.
import { underHome } from './actions'
import { coreAdminDeps } from './coreAdminDeps'
import { coreIsGit, homeOf, machineOn } from './coreCreate'
import { HerdrError } from './herdr'

export async function pmFolderCheck(machine: string, folder: string): Promise<string> {
  const deps = coreAdminDeps()
  const { on } = machineOn(deps, machine)
  const home = await homeOf(deps, on)
  const dir = home && underHome(folder, home)
  if (!dir) throw new HerdrError('bad_input', 'path: a folder inside the home folder')
  if (!(await coreIsGit(deps, dir, machine)).git) throw new HerdrError('not_git', 'This folder is not a git repository')
  return dir
}
