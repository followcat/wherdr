<script setup lang="ts">
// The task sheet's "To do" tab: what a task waiting for the user needs from
// them, and the buttons for it, nothing else (taskTodo picks the case). A
// visual merge shows its screenshots large (swipe between them, tap to zoom),
// the review's verdict and the PR, then Merge or Send back with a note.
import { adviceChoices } from '#shared/pm/decisions'
import { canStart, linkLabel, mainLink, type Card } from '#shared/pm/board'
import { RESUMES, stoppedText, type Resume } from '#shared/pm/stop'
import { shotUrl } from '#shared/pm/shots'
import type { Choice } from '#shared/pm/verdict'
import type { Pane } from '#shared/types'
import type { WaitKind } from '#shared/pm/run'
import type { TodoKind } from '~/utils/taskTodo'

const props = defineProps<{ card: Card, kind: TodoKind, pane?: Pane, busy: boolean, pressing: boolean, refused: string, waitsFor?: string[] }>()
const emit = defineEmits<{ press: [], start: [], resume: [how: Resume], decide: [choice: Choice], back: [note: string] }>()

const badge = computed(() => stepRefusalText(props.card.yourTurn ?? ''))
const advice = computed(() => props.card.state?.yourTurn?.advice)
const choices = computed(() => (advice.value ? adviceChoices(advice.value) : { options: [] }))

// Visual merge: the newest step's screenshots of the result.
const shots = computed(() => {
  const s = shotSteps(props.card)[0]
  return s ? props.card.state!.shots![s.id]!.filter(x => x.phase === 'after').map(x => shotUrl(props.card.id, x.file)) : []
})
// Phone or desktop, from the image's shape once loaded.
const shape = ref<Record<string, 'phone' | 'desktop'>>({})
const loaded = (src: string, e: Event) => { const i = e.target as HTMLImageElement; shape.value = { ...shape.value, [src]: i.naturalWidth < i.naturalHeight ? 'phone' : 'desktop' } }
const verdict = computed(() => {
  const at = props.card.state?.at ?? 0
  const review = props.card.plan.slice(0, at).findLast(s => s.ends === 'verdict')
  if (!review) return ''
  const n = props.card.state?.rounds[review.id] ?? 0
  return n ? tl(`Review passed, ${n} send-back${n > 1 ? 's' : ''}`) : tl('Review passed')
})
const pr = computed(() => { const l = mainLink(props.card); return l && /\/pull\/\d+/.test(l.url) ? l : undefined })
const note = ref('')

const ASK_LABEL: Record<WaitKind, [string, string]> = { question: ['Its agent asks a question', 'Son agent pose une question'], permission: ['Its agent asks for a permission', 'Son agent demande une autorisation'], auth: ['Its agent needs its login again', 'Son agent doit se reconnecter'] }
</script>

<template>
  <div class="todo" :data-todo="kind" data-testid="task-todo">
    <template v-if="kind === 'merge'">
      <p class="todo-say" data-testid="task-badge">{{ badge }}</p>
      <ul class="todo-shots" data-testid="todo-shots">
        <li v-for="(src, i) in shots" :key="src">
          <button type="button" class="todo-shot" :aria-label="tl(`Screenshot ${i + 1}, full size`)" data-testid="shot" @click="openLightbox(shots, i)">
            <img :src="src" alt="" decoding="async" @load="loaded(src, $event)">
          </button>
          <span v-if="shape[src]" class="mono-label muted">{{ shape[src] === 'phone' ? tl('Phone', 'Téléphone') : tl('Desktop', 'Ordinateur') }}</span>
        </li>
      </ul>
      <div v-if="verdict || pr" class="todo-review">
        <span v-if="verdict" class="muted" data-testid="todo-verdict">{{ verdict }}</span>
        <a v-if="pr" :href="pr.url" target="_blank" rel="noopener" class="board-chip todo-pr" data-testid="todo-pr">{{ linkLabel(pr) }}</a>
      </div>
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

    <p v-else-if="!refused" class="todo-say" data-testid="task-badge">{{ badge }}</p>

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
      <div v-else class="task-sheet-actions">
        <UButton v-if="card.userLabel || kind === 'refused'" color="primary" size="xl" :loading="busy" data-testid="step-user" @click="emit('press')">{{ card.userLabel || tl('Try again', 'Réessayer') }}</UButton>
        <UButton v-if="kind === 'blocked' && canStart(card) && !waitsFor?.length" color="primary" size="xl" icon="i-lucide-play" :loading="busy" data-testid="task-start" @click="emit('start')">{{ tl('Start', 'Lancer') }}</UButton>
        <UButton v-if="pane && kind !== 'merge' && kind !== 'step'" :color="kind === 'ask' ? 'primary' : 'neutral'" :variant="kind === 'ask' ? 'solid' : 'outline'" size="xl" icon="i-lucide-terminal" :to="panePath(pane.id)" data-testid="todo-agent">
          {{ card.holder === 'reviewer' ? tl('Open the reviewer', 'Ouvrir le relecteur') : tl('Open the agent', 'Ouvrir l’agent') }}
        </UButton>
      </div>
    </div>
    <p v-if="pressing" class="muted" role="status" data-testid="step-user-busy">{{ tl('Running this step… A merge waits for the PR\'s checks, which can take a few minutes.', 'Étape en cours… Une fusion attend les vérifications de la PR, ce qui peut prendre quelques minutes.') }}</p>
    <p v-else-if="refused" class="error" role="alert" :title="refused" data-testid="step-user-refused">{{ stepRefusalText(refused) }}</p>

    <form v-if="kind === 'merge'" class="todo-back" data-testid="todo-back" @submit.prevent="emit('back', note.trim())">
      <UTextarea v-model="note" :rows="2" autoresize maxlength="2000" size="xl" :placeholder="tl('What to change')" data-testid="todo-back-note" />
      <UButton type="submit" color="neutral" variant="outline" size="xl" icon="i-lucide-undo-2" :disabled="busy || !note.trim()" data-testid="todo-back-send">{{ tl('Send back') }}</UButton>
    </form>
  </div>
</template>

<style scoped>
.todo { display: flex; flex-direction: column; gap: 12px; }
.todo p { margin: 0; }
.todo-say { color: var(--text); font-weight: 600; overflow-wrap: anywhere; }
.todo-actions { display: flex; flex-direction: column; gap: 10px; }
.todo-choice { display: grid; gap: 4px; justify-items: start; }
/* The screenshots large, one per screen width on the phone: swipe between them. */
.todo-shots { display: flex; gap: 12px; margin: 0; padding: 0 0 4px; list-style: none; overflow-x: auto; scroll-snap-type: x mandatory; overscroll-behavior-x: contain; }
.todo-shots li { flex: 0 0 auto; max-width: 100%; display: grid; gap: 4px; align-content: start; scroll-snap-align: start; }
.todo-shot { display: block; max-width: 100%; padding: 0; border: 1px solid var(--line); background: var(--surface); cursor: zoom-in; }
/* Large, yet leaving Merge in view. */
.todo-shot img { display: block; height: auto; max-height: min(40vh, 420px); max-width: 100%; width: auto; }
@media (max-width: 699px) { .todo-shot img { max-height: 26vh; } }
.todo-review { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.todo-pr { min-height: 44px; display: inline-flex; align-items: center; }
.todo-back { display: grid; gap: 8px; }
.todo-back > button { justify-self: start; }
</style>
