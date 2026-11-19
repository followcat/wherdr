// A worker blocked halfway on another task or repository: it says so with its
// wherdr.report label (`blocked:on <task|repo>: <what it needs>`). Named a
// task, that task becomes an `after` link of this one; the task parks: its
// agents end (its machine slot is free), no stall, nudge or restart counts it,
// its card says what it waits for, and its coordinator is woken once. Once
// what it waits for is done, its worker's conversation is taken up again with
// what changed. A wait that would close a cycle is refused and goes to the
// coordinator as a decision. Pure: server/utils/pmAdvance.ts carries it out.
import { LABEL, prLink, type Task } from './run'
import { afterIds } from './advance'
import { afterRefusal } from './feature'
import { shownTaskId, storedTaskId } from './projectKey'
import type { Project } from './project'

// on: the task (its stored id) or the repository it waits for; before: its after links when it parked.
// room: paused by a coordinator to free its machine (on: that machine's key, room: its name, need: why);
// the engine takes it up again once that machine has room (pauseForRoom, resumeParked).
export interface Parked { on: string, need: string, at: number, before: string[], room?: string }

const PREFIX = 'blocked:on '
export const BLOCKED_ON_CMD = `hc label "$HC_TERMINAL_ID" "${LABEL.report}=${PREFIX}<task or repository>: <what you need>"`
// The line of the worker's instructions that says how.
export const blockedOnLine = () =>
  `If you find halfway that you need something from another task or repository first, run \`${BLOCKED_ON_CMD}\` (for example \`${PREFIX}WHR-12: the new /api/items endpoint\`): your task waits, and this conversation goes on once that is done.`

export const isBlockedOn = (label: string | undefined) => !!label?.startsWith(PREFIX)
export function parseBlockedOn(label: string): { on: string, need: string } | undefined {
  const m = /^blocked:on\s+([^\s:]+)\s*:\s*(\S[\s\S]*)$/.exec(label.trim())
  return m ? { on: m[1]!, need: m[2]!.trim().slice(0, 500) } : undefined
}

export type ParkResult =
  | { park: Task, wake: string, key: string }
  | { refused: string, wake?: string, key?: string }

// What a blocked report does to the task: parked (with its wake), or refused
// with what the worker is told (and, for a cycle, the coordinator's decision).
export function parkOf(task: Task, on: string, need: string, tasks: Task[], projects: Project[], now: number): ParkResult {
  const show = (id: string) => shownTaskId(projects, id)
  const before = afterIds(task), id = storedTaskId(projects, on)
  const other = id ? tasks.find(t => t.id === id) : undefined
  const head = `${show(task.id)} (${task.title})`
  if (!other) {
    if (id) return { refused: `${on} is no task: name an existing task, or the repository you need something from.` }
    return {
      park: { ...task, parked: { on, need, at: now, before } }, key: `blocked:${on}:${now}`,
      wake: `${head} is parked: its worker needs something from the repository ${on}, which no task covers: ${need}. Add a task there (wherdr pm task add), then link it: \`wherdr pm task edit ${show(task.id)} --after <the new task> --reason "<why>"\`. ${show(task.id)} goes on in the same conversation once that task is done.`,
    }
  }
  if (other.step?.done) return { refused: `${show(other.id)} is already done: update your branch with its work and go on.` }
  const why = afterRefusal(task.project, [other.id], tasks, projects, task.id)
  if (why && /cycle/.test(why)) {
    return {
      refused: `Refused: ${show(other.id)} already waits for this task, so both would wait forever. Your coordinator decides how to go on; until it tells you, keep working on what does not need it.`,
      key: `cycle:${other.id}`,
      wake: `Decision: ${head} asked to wait for ${show(other.id)} (${other.title}): ${need}. But ${show(other.id)} already waits for ${show(task.id)}: a cycle, so ${show(task.id)} was not parked. Choose one: pull the shared contract (proto, API, schema) into its own task both wait for, or merge the two tasks into one. Then add or edit the tasks (wherdr pm task add, task edit --after). If you cannot decide, do not ack this wake: tell the user both options in your next message, and the choice is theirs.`,
    }
  }
  if (why) return { refused: `${on} is not a task of this project or workspace: name one of them, or the repository you need something from.` }
  return {
    park: { ...task, after: [...before.filter(x => x !== other.id), other.id].join(','), parked: { on: other.id, need, at: now, before: before.filter(x => x !== other.id) } }, key: `blocked:${other.id}:${now}`,
    wake: `${head} is parked: its worker waits for ${show(other.id)} (${other.title}): ${need}. If ${show(other.id)}'s work does not cover it, add a task for what is missing and link it (\`wherdr pm task edit ${show(task.id)} --after ${show(other.id)},<that task> --reason "<why>"\`), or tell the user. ${show(task.id)} goes on in the same conversation once ${show(other.id)} is done.`,
  }
}

// The tasks a parked task waits for: the after links added since it parked.
export const parkWaits = (task: Pick<Task, 'after' | 'parked'>) =>
  task.parked ? afterIds(task).filter(id => !task.parked!.before.includes(id)) : []

// The first message of the resumed conversation, once every task it waits for
// is done (or abandoned); undefined: it still waits.
export function resumeText(task: Task, tasks: Task[], projects: Project[]): string | undefined {
  const ids = parkWaits(task)
  const ts = ids.map(id => tasks.find(t => t.id === id))
  if (!ids.length || ts.some(t => t && !t.step?.done && !t.step?.abandoned)) return
  const lines = ids.map((id, i) => {
    const t = ts[i]
    if (!t) return `- ${shownTaskId(projects, id)} no longer exists.`
    if (t.step?.abandoned) return `- ${shownTaskId(projects, id)} (${t.title}) was abandoned: what you waited for did not come.`
    const pr = prLink(t), report = t.workReports?.at(-1)?.text.trim().slice(0, 600)
    return `- ${shownTaskId(projects, id)} (${t.title}) is done${pr ? `, PR ${pr}` : ''}.${report ? ` Its report: ${report}` : ''}`
  })
  return [`You were waiting for ${shownTaskId(projects, task.parked!.on)}: ${task.parked!.need}`, ...lines, 'Update your branch with what you need, then go on with your task.'].join('\n')
}

// A started task a coordinator pauses to free its machine: why not, or undefined.
// Only a worker's step: the worker is what the engine starts again.
// Its worker's conversation must be one the engine takes up again (a Claude worker's pinned session).
export function roomPauseRefusal(task: Task, holder: string | undefined, live: { role: string, program?: string, session?: string }[]): string | undefined {
  if (task.step?.done) return `${task.id} is done`
  if (task.stopped) return `${task.id} is stopped: it holds no room`
  if (task.parked) return task.parked.room ? `${task.id} is already paused for room` : `${task.id} is parked: it holds no room`
  if (task.state === 'todo' || !task.step?.started) return `${task.id} has not started`
  if (task.state === 'waiting' || task.step.yourTurn) return `${task.id} waits for the user: pausing it would hide that from them`
  if (holder !== 'worker') return `${task.id} is at a step its worker does not hold: only a worker's step is paused for room`
  if (!live.length) return `${task.id} has no agent running: it holds no room`
  const worker = live.find(r => r.role === 'worker')
  if (!worker || worker.program !== 'claude' || !worker.session) return `${task.id}'s worker conversation cannot be taken up again later (only a Claude worker's can): stop it instead, or let it finish`
}

// The task paused for room on a machine (key, name): no agent, no stall, out of the user's lists.
export const roomParked = (task: Task, machine: string, label: string, why: string, now: number): Task =>
  ({ ...task, parked: { on: machine, need: why, at: now, before: afterIds(task), room: label } })

// The first message of its worker's conversation, taken up again once there is room.
export const roomResumeText = (p: Parked) =>
  `Your coordinator paused this task to free room on ${p.room}: ${p.need}\nThere is room again: go on with your task where you left it.`
