// A project's On state change command (shared/pm/onState.ts), run when the
// store tells a task's state change: on the project's home machine, in its
// clone, in the background, 30 s at most. Its exit code and first lines go to
// the task's log; a failure is only logged, never tried again, and the task
// goes on.
import { PATH_SETUP, homeOf, machineOn, type CoreAdminDeps } from './coreCreate'
import { exec } from './pmLaunch'
import type { PmStore } from './pmStore'
import { cloneOn } from '../../shared/pm/project'
import { shownKey, shownTaskId } from '../../shared/pm/projectKey'
import { ON_STATE_TIMEOUT, eventOf, stateEnv, stateLogText, type TaskStateName } from '../../shared/pm/onState'
import type { Task } from '../../shared/pm/run'

export type OnStateDeps = Pick<CoreAdminDeps, 'call' | 'machines'> & { store: Pick<PmStore, 'project' | 'projects' | 'updateTask'> }

// cd to the clone ($1), then env takes the KEY=value arguments and runs sh -c with the command.
const SCRIPT = `${PATH_SETUP}\ncd "$1" || exit 1\nshift\nexec env "$@"`

export async function runOnState(deps: OnStateDeps, task: Task, states: TaskStateName[]) {
  const p = await deps.store.project(task.project)
  const cfg = p?.onStateChange
  if (!p || !cfg) return
  for (const state of states.filter(s => cfg.events.includes(eventOf(s)))) {
    let text: string
    try {
      const { on } = machineOn(deps, p.machine)
      const clone = cloneOn(p, p.machine, await homeOf(deps, on))
      if (!clone) throw new Error('the project has no clone on its home machine')
      const env = stateEnv(task, shownTaskId(await deps.store.projects(), task.id), state, shownKey(p))
      const r = await exec(deps, on, SCRIPT, [clone, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'sh', '-c', cfg.command], undefined, ON_STATE_TIMEOUT)
      text = stateLogText(state, r)
    } catch (e) { text = stateLogText(state, { error: (e as Error).message }) }
    await deps.store.updateTask(task.id, t => t, { by: 'engine', text }).catch(() => {})
  }
}
