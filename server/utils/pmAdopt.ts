// `wherdr pm repo adopt <repo>` (shared/pm/workspaceAdopt.ts) for a
// workspace's coordinator: the folder probed on the workspace's machine, the
// member added (store.addProject), its visibility checked, its map line
// pointed at it and the adoption written to the workspace's log.
import { REAL_ALL_SCRIPT, REAL_SCRIPT, adoptRefusal, foldersOn, realLines, adoptedMember, realRepo, repoUnder, type RepoCommand } from '../../shared/pm/workspaceAdopt'
import { effectiveWorkflow, isWorkspace } from '../../shared/pm/workspace'
import { needsRemote } from '../../shared/pm/newProject'
import { renderMap } from '../../shared/pm/workspaceMap'
import type { Project } from '../../shared/pm/project'
import { homeOf, machineOn, type CoreAdminDeps } from './coreCreate'
import { HerdrError } from './herdr'
import { exec } from './pmLaunch'
import { pmFolderCheck, probeFolder } from './pmFolder'
import { writeMapFile } from './pmMap'
import { ensureVisibility } from './pmVisibility'
import type { PmStore } from './pmStore'

type Deps = CoreAdminDeps & { store: PmStore }

export async function adoptRepo(deps: Deps, ws: Project | undefined, projects: Project[], cmd: RepoCommand, by: string) {
  if (!ws || !isWorkspace(ws)) throw new HerdrError('bad_input', 'repo adopt is a workspace\'s: run it from a workspace\'s coordinator, or name one with --project <KEY>')
  return addAdopted(deps, ws, await checkAdoption(deps, ws, projects, cmd), by)
}

// Everything adopting checks, nothing changed: the repository (symlinks
// resolved) and its folder as probed.
export async function checkAdoption(deps: Deps, ws: Project, projects: Project[], cmd: RepoCommand) {
  const { store } = deps
  const { on } = machineOn(deps, ws.machine)
  const home = await homeOf(deps, on) ?? ''
  const named = repoUnder(cmd.repo, ws.path, home)
  if (typeof named !== 'string') throw new HerdrError('refused', named.error)
  // Symlinks resolved on the machine: a link out of the root is refused.
  const r = await exec(deps, on, REAL_SCRIPT, [ws.path, `${ws.path.replace(/\/+$/, '')}/${named}`])
  if (r.code !== 0) throw new HerdrError('core', 'Could not resolve the folder on the workspace\'s machine')
  const [realRoot = '', realFolder = ''] = r.out.split('\n')
  const repo = realRepo(named, realRoot, realFolder)
  if (typeof repo !== 'string') throw new HerdrError('refused', repo.error)
  const member = adoptedMember(ws, repo, projects)
  const probe = await probeFolder(ws.machine, member.path, deps)
  const workflow = effectiveWorkflow(member.key, null, member as Project, ws, await store.savedWorkflow(ws.key))
  // Every project's folder on this machine, its clones' included, ~ expanded and resolved there.
  const others = foldersOn(projects, ws.machine, home)
  const real = others.length ? await exec(deps, on, REAL_ALL_SCRIPT, others.map(o => o.folder)) : { code: 0, out: '' }
  if (real.code !== 0) throw new HerdrError('core', 'Could not resolve the projects\' folders on the workspace\'s machine')
  const resolved = realLines(real.out, others.length)
  const owners = others.map((o, i) => ({ project: o.project, folders: [o.folder, resolved[i]!] }))
  const refused = adoptRefusal([probe.path, realFolder], owners, probe, needsRemote(workflow))
  if (refused) throw new HerdrError('refused', refused)
  return { repo, path: probe.path }
}

// The checked repository made a member (key and color picked from the projects as they are now).
// saved: told the member's key as soon as it is saved, before what may still fail.
export async function addAdopted(deps: Deps, ws: Project, { repo, path }: { repo: string, path: string }, by: string, saved?: (key: string) => void) {
  const { store } = deps
  const member = adoptedMember(ws, repo, await store.projects())
  const project = await store.addProject({ ...member, path }, (m, f, o) => pmFolderCheck(m, f, o, deps))
  saved?.(project.key)
  const added = await ensureVisibility(deps, project)
  await store.logProject(ws.key, { by, text: `adopted ${repo} as project ${added.key}`, adopted: { project: added.key, repo } })
  // Its map line, when it has one, names it now (map.md is written again at the next map set if this fails).
  const file = await store.changeMap(ws.key, f => ({ ...f, entries: f.entries.map(e => (e.repo === repo ? { ...e, project: added.key } : e)) }))
  if (file.entries.some(e => e.repo === repo)) await writeMapFile(deps, ws, renderMap(ws, file)).catch(() => {})
  return {
    adopted: { key: added.key, name: added.name, color: added.color, repo, path: added.path, visibility: added.visibility?.value ?? 'unknown' },
    next: `Add its tasks with task add --project ${added.key}; they run on the machines with its clone under the workspace's root`,
  }
}
