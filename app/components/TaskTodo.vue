<script setup lang="ts">
// The task sheet's "To do" tab: what a task waiting for the user needs from
// them, and the buttons for it, nothing else (taskTodo picks the case). A
// visual merge shows its TL;DR (TaskTldr: else the worker's and the reviewer's notes), its
// screenshots large (swipe between them, tap to zoom), the link to the full reports, then
// Merge or Send back with a note. A step the user ends shows the TL;DR too. A step to merge
// or a refused one has Open the PR when a link proof is a pull request (any host).
// Accept is there as soon as the review passed, whatever the PR's state: while the engine
// updates it, what goes on is said under it (prUpdating). Once accepted, it stays loading until
// the merge ends, what it waits for said under it; while its checks are red, it is on hold
// instead, with why (the worker fixes them, or waits to). A step the coordinator holds that
// waits on the user says what waits, and Ask the coordinator sends it the user's message.
import { adviceChoices } from '#shared/pm/decisions'
import { canStart, coordinatorWait, mayAccept, mergeGoesNow, mergeStuck, mergeWaits, prLink, prUpdating, type Card } from '#shared/pm/board'
import { stepLabels } from '#shared/pm/steps'
import { RESUMES, stoppedText, type Resume } from '#shared/pm/stop'
import { shotUrl } from '#shared/pm/shots'
import { reviewNote, workerNote } from '#shared/pm/report'
import { agentCatchingUp } from '#shared/pm/refusal'
import type { Choice } from '#shared/pm/verdict'
import type { Pane } from '#shared/types'
import type { WaitKind } from '#shared/pm/run'
import type { TodoKind } from '~/utils/taskTodo'

const props = defineProps<{ card: Card, kind: TodoKind, pane?: Pane, busy: boolean, pressing: boolean, refused: string, waitsFor?: string[] }>()
const emit = defineEmits<{ press: [], start: [], resume: [how: Resume], decide: [choice: Choice], back: [note: string], review: [], worker: [], ask: [], comments: [] }>()

// Where the engine's catch-up of a conflict stands: the agent on it, or done.
const told = computed(() => agentCatchingUp(props.card))
// An approved merge on its way (server state, the same after a reload): what it waits for.
const waits = computed(() => mergeWaits(props.card))
// It waits on something the engine cannot do alone: said plainly, with Start the worker, no spinner.
const stuck = computed(() => mergeStuck(props.card))
// Otherwise it goes on now (Merge loading), or it is held: red checks the worker fixes or waits to fix.
const goes = computed(() => !stuck.value && mergeGoesNow(props.card))
// Not the user's turn yet the engine updates its PR: Accept with the step's own badge, what goes on under it.
const open = computed(() => mayAccept(props.card))
const accepts = computed(() => !props.card.yourTurn && open.value)
const updating = computed(() => (accepts.value ? prUpdating(props.card) : undefined))
const badge = computed(() => (stuck.value ? tl(waits.value !== undefined ? 'Merge approved: it waits for its worker' : 'The merge waits for its worker') : goes.value ? tl('Merge approved: it merges by itself') : waits.value !== undefined ? `${tl('Merge approved, on hold')}: ${waits.value}` : accepts.value ? tl(stepLabels(props.card.plan[props.card.state!.at]!).badge) : stepRefusalText(props.card.yourTurn ?? '', told.value)))
const advice = computed(() => props.card.state?.yourTurn?.advice)
const choices = computed(() => (advice.value ? adviceChoices(advice.value) : { options: [] }))

// Visual merge: the newest step's screenshots of the result (after a rework, its new set).
const latest = computed(() => { const s = shotSteps(props.card)[0]; return s ? props.card.state!.shots![s.id]!.filter(x => x.phase === 'after') : [] })
const shots = computed(() => latest.value.map(x => shotUrl(props.card.id, x.file)))
const reworked = computed(() => latest.value.some(x => x.rework))
// Phone or desktop, from the image's shape once loaded.
const shape = ref<Record<string, 'phone' | 'desktop'>>({})
const loaded = (src: string, e: Event) => { const i = e.target as HTMLImageElement; shape.value = { ...shape.value, [src]: i.naturalWidth < i.naturalHeight ? 'phone' : 'desktop' } }
// The notes before the user's step: the worker's report and the review's verdict.
const notes = computed(() => (props.kind === 'merge' || props.kind === 'step') && props.card.state
  ? { worker: workerNote(props.card.plan, props.card.state), review: reviewNote(props.card.plan, props.card.state) }
  : {})
const pr = computed(() => (props.kind === 'merge' || props.kind === 'step' || props.kind === 'refused' ? prLink(props.card) : undefined))
const note = ref('')
// A stalled review in one plain sentence: its reviewer gone, or still there past the step's time limit.
const reviewSay = computed(() => (props.card.terminal
  ? tl(`The review has run over ${props.card.plan[props.card.state?.at ?? 0]?.timeout ?? 'its time limit'} without a verdict. Restart it to review the PR's latest commit from the start.`)
  : tl('The reviewer stopped without giving a verdict. Restart the review to review the PR\'s latest commit again.')))

// A step the coordinator holds, waiting on the user: since when (to the minute), its last `step wait` reason, asked yet.
const coord = computed(() => (props.kind === 'coordinator' ? coordinatorWait(props.card) : undefined))
const coordFor = computed(() => (coord.value ? fmtDuration(Math.floor((Date.now() - coord.value.since) / 60_000) * 60) : ''))

const ASK_LABEL: Record<WaitKind, [string, string]> = { question: ['Its agent asks a question', 'Son agent pose une question'], permission: ['Its agent asks for a permission', 'Son agent demande une autorisation'], auth: ['Its agent needs its login again', 'Son agent doit se reconnecter'] }
</script>

<template>
  <div class="todo" :data-todo="kind" data-testid="task-todo">
    <template v-if="kind === 'merge'">
      <LookAgainBanner v-if="card.state?.lookAgain" :look="card.state.lookAgain" />
      <p class="todo-say" data-testid="task-badge">{{ badge }}</p>
      <TaskTldr :card="card" :worker="notes.worker" :review="notes.review" @comments="emit('comments')">
        <span v-if="reworked" class="mono-label muted" data-testid="todo-rework">{{ tl('Screenshots after rework') }}</span>
        <ul class="todo-shots" data-testid="todo-shots">
          <li v-for="(src, i) in shots" :key="src">
            <button type="button" class="todo-shot" :aria-label="tl(`Screenshot ${i + 1}, full size`)" data-testid="shot" @click="openLightbox(shots, i)">
              <img :src="src" alt="" decoding="async" @load="loaded(src, $event)">
            </button>
            <span v-if="shape[src]" class="mono-label muted">{{ shape[src] === 'phone' ? tl('Phone', 'Téléphone') : tl('Desktop', 'Ordinateur') }}</span>
          </li>
        </ul>
      </TaskTldr>
    </template>

    <template v-else-if="kind === 'decide' && advice">
      <p class="todo-say" data-testid="task-badge">{{ card.yourTurn }}</p>
      <p class="muted">{{ advice.why }}</p>
    </template>

    <p v-else-if="kind === 'stopped'" class="todo-say" data-testid="task-badge">{{ stoppedText(card.stopped!) }} · {{ fmtDateTime(card.stopped!.at) }}</p>

    <template v-else-if="kind === 'ask'">
      <p class="mono-label">{{ tl(...ASK_LABEL[card.asks!.kind]) }}</p>
      <p class="todo-say task-desc" data-testid="task-badge">{{ card.asks!.text }}</p>
      <p v-if="!pane" class="muted">{{ tl('Its agent is not on screen here: open it from its machine.') }}</p>
    </template>

    <template v-else-if="kind === 'coordinator' && coord">
      <p class="todo-say" data-testid="task-badge">{{ tl(`Waiting for the coordinator to check the ${coord.step}`) }}</p>
      <p class="muted" data-testid="todo-coordinator-wait">{{ tl(`At this step for ${coordFor}`) }}<template v-if="coord.reason"> · {{ tl('Coordinator:') }} {{ coord.reason }}</template></p>
    </template>

    <p v-else-if="kind === 'review'" class="todo-say" data-testid="task-badge">{{ reviewSay }}</p>

    <template v-else-if="!refused">
      <p class="todo-say" data-testid="task-badge">{{ badge }}</p>
      <TaskTldr :card="card" :worker="notes.worker" :review="notes.review" @comments="emit('comments')" />
    </template>

    <div class="todo-actions">
      <template v-if="kind === 'decide'">
        <div v-for="o in choices.options" :key="o" class="todo-choice">
          <UButton size="xl" :color="o === choices.recommend ? 'primary' : 'neutral'" :variant="o === choices.recommend ? 'solid' : 'outline'" :disabled="busy" :data-choice="o" @click="emit('decide', o)">
            {{ tl(...CHOICE_LABEL[o]) }}<template v-if="o === choices.recommend"> · {{ tl('recommended', 'conseillé') }}</template>
          </UButton>
          <small class="muted">{{ tl(CHOICE_MEANING[o]) }}</small>
        </div>
      </template>
      <template v-else-if="kind === 'stopped'">
        <div v-for="how in RESUMES" :key="how" class="todo-choice">
          <UButton size="xl" :color="how === 'continue' ? 'primary' : 'neutral'" :variant="how === 'continue' ? 'solid' : 'outline'" :disabled="busy" :data-resume="how" @click="emit('resume', how)">{{ tl(...RESUME_LABEL[how]) }}</UButton>
          <small class="muted">{{ tl(RESUME_MEANING[how]) }}</small>
        </div>
      </template>
      <div v-else class="task-sheet-actions todo-buttons">
        <!-- A refused action is tried again from the sheet's top (Try again). -->
        <UButton v-if="card.userLabel && kind !== 'refused'" color="primary" size="xl" :loading="busy || goes" :disabled="!open && (!!stuck || (waits !== undefined && !goes))" data-testid="step-user" @click="emit('press')">{{ waits !== undefined && !stuck ? tl('Merging') : card.userLabel }}</UButton>
        <UButton v-if="pr" color="neutral" variant="outline" size="xl" icon="i-lucide-square-arrow-out-up-right" :to="pr.url" target="_blank" data-testid="todo-pr">{{ tl('Open the PR') }}</UButton>
        <UButton v-if="stuck" color="primary" size="xl" icon="i-lucide-play" :loading="busy" data-testid="todo-worker-start" @click="emit('worker')">{{ tl('Start the worker') }}</UButton>
        <UButton v-if="kind === 'review'" color="primary" size="xl" icon="i-lucide-rotate-ccw" :loading="busy" data-testid="todo-review-restart" @click="emit('review')">{{ tl('Restart the review') }}</UButton>
        <UButton v-if="coord" color="primary" size="xl" :icon="coord.asked ? 'i-lucide-check' : 'i-lucide-message-circle'" :loading="busy" :disabled="coord.asked !== undefined" data-testid="todo-ask-coordinator" @click="emit('ask')">{{ coord.asked ? tl('Asked') : tl('Ask the coordinator') }}</UButton>
        <UButton v-if="kind === 'blocked' && canStart(card) && !waitsFor?.length" color="primary" size="xl" icon="i-lucide-play" :loading="busy" data-testid="task-start" @click="emit('start')">{{ tl('Start', 'Lancer') }}</UButton>
        <!-- Open the agent: next to the task's other buttons (AgentButton), not here. -->
      </div>
    </div>
    <p v-if="pressing" class="muted" role="status" data-testid="step-user-busy">{{ tl('Running this step… A merge waits for the PR\'s checks, which can take a few minutes.', 'Étape en cours… Une fusion attend les vérifications de la PR, ce qui peut prendre quelques minutes.') }}</p>
    <p v-else-if="stuck" class="error" role="alert" data-testid="step-user-stuck">{{ tl(stuck) }}</p>
    <p v-else-if="waits !== undefined" class="muted" role="status" data-testid="step-user-waits">{{ tl('Waiting:') }} {{ waits }}</p>
    <p v-else-if="updating" class="muted" role="status" data-testid="step-user-updating">{{ tl(`${updating[0]!.toUpperCase()}${updating.slice(1)}: accept now, it merges once the PR is ready.`) }}</p>
    <p v-else-if="coord?.asked" class="muted" role="status" data-testid="todo-asked">{{ tl('Sent as your message. The coordinator checks it now; the task comes back here at its next time limit.') }}</p>
    <p v-else-if="refused" class="error" role="alert" :title="refused" data-testid="step-user-refused">{{ stepRefusalText(refused, told) }}</p>

    <form v-if="kind === 'merge'" class="todo-back" data-testid="todo-back" @submit.prevent="emit('back', note.trim())">
      <UTextarea v-model="note" :rows="2" autoresize maxlength="2000" size="xl" :placeholder="tl('What to change')" data-testid="todo-back-note" />
      <UButton type="submit" color="neutral" variant="outline" size="xl" icon="i-lucide-undo-2" :disabled="busy || !note.trim()" data-testid="todo-back-send">{{ tl('Send back') }}</UButton>
    </form>
  </div>
</template>

<style scoped>
.todo { display: flex; flex-direction: column; gap: 12px; flex: 1 0 auto; }
.todo p { margin: 0; }
.todo-say { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
.todo-actions { display: flex; flex-direction: column; gap: 10px; }
.todo-choice { display: grid; gap: 4px; justify-items: start; }
/* The step's button beside Open the PR: one row, wrapping on the phone. */
.todo-actions .task-sheet-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
/* The screenshots large, one per screen width on the phone: swipe between
   them (a thin bar under the row). On a computer they wrap as a grid. */
.todo-shots { display: flex; gap: 12px; margin: 0; padding: 0 0 6px; list-style: none; overflow-x: auto; scroll-snap-type: x mandatory; overscroll-behavior-x: contain; }
.todo-shots li { flex: 0 0 auto; max-width: 100%; display: grid; gap: 4px; align-content: start; scroll-snap-align: start; }
.todo-shot { display: block; max-width: 100%; padding: 0; border: 1px solid var(--line); background: var(--surface); cursor: zoom-in; }
/* Large, yet leaving Merge in view. */
.todo-shot img { display: block; height: auto; max-height: min(40vh, 420px); max-width: 100%; width: auto; }
/* On the phone the step's buttons (Merge…) stay pinned at the bottom of the
   sheet while its content scrolls: always in reach, flush with the sheet's edge,
   the home bar's room inside the bar (--sheet-safe). The sheet's body then adds
   no padding below it (main.css), so nothing shows under it; the bar comes last
   (order), under the step's status and Send back, and at the bottom of a short tab.
   While a field of the sheet is typed in, it hides (below). */
@media (max-width: 699px) {
  .todo-shot img { max-height: 26vh; }
  .todo-actions .task-sheet-actions > * { flex: 1 1 auto; justify-content: center; }
  :global(.hw-sheet > [data-slot="body"]:not(.typing):has(.todo-actions > .todo-buttons:not(:empty))) { padding-bottom: 0; }
  .todo-actions:has(> .todo-buttons:not(:empty)) { order: 1; margin-top: auto; position: sticky; bottom: 0; z-index: 1; padding: 10px 0 calc(10px + var(--sheet-safe, 0px)); background: var(--sheet-bg, var(--bg)); border-top: 1px solid var(--line-soft); }
  /* A field typed in (Send back's note, AppSheet `.typing`): the bar hides, so
     it never covers the text; Send back stays right under its field. */
  :global(.hw-sheet:has(> .typing) .todo-actions:has(> .todo-buttons:not(:empty))) { display: none; }
}
/* On a computer the screenshots wrap as a grid. */
@media (min-width: 700px) {
  .todo-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); overflow: visible; padding: 0; }
  .todo-shots li { min-width: 0; justify-items: start; }
}
.todo-back { display: grid; gap: 8px; }
.todo-back > button { justify-self: start; }
</style>
