// What a task waiting for the user answers with, for its sheet's To do tab
// (TaskSheet.vue) and the review sheet (ReviewSheet.vue): each action busy while
// it runs, its error kept; `changed` once it went through. press: the step's
// button; a refused action (a merge on a PR in conflict, red checks…) keeps its
// badge in `refused`, said under the button until the step's badge changes.
import type { Card } from '#shared/pm/board'
import type { Task } from '#shared/pm/run'
import type { Resume } from '#shared/pm/stop'
import type { Choice } from '#shared/pm/verdict'

// card: the task acted on (the review sheet's current one, none past the last).
export function useTaskActions(card: () => Card | undefined, changed: () => void) {
  const busy = ref(false)
  const error = ref('')
  const pressing = ref(false)
  const refused = ref('')
  const id = () => card()!.id
  async function run(fn: () => Promise<unknown>) {
    busy.value = true
    error.value = ''
    try { if (await fn() !== false) changed() }
    catch (e) { error.value = (e as Error).message }
    finally { busy.value = false }
  }
  const press = () => run(async () => {
    pressing.value = true
    refused.value = ''
    try {
      const { task } = await api<{ task: Task }>('/api/pm/step-user', { id: id() })
      if (task.step?.yourTurn?.reason === 'action') refused.value = task.step.yourTurn.badge
    }
    finally { pressing.value = false }
  })
  watch(() => card()?.yourTurn, (b) => { if (b !== refused.value) refused.value = '' })
  return {
    busy, error, pressing, refused, run, press,
    start: () => run(() => startTaskApi(id(), undefined, card()!.sameFiles ? true : undefined)),
    resume: (how: Resume) => run(() => resumeTaskApi(id(), how)),
    decide: (choice: Choice) => run(() => api('/api/pm/decide', { id: id(), choice })),
    sendBack: (note: string, shots?: string[]) => run(() => api('/api/pm/step-back', { id: id(), note, ...(shots?.length ? { shots } : {}) })),
    restartReview: () => run(() => api('/api/pm/review-restart', { id: id() })),
    startWorker: () => run(() => api('/api/pm/worker-start', { id: id() })),
    askCoordinator: () => run(() => api('/api/pm/ask-coordinator', { id: id() })),
    // Ask the agent to fix it: its worker (started again if it ended) gets the block's reason.
    askFix: () => run(() => api('/api/pm/agent-fix', { id: id() })),
  }
}
