// The repository folders a path written by an agent is also tried in
// (server/utils/files.ts findWritten): a task's agent, its task's worktree; a
// project coordinator, its project's clone on the pane's machine (a
// workspace's: its root, then each member's clone).
import { cloneOn } from '../../shared/pm/project'
import { membersOf } from '../../shared/pm/workspace'
import type { Pane } from '../../shared/types'
import { pmStore } from './pmStore'

type Store = Pick<ReturnType<typeof pmStore>, 'enabled' | 'runs' | 'coordinators' | 'projects'>
const atHome = (p: string, home: string) => p.replace(/^~(?=\/|$)/, () => home)

export async function repoDirs(p: Pick<Pane, 'machine' | 'task' | 'coordinator' | 'coreAddress'>, home: string, store: Store = pmStore()): Promise<string[]> {
  try {
    if (!p.coreAddress || !(p.task || p.coordinator) || !(await store.enabled())) return []
    const machine = p.machine ?? ''
    if (p.task) {
      const runs = (await store.runs()).filter(r => r.task === p.task && r.machine === machine && r.worktree)
      const run = runs.find(r => r.terminal === p.coreAddress) ?? runs.sort((a, b) => b.startedAt - a.startedAt)[0]
      return run ? [atHome(run.worktree, home)] : []
    }
    const c = (await store.coordinators()).find(x => x.terminal === p.coreAddress)
    const projects = await store.projects()
    const own = c && projects.find(x => x.key === c.project)
    if (!own) return []
    return [own, ...membersOf(own.key, projects)].map(x => cloneOn(x, machine, home)).filter((d): d is string => Boolean(d))
  } catch { return [] }
}
