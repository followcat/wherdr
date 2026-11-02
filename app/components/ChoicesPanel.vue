<script setup lang="ts">
// Blocking prompt of the open agent: question + options as big buttons.
// Recognized waiting screen (`screen`: Codex hooks, trust, login…):
// its title, a line of explanation, the box text, and the keys of its
// legend as buttons ("Trust all (t)"). Nothing is sent without a click.
// Free answer (`free` option, omp's "Other"): the option opens a field under
// it, and the text goes with the choice (the server opens omp's field and types
// it there). omp's field already open (`typing`): ours too, and Cancel closes
// it in the terminal (Escape).
// Claude's AskUserQuestion: "Type something." is its free answer (typed in
// place by the server), checkboxes are toggled one by one then sent by Submit.
// omp "Ask" box with several questions: its tabs above the question
// (questions then Submit), to go back to one like ←/→ in the terminal.
import type { Choices, WaitAction, WaitScreen } from '#shared/types'

const props = defineProps<{ paneId: string, prompt?: Choices | null, screen?: WaitScreen | null, keys?: boolean }>()
const busy = ref(false)
const cursor = ref(props.prompt?.cursor)
// Arrow keys sent and not answered yet: the same question read again (the
// server broadcasts its state whenever anything moves) keeps the cursor the
// arrow already painted, until the server's own cursor moves.
let navPending = 0
watch(() => props.prompt, (p, old) => {
  if (navPending && p && old && p.cursor === old.cursor && p.identity === old.identity) return
  cursor.value = p?.cursor
})
watch(() => [props.prompt, props.screen], () => { busy.value = false })

// With options, Enter already confirms them: we only keep the other keys (Escape…).
const actions = computed(() => (props.screen ? props.screen.actions.filter(a => !(props.prompt && a.key === 'enter')) : []))
const note = computed(() => (props.screen ? screenNote(props.screen.kind) : null))
// Aligned columns (hooks table): no wrapping; running text: wrapping.
const tabular = computed(() => Boolean(props.screen && props.screen.lines.some(l => /\S {3,}\S/.test(l))))
const question = computed(() => props.prompt?.kind === 'self-update' ? t(props.prompt.question || '') : (props.screen && props.screen.title) || (props.prompt && props.prompt.question))

async function pick(i: number, label: string) {
  busy.value = true
  if (!(await choose(props.paneId, i, label, props.prompt?.identity))) busy.value = false
}
async function press(a: WaitAction) {
  busy.value = true
  if (!(await pressScreenKey(props.paneId, a, props.screen?.identity))) busy.value = false
}
// Codex stopped by its update: the user relaunches it themselves, or not at all.
const dismissable = computed(() => props.prompt?.kind === 'self-update')
async function dismiss() {
  busy.value = true
  if (!(await dismissStopped(props.paneId))) busy.value = false
}
// Checkboxes (omp): Enter moves to the next question.
async function next() {
  busy.value = true
  if (!(await navKey(props.paneId, 'enter', props.prompt?.identity))) busy.value = false
}
// Claude's checkboxes come with their own Submit (an option without a box):
// no Continue button then.
const ownSubmit = computed(() => Boolean(props.prompt && props.prompt.options.some(o => o.checked === undefined)))
const tabs = computed(() => (props.prompt && props.prompt.tabs && props.prompt.tab !== undefined && !props.prompt.typing ? props.prompt.tabs : null))
async function goTab(i: number) {
  const p = props.prompt
  if (!p || !p.tabs || i === p.tab || disabled.value) return
  busy.value = true
  // A free-answer draft: it was for the question left behind.
  if (await askTab(props.paneId, i, p.tabs[i]!)) freeText.value = ''
  else busy.value = false
}

// Free-answer field: index of its option, or null when closed.
const editing = ref<number | null>(null)
const freeText = ref('')
// Sending: `busy` goes back to false with every new state received, while the
// server is still typing the answer (a second send would cut it).
const sending = ref(false)
const freeAt = computed(() => (props.prompt?.typing ? props.prompt.options.findIndex(o => o.free) : editing.value))
// Another question: field closed (the draft stays, in case sending failed).
watch(() => props.prompt?.question, () => { editing.value = null })
const enterSends = computed(() => desk.value && !isIOS && !touchKeyboard)
async function sendFree(i: number, label: string) {
  const text = freeText.value.trim()
  if (!text || disabled.value || sending.value) return
  busy.value = true
  sending.value = true
  try {
    if (await choose(props.paneId, i, label, props.prompt?.identity, { text, question: props.prompt?.question ?? null })) {
      freeText.value = ''
      editing.value = null
    } else busy.value = false
  } finally {
    sending.value = false
  }
}
function cancelFree() {
  if (props.prompt?.typing) navKey(props.paneId, 'esc')
  else editing.value = null
}
function onFreeKey(e: KeyboardEvent, i: number, label: string) {
  // 229: the Enter that confirms a composition (IME) in Safari.
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    cancelFree()
  } else if (e.key === 'Enter' && !e.shiftKey && enterSends.value) {
    e.preventDefault()
    sendFree(i, label)
  }
}

// Keyboard (computer, active view) on a prompt with options: ↑ ↓ Enter Escape
// go to the terminal (the card follows the re-read screen), 1-9 picks the
// option (or opens the free-answer field), ←/→ change tabs. Field open: the
// keyboard is its own.
const disabled = computed(() => busy.value || props.prompt?.unavailable || props.screen?.unavailable || !eventsOpen.value || offlineView.value)
const keyboard = computed(() => Boolean(props.keys && desk.value && props.prompt && !props.prompt.kind && props.prompt.options.length && freeAt.value === null && !disabled.value))
useCardKeys(() => keyboard.value, () => ({ digits: Math.min(9, props.prompt?.options.length || 0), enter: true, tabs: Boolean(tabs.value) || Boolean(props.prompt?.horizontal) }), (k) => {
  const p = props.prompt
  if (!p) return
  if (k.kind === 'digit') {
    const o = p.options[k.n - 1]!
    if (o.free) editing.value = k.n - 1
    else pick(k.n - 1, o.label)
    return
  }
  // Like ←/→: key by key, in typing order (without waiting for the state).
  if (k.kind === 'tab') {
    if (p.horizontal && cursor.value !== null && cursor.value !== undefined) {
      cursor.value = (cursor.value + (k.dir > 0 ? 1 : -1) + p.options.length) % p.options.length
    }
    if (p.horizontal) {
      navPending++
      navKey(props.paneId, k.dir > 0 ? 'right' : 'left').then((ok) => {
        navPending--
        if (!ok) cursor.value = props.prompt?.cursor
      })
      return
    }
    return navKey(props.paneId, k.dir > 0 ? 'right' : 'left')
  }
  if (k.kind === 'nav') {
    // OpenCode's permission dialog only moves with ←/→ (⇆ select).
    if (p.horizontal) return
    if ((k.key === 'up' || k.key === 'down') && cursor.value !== null && cursor.value !== undefined) {
      cursor.value = Math.max(0, Math.min(p.options.length - 1, cursor.value + (k.key === 'down' ? 1 : -1)))
    }
    navPending++
    navKey(props.paneId, k.key, p.identity).then((ok) => {
      navPending--
      if (!ok) cursor.value = props.prompt?.cursor
    })
  }
})
</script>

<template>
  <div class="choices" :class="{ 'choices-screen': screen }">
    <p class="eyebrow choices-eyebrow"><i />{{ t('Your turn') }}</p>
    <div v-if="tabs" class="choices-tabs" role="group" :aria-label="t('Questions')">
      <button
        v-for="(label, i) in tabs" :key="i" type="button" :class="{ on: i === prompt!.tab }"
        :aria-current="i === prompt!.tab ? 'step' : undefined" :disabled="disabled" @click="goTab(i)"
      >
        {{ label }}
      </button>
    </div>
    <!-- Permission request: what is requested, instead of the raw box text. -->
    <PromptDetailBlock v-if="prompt?.detail" :detail="prompt.detail" />
    <p v-if="question" class="choices-q">{{ question }}</p>
    <p v-if="prompt?.unavailable || screen?.unavailable" class="choices-note" role="status">{{ tl('Screen read failed. Retrying…', 'Lecture de l’écran impossible. Nouvelle tentative…') }}</p>
    <p v-if="note" class="choices-note">{{ note }}</p>
    <pre v-if="screen && screen.lines.length && !prompt?.detail" class="choices-screen-text" :class="{ wrap: !tabular }">{{ screen.lines.join('\n') }}</pre>
    <div v-if="prompt" class="choices-list" :class="{ multi: prompt.multi }">
      <template v-for="(o, i) in prompt.options" :key="i">
        <button
          type="button" :class="{ cur: i === cursor, on: o.checked }"
          :aria-pressed="prompt.multi && !o.free ? Boolean(o.checked) : undefined"
          :aria-expanded="o.free ? freeAt === i : undefined"
          :disabled="disabled" @click="o.free ? (editing = prompt.typing || editing === i ? null : i) : pick(i, o.label)"
        >
          <span v-if="prompt.multi && o.checked !== undefined" class="n"><UIcon :name="o.checked ? 'i-lucide-square-check' : 'i-lucide-square'" /></span>
          <span v-else class="n">{{ i + 1 }}</span>
          <span class="l">{{ prompt.kind === 'self-update' ? t(o.label) : o.label }}<small v-if="o.hint">{{ prompt.kind === 'self-update' ? t(o.hint) : o.hint }}</small></span>
          <UIcon v-if="o.free" name="i-lucide-pencil-line" class="choices-free-icon" />
        </button>
        <form v-if="o.free && freeAt === i" class="choices-free" @submit.prevent="sendFree(i, o.label)">
          <UTextarea
            v-model="freeText" :rows="1" :maxrows="6" autoresize :autofocus="!prompt.typing" size="lg" class="w-full"
            :placeholder="t('Your answer…')" :disabled="disabled || sending" @keydown="onFreeKey($event, i, o.label)"
          />
          <div class="choices-free-actions">
            <UButton type="button" color="neutral" variant="ghost" size="sm" :disabled="disabled || sending" @click="cancelFree">{{ t('Cancel') }}</UButton>
            <UButton type="submit" color="primary" variant="solid" size="sm" :loading="sending" :disabled="disabled || sending || !freeText.trim()">{{ t('Send') }}</UButton>
          </div>
        </form>
      </template>
      <button v-if="prompt.multi && !ownSubmit" type="button" class="choices-next" :disabled="disabled" @click="next">
        {{ t('Continue') }}<kbd>{{ screenKeyName('enter') }}</kbd>
      </button>
    </div>
    <div v-if="actions.length || keyboard || dismissable" class="choices-keys">
      <button v-if="dismissable" type="button" :disabled="disabled" @click="dismiss">{{ t('Dismiss') }}</button>
      <button
        v-for="a in actions" :key="a.key + a.label" type="button"
        :disabled="disabled" @click="press(a)"
      >
        {{ screenActionText(a) }}<kbd>{{ screenKeyName(a.key) }}</kbd>
      </button>
      <span v-if="keyboard" class="card-kbd" aria-hidden="true"><kbd v-if="tabs || prompt!.horizontal">←→</kbd><kbd v-if="!prompt!.horizontal">↑↓</kbd><kbd>{{ screenKeyName('enter') }}</kbd><kbd>1–{{ Math.min(9, prompt!.options.length) }}</kbd></span>
    </div>
  </div>
</template>
