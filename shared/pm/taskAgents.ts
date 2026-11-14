// What a task's agent is doing, for its sidebar row (GET /api/pm/agents): the
// task it works on and its role there. Rows stay herdr-core's own (one per
// pane, its own status and group); this only names them.
import type { PlannedStep } from './steps'
import type { Run, Task } from './run'

// dev: the worker on its step; fix: the worker sent back (review, red CI,
// a failed action, the user); catch-up: the worker merging the base.
export type AgentRole = 'dev' | 'review' | 'fix' | 'catch-up'
// reserve: a reviewer kept between rounds, not reviewing now.
export interface TaskAgent { task: string, shown: string, title: string, role: AgentRole, reserve?: true }

// The engine's own sends to the worker during a later step (pmMechanic.ts logs `<move>: <result>`).
const SENT = /^(catch-up|ci-to-agent): (sent to the agent|started the worker again)/

export function agentRole(task: Task, plan: PlannedStep[], run: Pick<Run, 'role'>): Pick<TaskAgent, 'role' | 'reserve'> {
  const s = task.step
  const step = s?.started ? plan[s.at] : undefined
  if (run.role === 'reviewer') return step?.holder === 'reviewer' ? { role: 'review' } : { role: 'review', reserve: true }
  // The engine's latest send to the worker since the step began says what it does now.
  const sent = (task.log ?? []).findLast(e => e.by === 'engine' && e.at >= (s?.since ?? 0) && SENT.test(e.text))
  if (sent) return { role: sent.text.startsWith('catch-up') ? 'catch-up' : 'fix' }
  return { role: step?.holder === 'worker' && (s?.backFrom || s?.fix) ? 'fix' : 'dev' }
}

// The key of a task's agent by its terminal's wherdr.task and wherdr.role
// labels: an address never holds '#'.
export const labelKey = (task: string, role: string) => `${task}#${role}`

// Every running agent of a task, by its herdr-core address; and each role a
// task ever ran, by its labels (labelKey), for a terminal whose address or run
// changed (re-attached after a core restart, resumed after a crash).
export function taskAgents(tasks: Task[], runs: Run[], planOf: (t: Task) => PlannedStep[], shownOf: (id: string) => string): Record<string, TaskAgent> {
  const out: Record<string, TaskAgent> = {}
  const byId = new Map(tasks.map(t => [t.id, t]))
  for (const run of runs) {
    const task = byId.get(run.task)
    // A done task whose agents all ended has no row.
    if (!task || (task.step?.done && run.state === 'ended')) continue
    const agent = { task: task.id, shown: shownOf(task.id), title: task.title, ...agentRole(task, planOf(task), run) }
    out[labelKey(task.id, run.role)] = agent
    if (run.terminal && run.state !== 'ended') out[run.terminal] = agent
  }
  return out
}
