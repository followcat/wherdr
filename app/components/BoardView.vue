<script setup lang="ts">
// The board: Your turn first, then the columns of the project's template
// (To do / Working / Done for all projects, with the step on the card). A
// card's indicator is the live state of the agent holding its step.
import { boardLanes, boardTags, mainLink, type Board, type Card } from '#shared/pm/board'
import type { Pane } from '#shared/types'

const data = ref<Board | null>(null)
const error = ref('')
const project = ref('') // '' = all projects
const tag = ref('') // '' = every tag
const open = ref<string | null>(null)

async function load() {
  try { data.value = await api<Board>('/api/pm/board'); error.value = ''; loadCoordinators() }
  catch (e) { error.value = (e as Error).message }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { load(); timer = setInterval(load, 10_000) })
onBeforeUnmount(() => clearInterval(timer))

// An agent asking a question or a permission puts its card in Your turn too.
const waitsForYou = (c: Card) => { const p = paneOf(c); return !!p && hasAgent(c) && statusKey(p) === 'blocked' }
const cards = computed(() => (data.value?.cards ?? [])
  .filter(c => (!project.value || c.project === project.value) && (!tag.value || c.tags.includes(tag.value)))
  .map(c => (!c.yourTurn && waitsForYou(c) ? { ...c, yourTurn: tl('Answer the agent', 'Réponds à l’agent') } : c)))
const tags = computed(() => boardTags((data.value?.cards ?? []).filter(c => !project.value || c.project === project.value)))
const coordinator = computed(() => coordinators.value.find(c => c.project === project.value))
const columns = computed(() => (project.value ? data.value?.projects.find(p => p.key === project.value)?.columns ?? [] : null))
const lanes = computed(() => boardLanes(cards.value, columns.value))
const PHASE_LABEL: Record<string, string> = { 'your-turn': 'Your turn', 'todo': 'To do', 'working': 'Working', 'done': 'Done' }
const laneLabel = (id: string) => (columns.value && id !== 'your-turn' ? id : t(PHASE_LABEL[id]!))
const showStep = (c: Card, lane: string) => c.step && (!columns.value || lane === 'your-turn')

// The holder's pane, by its herdr-core address; none for holder: none.
const hasAgent = (c: Card) => c.holder !== 'none' && !c.state?.done
const paneOf = (c: Card): Pane | undefined => (c.terminal ? herdrState.value?.panes.find(p => p.coreAddress === c.terminal) : undefined)
const live = (c: Card) => {
  const p = paneOf(c)
  return p ? { key: statusKey(p), label: `${t(c.holder === 'reviewer' ? 'Reviewer' : 'Worker')}: ${statusLabel(p)}` } : { key: 'inactive', label: tl('No agent running', 'Aucun agent lancé') }
}
const selected = computed(() => cards.value.find(c => c.id === open.value) ?? data.value?.cards.find(c => c.id === open.value) ?? null)
</script>

<template>
  <section id="board" data-wherdr="board" class="view board" data-testid="board">
    <header class="board-top">
      <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn back" :aria-label="t('Back')" to="/" />
      <h1 class="display">{{ tl('Board', 'Tableau') }}</h1>
      <select v-model="project" class="pm-select" :aria-label="tl('Project', 'Projet')" data-testid="board-project">
        <option value="">{{ tl('All projects', 'Tous les projets') }}</option>
        <option v-for="p in data?.projects" :key="p.key" :value="p.key">{{ p.name }}</option>
      </select>
      <select v-if="tags.length || tag" v-model="tag" class="pm-select" :aria-label="tl('Tag', 'Étiquette')" data-testid="board-tag">
        <option value="">{{ tl('Tags', 'Étiquettes') }}</option>
        <option v-for="x in tags" :key="x" :value="x">{{ x }}</option>
      </select>
    </header>
    <CoordinatorBar v-if="coordinator" :c="coordinator" open />
    <p v-if="error" class="error board-note">{{ error }}</p>
    <p v-else-if="data && !data.cards.length" class="muted board-note">{{ tl('No task yet.', 'Aucune tâche pour l’instant.') }}</p>
    <div class="board-lanes">
      <section v-for="l in lanes" :key="l.id" class="board-lane" :class="{ mine: l.id === 'your-turn' }" :data-lane="l.id" data-testid="board-lane">
        <h2 class="mono-label">{{ laneLabel(l.id) }} <span>{{ l.cards.length }}</span></h2>
        <button v-for="c in l.cards" :key="c.id" type="button" class="board-card" data-testid="board-card" :data-task="c.id" @click="open = c.id">
          <span class="board-card-head">
            <span v-if="hasAgent(c)" class="card-state" :class="live(c).key" role="img" :aria-label="live(c).label" :title="live(c).label" data-testid="holder-state"><i /></span>
            <b>{{ c.title }}</b>
          </span>
          <small class="mono-label">{{ c.id }}<template v-if="showStep(c, l.id)"> · {{ c.step }}</template></small>
          <span v-if="c.yourTurn" class="board-badge" data-testid="board-badge">{{ c.yourTurn }}</span>
          <span v-if="c.tags.length || c.links.length" class="board-tags">
            <span v-for="tag in c.tags.slice(0, 2)" :key="tag" class="board-chip">{{ tag }}</span>
            <span v-if="c.tags.length > 2" class="board-chip">+{{ c.tags.length - 2 }}</span>
            <a v-if="mainLink(c)" :href="mainLink(c)!.url" target="_blank" rel="noopener" class="board-chip" data-testid="board-link" @click.stop>{{ mainLink(c)!.label }}</a>
          </span>
        </button>
      </section>
    </div>
    <TaskSheet v-if="selected" :card="selected" :pane="paneOf(selected)" @closed="open = null" @changed="load" />
  </section>
</template>

<style scoped>
.board { color: var(--text); }
.board-top { flex: none; display: flex; align-items: center; gap: 8px; min-height: calc(44px + var(--safe-top, 0px)); padding: var(--safe-top, 0px) 8px 0; border-bottom: 1px solid var(--line); }
.board-top h1 { flex: 1; margin: 0; font-size: 20px; }
.board-top .pm-select { min-width: 0; flex: 0 1 auto; }
.board-note { padding: 12px 16px; }
.board-lanes { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; padding-bottom: var(--safe-bottom, 0px); }
.board-lane { flex: none; border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.board-lane h2 { margin: 0; display: flex; justify-content: space-between; color: var(--muted); }
.board-lane.mine h2 { color: var(--blocked); }
.board-card { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 10px 12px; min-height: 44px; border: 1px solid var(--line); background: var(--surface); color: var(--text); }
.board-card:active { background: var(--surface-2); }
.board-card-head { display: flex; align-items: center; gap: 8px; }
@media (min-width: 900px) {
  .board-lanes { flex-direction: row; align-items: stretch; overflow-x: auto; }
  .board-lane { flex: 1 0 220px; max-width: 360px; border-bottom: 0; border-right: 1px solid var(--line); }
}
</style>
