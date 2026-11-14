// `wherdr pm map …` (shared/pm/workspaceMap.ts) for a workspace's coordinator:
// the map in maps/<WS>.json, map.md rewritten in the coordinator's folder after
// each change, and the repository list under the root, cached a day.
import { isWorkspace, membersOf, repoPath } from '../../shared/pm/workspace'
import { listFresh, markMapped, renderMap, setEntry, type MapCommand } from '../../shared/pm/workspaceMap'
import type { Project } from '../../shared/pm/project'
import { homeOf, machineOn, type CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import { WRITE_SCRIPT, exec } from './pmLaunch'
import { listRepos } from './pmRepos'
import type { PmStore } from './pmStore'

type Deps = CoreAdminDeps & { store: PmStore }

// map.md in the workspace coordinator's folder, on the workspace's machine.
export async function writeMapFile(deps: Deps, ws: Project, text: string) {
  const { on } = machineOn(deps, ws.machine)
  const home = await homeOf(deps, on)
  if (!home) throw new HerdrError('core', 'Home folder not found on the workspace\'s machine')
  if ((await exec(deps, on, WRITE_SCRIPT, [`${home}/.wherdr/pm/coordinators/${ws.key}/map.md`], text)).code !== 0) throw new HerdrError('core', 'Could not write map.md')
}

export async function runMap(deps: Deps, ws: Project | undefined, projects: Project[], cmd: MapCommand, now = Date.now()) {
  if (!ws || !isWorkspace(ws)) throw new HerdrError('bad_input', 'The map is a workspace\'s: run it from a workspace\'s coordinator, or name one with --project <KEY>')
  const { store } = deps
  if (cmd.name === 'map show') return { map: (await store.map(ws.key)).entries }
  if (cmd.name === 'map list') {
    let file = await store.map(ws.key)
    if (!listFresh(file, now, cmd.refresh)) {
      const repos = await listRepos(deps, ws.machine, ws.path)
      file = await store.changeMap(ws.key, f => ({ ...f, listed: { at: now, repos } }))
    }
    return { root: ws.path, listedAt: new Date(file.listed!.at).toISOString(), repos: markMapped(file, file.listed!.repos) }
  }
  let refusal = ''
  const file = await store.changeMap(ws.key, (f) => {
    if (cmd.name === 'map remove') {
      if (!f.entries.some(e => e.repo === cmd.repo)) refusal = `${cmd.repo} is not on the map`
      return { ...f, entries: f.entries.filter(e => e.repo !== cmd.repo) }
    }
    const member = membersOf(ws.key, projects).find(m => repoPath(m, ws) === cmd.repo)
    const next = setEntry(f, cmd, ws.path, member?.key, now)
    if ('error' in next) { refusal = next.error; return f }
    return next
  })
  if (refusal) throw new HerdrError('bad_input', refusal)
  await writeMapFile(deps, ws, renderMap(ws, file))
  return cmd.name === 'map remove' ? { removed: cmd.repo } : { set: file.entries.find(e => e.repo === cmd.repo) }
}
