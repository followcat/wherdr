// What a task waiting for the user answers with, for its sheet's To do tab
// (TaskSheet.vue) and the review sheet (ReviewSheet.vue): each action busy while
// it runs, its error kept; `changed` once it went through. press: the step's
// button; a refused action (a merge on a PR in conflict, red checks…) keeps its
// badge in `refused`, said under the button until the step's badge changes.
// All of it belongs to the task it was started on (keyed by its id): the review
// sheet moving on to another task shows that one's own state, and a request still
// pending once the board moved the step on (or the task left the list) shows no more.
import type { Card } from '#shared/pm/board'
import type { Task } from '#shared/pm/run'
import type { Resume } from '#shared/pm/stop'
import type { Choice } from '#shared/pm/verdict'

interface Doing { busy?: boolean, pressing?: boolean, error?: string, refused?: string, step?: string, run?: number }
// The step the board shows the task at: once it changes, a request still pending is over for the sheet.
const stepOf = (c: Card) => `${c.state?.at ?? ''}|${c.state?.done ? 1 : 0}`

// card: the task acted on (the review sheet's current one, none past the last).
// changed: told which task an action went through on (maybe no longer the one on screen).
export function useTaskActions(card: () => Card | undefined, changed: (id: string) => void) {
  const of = ref<Record<string, Doing>>({})
  const set = (id: string, d: Doing) => { of.value = { ...of.value, [id]: { ...of.value[id], ...d } } }
  const now = () => (card() ? of.value[card()!.id] ?? {} : {})
  const busy = computed(() => !!now().busy)
  const pressing = computed(() => !!now().pressing)
  const refused = computed(() => now().refused ?? '')
  const error = computed({ get: () => now().error ?? '', set: (v: string) => { if (card()) set(card()!.id, { error: v }) } })
  // An action's outcome on a task, whichever is on screen now.
  const failed = (id: string) => !!(of.value[id]?.error || of.value[id]?.refused)
  // Forget a task's state (it left the list).
  const forget = (id: string) => { if (of.value[id]) { const { [id]: _, ...rest } = of.value; of.value = rest } }
  let runs = 0
  // Still the run started last on that task, its step unchanged: else its end changes nothing.
  const mine = (id: string, run: number) => of.value[id]?.run === run
  async function on(c: Card, fn: () => Promise<unknown>, pressed = false) {
    const id = c.id
    const run = ++runs
    set(id, { busy: true, pressing: pressed, error: '', ...(pressed ? { refused: '' } : {}), step: stepOf(c), run })
    try {
      const out = await fn()
      if (out !== false) changed(id)
      return out
    }
    catch (e) { if (mine(id, run)) set(id, { error: (e as Error).message }) }
    finally { if (mine(id, run)) set(id, { busy: false, pressing: false }) }
  }
  const run = (fn: () => Promise<unknown>) => { const c = card(); return c ? on(c, fn).then(() => {}) : Promise.resolve() }
  const press = async () => {
    const c = card()
    if (!c) return
    const run = runs + 1
    await on(c, async () => {
      const { task } = await api<{ task: Task }>('/api/pm/step-user', { id: c.id })
      if (task.step?.yourTurn?.reason === 'action' && mine(c.id, run)) set(c.id, { refused: task.step.yourTurn.badge })
    }, true)
  }
  // The board is the truth: the step moved on (or the task is done), its pending action shows no more.
  watch(() => card() && [card()!.id, stepOf(card()!)] as const, (now) => {
    if (!now) return
    const [id, step] = now
    const d = of.value[id]
    if (d?.busy && d.step !== step) set(id, { busy: false, pressing: false, run: -1 })
  })
  watch(() => card()?.yourTurn, (b) => { const c = card(); if (c && of.value[c.id]?.refused && b !== of.value[c.id]!.refused) set(c.id, { refused: '' }) })
  const id = () => card()!.id
  return {
    busy, error, pressing, refused, failed, forget, run, press,
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
