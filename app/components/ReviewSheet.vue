<script setup lang="ts">
// Tasks to review, one at a time (a sheet on the phone, a window on a computer):
// what waits for the user on the board (Your turn), under the filter at the top
// (useReview.ts). A task to approve shows its key, title and project, its TL;DR
// (TaskTldr), its newest screenshots (TaskShots, the task sheet's viewer), its PR
// and the review's verdict in one line, then Approve (the To do tab's Accept: it
// leaves the list, the engine merges it in its own order) and Reject (ReviewReject:
// a note and screenshots back to its worker; it leaves the list too). Anything
// else that waits (a question, a failure, a decision, another step of the user's)
// shows its To do tab's answers (TaskTodo, the same actions as the task's sheet,
// useTaskActions), Try again for a failed action, and Open the task. An agent's
// question (ReviewQuestion) is answered here: its choices or another answer go
// to the agent (POST /api/pm/answer), it leaves the list like an approved one;
// Open the task stays. Open the agent (AgentButton) is on every task, whatever
// its step, disabled once its agent ended. Answered elsewhere (a coordinator's
// tell, the agent's conversation): read again as the agent works (watchTaskAgents). "3 of 12"
// with previous and next (a task passed over stays in the list); on a computer
// → next, ← previous, A approve, R reject. After the last one: All done.
// Approve and Send back say so on their button for a moment (DONE_MS), then the
// next task slides in from the right (the arrows slide too, in their direction;
// a fade under prefers-reduced-motion, and into All done). A failure stays put.
// On a computer: one fixed size, only the task's content scrolls.
import { linkLabel, mayAccept, prLink, taskRow, type Board, type Card, type ToHandle } from '#shared/pm/board'
import { reviewLine, reviewNote, workerNote } from '#shared/pm/report'
import { shotMode } from '#shared/pm/shots'
import { projectOption } from '~/utils/projectOption'

const emit = defineEmits<{ closed: [] }>()
const open = ref(true)
const data = ref<Board | null>(null)
const load = () => api<Board>('/api/pm/board').then((b) => { data.value = b }, () => {})
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { load(); timer = setInterval(() => { if (!document.hidden) load() }, 10_000); addEventListener('keydown', onKey) })
onBeforeUnmount(() => { clearInterval(timer); removeEventListener('keydown', onKey) })
watch(taskSheetTick, load)

const projects = computed(() => data.value?.projects ?? [])
const filterItems = computed(() => [
  { label: tl('Follow group tab'), value: REVIEW_FOLLOW },
  { label: tl('All'), value: REVIEW_ALL },
  ...machineGroups.value.map(g => ({ label: g.name, value: g.id })),
  ...projects.value.map(p => projectOption(p, `p:${p.key}`)),
])
const known = (v: string) => filterItems.value.some(i => i.value === v) || (!data.value && v.startsWith('p:'))
const filter = computed({ get: () => reviewPick(known), set: (v: string) => { reviewFilter.value = v } })

// Approved or rejected here: off the list at once, before the board says so.
const handled = ref<string[]>([])
const items = computed(() => (data.value?.cards ?? []).filter(c => c.yourTurn && !c.state?.done && !handled.value.includes(c.id) && reviewShows(filter.value, c.project)))
// items.length: past the last one, All done.
const at = ref(0)
const index = computed(() => Math.min(at.value, items.value.length))
// Approved or sent back: kept on screen with its confirmation, whatever the board reads meanwhile.
const held = ref<Card>()
const done = ref<'' | 'approved' | 'sent' | 'answered'>('')
const heldAt = ref('')
const card = computed<Card | undefined>(() => held.value ?? items.value[index.value])
// Another filter, or another home tab followed: back to the first one.
watch([filter, machineBarPick], () => { at.value = 0 })
const dir = ref(1)
const go = (step: number) => {
  if (done.value) return
  dir.value = step
  at.value = Math.max(0, Math.min(index.value + step, items.value.length))
}
const progress = computed(() => (held.value ? heldAt.value : tl(`${index.value + 1} of ${items.value.length}`)))
const still = ref(false)
onMounted(() => { still.value = matchMedia('(prefers-reduced-motion: reduce)').matches })
const motion = computed(() => (still.value || !card.value ? 'review-fade' : dir.value > 0 ? 'review-slide-next' : 'review-slide-prev'))

const kind = computed(() => (card.value ? taskTodo(card.value) : undefined))
// Only a merge to accept: another step of the user's (Create these tasks…) keeps its own button, in the task's sheet.
const approves = computed(() => !!card.value && (kind.value === 'merge' || kind.value === 'step') && mayAccept(card.value))
const row = computed<ToHandle | undefined>(() => (card.value ? taskRow(card.value) : undefined))
const shotStep = computed(() => (card.value ? shotSteps(card.value)[0] : undefined))
const shots = computed(() => (shotStep.value ? card.value!.state!.shots![shotStep.value.id]! : []))
const pr = computed(() => (card.value ? prLink(card.value) : undefined))
const state = computed(() => card.value?.state)
const verdict = computed(() => (card.value && state.value ? reviewLine(card.value.plan, state.value.at, state.value.rounds) : undefined))
const notes = computed(() => (card.value && state.value ? { worker: workerNote(card.value.plan, state.value), review: reviewNote(card.value.plan, state.value) } : {}))

const pane = computed(() => (card.value?.terminal ? herdrState.value?.panes.find(p => p.coreAddress === card.value!.terminal) : undefined))
const { busy, error, pressing, refused, press, start, resume, decide, sendBack, restartReview, startWorker } = useTaskActions(() => card.value, taskChanged)
const rejecting = ref(false)
watch(() => card.value?.id, () => { error.value = ''; rejecting.value = false })
const DONE_MS = 400
// Done with the current one: its confirmation, then off the list, the next one shows.
async function leave(c: Card, how: 'approved' | 'sent' | 'answered') {
  if (error.value || refused.value) return
  heldAt.value = progress.value
  held.value = c
  done.value = how
  await new Promise(r => setTimeout(r, DONE_MS))
  dir.value = 1
  handled.value = [...handled.value, c.id]
  held.value = undefined
  done.value = ''
}
async function approve() {
  const c = card.value
  if (!c || !approves.value || busy.value || done.value) return
  await press()
  await leave(c, 'approved')
}
async function reject(note: string, shots: string[]) {
  const c = card.value
  if (!c || done.value) return
  await sendBack(note, shots)
  if (!error.value) rejecting.value = false
  await leave(c, 'sent')
}

// An agent's question answered here: typed to the agent, then the next one.
const asked = computed(() => card.value?.asks?.kind === 'question')
const answering = ref(false)
const answered = ref<string>()
async function reply(text: string) {
  const c = card.value
  if (!c || answering.value || done.value) return
  answering.value = true
  error.value = ''
  try {
    await api('/api/pm/answer', { id: c.id, text })
    answered.value = text
    taskChanged()
  }
  catch (e) { error.value = (e as Error).message }
  finally { answering.value = false }
  await leave(c, 'answered')
  answered.value = undefined
}

// Where the user answers anything else: the task's sheet.
function answer() {
  const c = card.value
  if (!c) return
  open.value = false
  openTaskSheet(c.id)
}

function onKey(e: KeyboardEvent) {
  // The screenshot viewer open over it has its own keys (← →).
  if (e.defaultPrevented || lightboxSrc.value || e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement)?.closest?.('input, textarea, select, [contenteditable="true"], [role="listbox"]')) return
  const k = e.key.toLowerCase()
  if (k === 'arrowright') go(1)
  else if (k === 'arrowleft') go(-1)
  else if (k === 'a') approve()
  else if (k === 'r' && approves.value && !done.value) rejecting.value = true
  else return
  e.preventDefault()
}
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Tasks to review')" tall @closed="emit('closed')">
    <div class="review review-sheet" data-testid="review-sheet">
      <ProjectSelect v-model="filter" :items="filterItems" size="lg" class="review-filter" :aria-label="tl('Tasks shown')" data-testid="review-filter" />

      <div class="review-stage" :data-motion="still ? 'fade' : 'slide'" data-testid="review-stage">
        <Transition :name="motion">
      <article v-if="card && row" :key="card.id" class="review-item" :data-task="card.id" :data-kind="approves ? 'approve' : 'answer'" data-testid="review-item">
        <header class="review-head">
          <ProjectBadge :text="card.shown" :color="card.color" />
          <h3>{{ card.title }}</h3>
        </header>
        <div class="review-scroll">
        <template v-if="approves">
          <TaskTldr :card="card" :worker="notes.worker" :review="notes.review" @comments="answer()">
            <TaskShots v-if="shots.length && shotStep" :task="card.id" :shots="shots" :mode="shotMode(shotStep)" />
          </TaskTldr>
          <p class="review-meta">
            <a v-if="pr" :href="pr.url" target="_blank" rel="noopener" data-testid="review-pr">{{ linkLabel(pr) }}</a>
            <span v-if="verdict" data-testid="review-verdict">{{ tl(verdict) }}</span>
          </p>
        </template>
        <ReviewQuestion v-else-if="asked" :card="card" :busy="answering" :sent="answered" @send="reply" />
        <TaskTodo v-else-if="kind" :card="card" :kind="kind" :pane="pane" :busy="busy" :pressing="pressing" :refused="refused"
          @press="press" @start="start" @resume="resume" @decide="decide" @back="sendBack" @review="restartReview" @worker="startWorker" @comments="answer()" />
        <ReviewReject v-if="approves && rejecting" :card="card" :busy="busy" @send="reject" @cancel="rejecting = false" />
        <p v-if="error" class="error" role="alert" data-testid="review-error">{{ error }}</p>
        <p v-if="approves && refused" class="error" role="alert" data-testid="review-refused">{{ stepRefusalText(refused) }}</p>
        </div>
      </article>

      <div v-else-if="data" key="done" class="review-done" data-testid="review-done">
        <UIcon name="i-lucide-check-check" class="review-done-icon" />
        <p><b>{{ tl('All done') }}</b></p>
        <p class="muted">{{ items.length ? tl(`${items.length} passed over, still in the list.`) : tl('The engine takes over: approved tasks merge in their own order.') }}</p>
        <UButton v-if="items.length" color="neutral" variant="outline" size="xl" icon="i-lucide-rotate-ccw" data-testid="review-restart" @click="at = 0">{{ tl('Back to the first') }}</UButton>
      </div>
        </Transition>
      </div>
    </div>

    <template #footer>
      <div v-if="card" class="review-foot">
        <div class="review-choices" aria-live="polite">
          <template v-if="approves">
            <UButton color="primary" size="xl" :icon="done === 'approved' ? 'i-lucide-check-check' : 'i-lucide-check'" :class="{ confirmed: done === 'approved' }" :loading="busy && !rejecting" :disabled="rejecting || done === 'sent'" data-testid="review-approve" @click="approve">{{ done === 'approved' ? tl('Approved') : tl('Approve') }}</UButton>
            <UButton color="error" variant="outline" size="xl" :icon="done === 'sent' ? 'i-lucide-check' : 'i-lucide-undo-2'" :class="{ confirmed: done === 'sent' }" :disabled="busy || rejecting || done === 'approved'" data-testid="review-reject-open" @click="!done && (rejecting = true)">{{ done === 'sent' ? tl('Sent back') : tl('Reject') }}</UButton>
          </template>
          <template v-else>
            <UButton v-if="kind === 'refused'" color="primary" size="xl" icon="i-lucide-rotate-ccw" :loading="busy" data-testid="review-retry" @click="press">{{ tl('Try again') }}</UButton>
            <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-square-arrow-out-up-right" data-testid="review-answer" @click="answer()">{{ tl('Open the task') }}</UButton>
          </template>
          <AgentButton :card="card" @opened="open = false" />
        </div>
        <nav class="review-nav" :aria-label="tl('Progress')">
          <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn" :disabled="index === 0 || !!done" :aria-label="tl('Previous')" data-testid="review-prev" @click="go(-1)" />
          <span class="mono-label" data-testid="review-progress">{{ progress }}</span>
          <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" size="lg" class="icon-btn" :disabled="!!done" :aria-label="tl('Next')" data-testid="review-next" @click="go(1)" />
        </nav>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.review { display: flex; flex-direction: column; gap: 12px; flex: 1 0 auto; min-width: 0; padding: 0 16px; }
.review p { margin: 0; }
.review-filter { width: 100%; }
.review-stage { display: grid; min-width: 0; overflow-x: clip; }
.review-stage > * { grid-area: 1 / 1; min-width: 0; }
.review-item, .review-scroll { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.review-scroll > * { flex: none; }
/* The next task slides in, the current one out (prev: the other way). */
.review-slide-next-enter-active, .review-slide-next-leave-active, .review-slide-prev-enter-active, .review-slide-prev-leave-active { transition: transform .25s cubic-bezier(.2, .8, .2, 1); }
.review-fade-enter-active, .review-fade-leave-active { transition: opacity .15s ease-out; }
.review-slide-next-leave-active, .review-slide-prev-leave-active, .review-fade-leave-active { pointer-events: none; }
.review-slide-next-enter-from, .review-slide-prev-leave-to { transform: translateX(100%); }
.review-slide-next-leave-to, .review-slide-prev-enter-from { transform: translateX(-100%); }
.review-fade-enter-from, .review-fade-leave-to { opacity: 0; }
.review-choices .confirmed { pointer-events: none; border-color: var(--done); background: var(--done); color: var(--bg); }
.review-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.review-head h3 { flex: 1; min-width: 0; margin: 0; font: 600 16px/1.3 var(--display); overflow-wrap: anywhere; }
.review-meta { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--muted); font: 12px/1.4 var(--mono); }
.review-meta a { color: var(--accent); }
/* All done: icon, title, line and button grouped, centred in the body; the button at its own size. */
.review-done { display: flex; flex-direction: column; align-items: center; justify-content: center; align-self: center; gap: 8px; padding: 32px 0; text-align: center; }
.review-done > * { flex: none; }
.review:has(> .review-stage > .review-done) { min-height: 100%; }
.review-stage:has(> .review-done) { flex: 1 0 auto; }
.review-done .review-restart { margin-top: 4px; }
.review-done-icon { width: 32px; height: 32px; color: var(--done); }
.review-foot { display: grid; gap: 8px; padding: 12px 16px 0; border-top: 1px solid var(--line-soft); }
.review-choices { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 8px; }
.review-nav { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
@media (max-width: 699px) {
  .review-choices > * { flex: 1 1 auto; justify-content: center; }
  /* A field typed in (Reject's note, AppSheet `.typing`): the pinned choices
     hide, so they never cover the text; Send back stays under its field. */
  :global(.hw-sheet:has(> .typing) > [data-slot="footer"]:has(.review-foot)) { display: none; }
}
</style>
