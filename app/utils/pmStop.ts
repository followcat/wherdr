// Start a task by hand, stop it and take a stopped one up again, from the
// board, the task sheet and Decisions (server/utils/pmStop.ts). Archive asks
// first: the task ends. Delete asks first too: a task never started leaves the board.
// A task whose PR was closed without a merge is archived the same way.
import type { Resume } from '#shared/pm/stop'
import type { Task } from '#shared/pm/run'

export const RESUME_LABEL: Record<Resume, [string, string]> = {
  'continue': ['Continue', 'Continuer'],
  'as-is': ['Take it as it is', 'Prendre tel quel'],
  'archive': ['Archive', 'Archiver'],
}

export const RESUME_MEANING: Record<Resume, string> = {
  'continue': 'Its agent starts again in the same worktree, with a note on why it stopped.',
  'as-is': 'Its work is taken as it is: on to the next step.',
  'archive': 'The task ends: its worktree is removed, its branch kept.',
}

// The server's refusal (a limit, no template, no machine…) comes back as a
// task waiting with its reason: thrown here, so it is said like an error.
// machine: a key the project allows (Start on…), for a task never started.
// anyway: start it beside the started task that touches the same files (card.sameFiles).
export async function startTaskApi(id: string, machine?: string, anyway?: true) {
  const { task } = await api<{ task: Task }>('/api/pm/task-start', { id, ...(machine !== undefined ? { machine } : {}), ...(anyway ? { anyway } : {}) })
  if (task.state === 'waiting') throw new Error(task.waiting || tl('The task could not start', 'La tâche n’a pas pu démarrer'))
  return task
}

export const stopTaskApi = (id: string, why = '') => api('/api/pm/task-stop', { id, why })

// false: the user cancelled. Only a task never started (card.removable).
export async function removeTaskApi(id: string) {
  if (!(await askConfirm(tl('Delete this task? It never started: it leaves the board for good.', 'Supprimer cette tâche ? Elle n’a jamais été lancée : elle quitte le tableau pour de bon.'), tl('Delete', 'Supprimer')))) return false
  await api('/api/pm/task-remove', { id })
  return true
}

const askArchive = () => askConfirm(tl('Archive this task? Its agent stays stopped; its worktree is removed, its branch is kept.', 'Archiver cette tâche ? Son agent reste arrêté ; son worktree est supprimé, sa branche est gardée.'), tl('Archive', 'Archiver'))

// false: the user cancelled the archive.
export async function resumeTaskApi(id: string, how: Resume) {
  if (how === 'archive' && !(await askArchive())) return false
  await api('/api/pm/task-resume', { id, how })
  return true
}

// A task whose PR was closed without a merge (Check on GitHub): stopped, then
// archived, once confirmed. false: the user cancelled.
export async function archiveClosedApi(id: string, stopped: boolean) {
  if (!(await askArchive())) return false
  if (!stopped) await stopTaskApi(id, 'its PR was closed without a merge')
  await api('/api/pm/task-resume', { id, how: 'archive' })
  return true
}
