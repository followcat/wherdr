<script setup lang="ts">
// The board: Your turn first, then the columns of the project's template
// (To do / Working / Done for all projects, with the step on the card). A
// card's indicator is the live state of the agent holding its step.
import { boardLanes, boardTags, canStart, canStop, cardStatus, linkLabel, mainLink, waitsFor, type Board, type Card } from '#shared/pm/board'
import type { Task } from '#shared/pm/run'
import { RESUMES } from '#shared/pm/stop'
import { shownTaskId, storedTaskId } from '#shared/pm/projectKey'
import type { Pane } from '#shared/types'

const data = ref<Board | null>(null)
const error = ref('')
const project = ref('') // '' = all projects
const tag = ref('') // '' = every tag
// The task to show, also from Decisions' "Open task" (/board?task=CO-1).
const route = useRoute()
const open = ref<string | null>(typeof route.query.task === 'string' ? route.query.task : null)
const decisions = ref(0) // what waits for the user's choice, on the Decisions screen

async function load() {
  try { data.value = await api<Board>('/api/pm/board'); error.value = ''; loadCoordinators(); api<unknown[]>('/api/pm/decisions').then((d) => { decisions.value = d.length }, () => {}) }
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
const projectPick = noneModel(project)
const tagPick = noneModel(tag)
const projectItems = computed(() => [{ label: tl('All projects', 'Tous les projets'), value: NONE }, ...(data.value?.projects ?? []).map(p => ({ label: p.name, value: p.key }))])
const tagItems = computed(() => [{ label: tl('Tags', 'Étiquettes'), value: NONE }, ...tags.value.map(x => ({ label: x, value: x }))])
const tags = computed(() => boardTags((data.value?.cards ?? []).filter(c => !project.value || c.project === project.value)))
// The header's coordinator button: the project's, or Alfred's on All projects.
const coordinator = computed(() => coordinators.value.find(c => (project.value ? c.project === project.value : c.main)))
const columns = computed(() => (project.value ? data.value?.projects.find(p => p.key === project.value)?.columns ?? [] : null))
const lanes = computed(() => boardLanes(cards.value, columns.value))
const PHASE_LABEL: Record<string, string> = { 'your-turn': 'Your turn', 'todo': 'To do', 'working': 'Working', 'done': 'Done' }
const laneLabel = (id: string) => (columns.value && id !== 'your-turn' ? id : t(PHASE_LABEL[id]!))
// Where its PR and merge stand, one line: 'PR open · waiting for checks (smoke)', 'merged 14:05'.
const statusOf = (c: Card) => { const s = cardStatus(c); return s && { ...s, text: s.at ? `${s.text} ${fmtWhen(new Date(s.at).toISOString())}` : s.text } }
const showStep = (c: Card, lane: string) => c.step && (!columns.value || lane === 'your-turn')

// The holder's pane, by its herdr-core address; none for holder: none.
const hasAgent = (c: Card) => c.holder !== 'none' && !c.state?.done
const paneOf = (c: Card): Pane | undefined => (c.terminal ? herdrState.value?.panes.find(p => p.coreAddress === c.terminal) : undefined)
const live = (c: Card) => {
  const p = paneOf(c)
  return p ? { key: statusKey(p), label: `${t(c.holder === 'reviewer' ? 'Reviewer' : 'Worker')}: ${statusLabel(p)}` } : { key: 'inactive', label: tl('No agent running', 'Aucun agent lancé') }
}
// The card's menu: Start for a task to do (not one waiting for others: its
// card says which), Stop (confirmed in the task's sheet), how a stopped task
// goes on, or Delete for a task never started (confirmed). It opens on right
// click and long press of the card; its ••• button shows only when the menu
// has more than Open (a tap already opens the task).
const stopping = ref(false)
const cardMenu = useRowMenu()
const tap = (id: string) => { if (!cardMenu.swallowClick()) show(id) }
const show = (id: string, stop = false) => { stopping.value = stop; open.value = id }
const act = (fn: () => Promise<unknown>) => fn().then(load, (e: Error) => { error.value = e.message })
const menuOf = (c: Card): MenuItem[] => [
  { label: tl('Open', 'Ouvrir'), icon: 'i-lucide-panel-right-open', run: () => show(c.id) },
  ...(canStart(c) && !waiting(c).length ? [{ label: tl('Start', 'Lancer'), icon: 'i-lucide-play', run: () => act(() => startTaskApi(c.id)) }] : []),
  ...(canStop(c) ? [{ label: tl('Stop…', 'Arrêter…'), icon: 'i-lucide-square', danger: true, run: () => show(c.id, true) }] : []),
  ...(c.stopped ? RESUMES.map(how => ({ label: tl(...RESUME_LABEL[how]), danger: how === 'archive', run: () => act(() => resumeTaskApi(c.id, how)) })) : []),
  ...(c.removable ? [{ label: tl('Delete…', 'Supprimer…'), icon: 'i-lucide-trash-2', danger: true, run: () => act(() => removeTaskApi(c.id)) }] : []),
]
const waiting = (c: Card) => (c.phase === 'todo' ? waitsFor(c, data.value?.cards ?? []) : [])

// Add a task: the board's project preselected; the board is read again at
// once; a refused Start now is said on the board, the task stays added.
const adding = ref(false)
function added(task: Task, refused?: string) {
  load().then(() => { if (refused) error.value = `${shownTaskId(data.value?.projects ?? [], task.id)}: ${refused}` })
}
// By any key its project had, in any case (a link may name a former key: /board?task=WHR-5 after WHR became WD).
const openId = computed(() => storedTaskId(data.value?.projects ?? [], open.value) ?? open.value)
const isOpen = (c: Card) => c.id === openId.value
const selected = computed(() => cards.value.find(isOpen) ?? data.value?.cards.find(isOpen) ?? null)
</script>

<template>
  <section id="board" data-wherdr="board" class="view board" data-testid="board">
    <header class="board-top">
      <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn back" :aria-label="t('Back')" to="/" />
      <h1 class="display">{{ tl('Board', 'Tableau') }}</h1>
      <UButton :color="decisions ? 'warning' : 'neutral'" :variant="decisions ? 'solid' : 'outline'" size="lg" to="/decisions" data-testid="board-decisions">
        {{ tl('Decisions', 'Décisions') }}<span v-if="decisions" class="mono-label board-decisions-n">{{ decisions }}</span>
      </UButton>
      <UButton icon="i-lucide-plus" color="neutral" variant="outline" size="lg" class="board-add" :aria-label="tl('Add a task', 'Ajouter une tâche')" :disabled="!data?.projects.length" data-testid="board-add" @click="adding = true">
        <span class="board-add-label">{{ tl('Add task', 'Ajouter') }}</span>
      </UButton>
      <USelect v-model="projectPick" :items="projectItems" size="lg" class="board-select" :aria-label="tl('Project', 'Projet')" data-testid="board-project" />
      <USelect v-if="tags.length || tag" v-model="tagPick" :items="tagItems" size="lg" class="board-select" :aria-label="tl('Tag', 'Étiquette')" data-testid="board-tag" />
      <CoordinatorButton v-if="coordinator" :c="coordinator" open />
    </header>
    <!-- One scroll on the phone, so a tall guide does not hide the lanes. -->
    <div class="board-body">
    <PmGuide :always="route.query.guide === '1'" />
    <p v-if="error" class="error board-note">{{ error }}</p>
    <p v-else-if="data && !data.cards.length" class="muted board-note">{{ tl('No task yet.', 'Aucune tâche pour l’instant.') }}</p>
    <div class="board-lanes">
      <section v-for="l in lanes" :key="l.id" class="board-lane" :class="{ mine: l.id === 'your-turn' }" :data-lane="l.id" data-testid="board-lane">
        <h2 class="mono-label">{{ laneLabel(l.id) }} <span>{{ l.cards.length }}</span></h2>
        <div v-for="c in l.cards" :key="c.id" class="board-card-wrap" :class="{ 'has-menu': menuOf(c).length > 1 }">
        <UContextMenu :disabled="sheetMenus" :items="cardMenu.dropdown(() => menuOf(c))" :press-open-delay="700" :ui="{ content: 'hw-dropdown' }" @update:open="cardMenu.opened">
        <button type="button" class="board-card" data-testid="board-card" :data-task="c.id" v-on="cardMenu.on(() => menuOf(c), c.title)" @click="tap(c.id)">
          <span class="board-card-head">
            <span v-if="hasAgent(c)" class="card-state" :class="live(c).key" role="img" :aria-label="live(c).label" :title="live(c).label" data-testid="holder-state"><i /></span>
            <b>{{ c.title }}</b>
          </span>
          <small class="mono-label">{{ c.shown }}<template v-if="showStep(c, l.id)"> · {{ c.step }}</template></small>
          <small v-if="statusOf(c)" class="board-status" :class="statusOf(c)!.tone" :title="statusOf(c)!.text" data-testid="board-status">{{ statusOf(c)!.text }}</small>
          <span v-if="c.yourTurn" class="board-badge" data-testid="board-badge">{{ c.yourTurn }}</span>
          <small v-else-if="waiting(c).length" class="muted" data-testid="board-waits">{{ tl('Waits for', 'Attend') }} {{ waiting(c).map(id => shownTaskId(data?.projects ?? [], id)).join(', ') }}</small>
          <span v-if="c.tags.length || c.links.length" class="board-tags">
            <span v-for="tag in c.tags.slice(0, 2)" :key="tag" class="board-chip">{{ tag }}</span>
            <span v-if="c.tags.length > 2" class="board-chip">+{{ c.tags.length - 2 }}</span>
            <a v-if="mainLink(c)" :href="mainLink(c)!.url" target="_blank" rel="noopener" class="board-chip" data-testid="board-link" @click.stop>{{ linkLabel(mainLink(c)!) }}</a>
          </span>
        </button>
        </UContextMenu>
        <template v-if="menuOf(c).length > 1">
        <UDropdownMenu v-if="!sheetMenus" :items="toDropdown(menuOf(c))" :content="{ align: 'end', sideOffset: 4 }" :ui="{ content: 'hw-dropdown' }">
          <UButton icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="lg" class="icon-btn board-card-menu" :aria-label="tl('Task menu', 'Menu de la tâche')" data-testid="card-menu" />
        </UDropdownMenu>
        <UButton v-else icon="i-lucide-ellipsis" color="neutral" variant="ghost" size="lg" class="icon-btn board-card-menu" :aria-label="tl('Task menu', 'Menu de la tâche')" data-testid="card-menu" @click="openMenu(menuOf(c), c.title)" />
        </template>
        </div>
      </section>
    </div>
    </div>
    <AddTaskSheet v-if="adding && data" v-model:open="adding" :projects="data.projects" :cards="data.cards" :project="project" @added="added" />
    <TaskSheet v-if="selected" :key="`${selected.id}:${stopping}`" :card="selected" :waits-for="waiting(selected)" :pane="paneOf(selected)" :stopping="stopping" @closed="open = null; stopping = false" @changed="load" />
  </section>
</template>

<style scoped>
.board { color: var(--text); }
.board-top { flex: none; display: flex; align-items: center; gap: 8px; min-height: calc(44px + var(--safe-top, 0px)); padding: var(--safe-top, 0px) 8px 0; border-bottom: 1px solid var(--line); }
.board-top h1 { flex: 1; margin: 0; font-size: 20px; }
.board-decisions-n { margin-left: 6px; color: inherit; }
/* Phone: Add is an icon, and the heading is for screen readers only, so the project picker keeps its room. */
@media (max-width: 899px) {
  .board-add { width: 44px; justify-content: center; }
  .board-add-label { display: none; }
  .board-top h1 { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .board-top [data-testid="board-decisions"] { margin-right: auto; }
}
.board-top :deep(.board-select) { min-width: 0; flex: 0 1 auto; }
.board-note { padding: 12px 16px; }
.board-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; }
.board-lanes { flex: 1 0 auto; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; overscroll-behavior: contain; padding-bottom: var(--safe-bottom, 0px); }
.board-lane { flex: none; border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; flex-direction: column; gap: 8px; }
.board-lane h2 { margin: 0; display: flex; justify-content: space-between; color: var(--muted); }
.board-lane.mine h2 { color: var(--blocked); }
.board-card-wrap { position: relative; display: flex; flex-direction: column; }
.board-card-menu { position: absolute; top: 0; right: 0; }
.board-card-wrap.has-menu .board-card-head { padding-right: 36px; }
.board-card { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 10px 12px; min-height: 44px; border: 1px solid var(--line); background: var(--surface); color: var(--text); }
.board-card:active { background: var(--surface-2); }
.board-card-head { display: flex; align-items: center; gap: 8px; }
.board-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }
.board-status.wait { color: var(--working); }
.board-status.bad { color: var(--danger); }
.board-status.ok { color: var(--done); }
@media (min-width: 900px) {
  .board-body { overflow-y: hidden; }
  .board-lanes { flex: 1; flex-direction: row; align-items: stretch; overflow-x: auto; }
  .board-lane { flex: 1 0 220px; max-width: 360px; border-bottom: 0; border-right: 1px solid var(--line); }
}
</style>
