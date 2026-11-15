<script setup lang="ts">
// The board: Your turn first, then the columns of the project's template
// (To do / Working / Done for all projects, with the step on the card). A
// card's indicator is the live state of the agent holding its step.
import { canCheckGithub } from '#shared/pm/ghCheck'
import { turnText } from '#shared/pm/refusal'
import { asker, boardLanes, boardTags, branchLine, canStart, canStop, cardStatus, linkLabel, mainLink, mergeGoesNow, mergeStuck, mergeWaits, statusText, waitsFor, type Board, type BoardMachine, type Card } from '#shared/pm/board'
import type { Task } from '#shared/pm/run'
import { RESUMES } from '#shared/pm/stop'
import { cardTime } from '#shared/pm/times'
import { shownTaskId, storedTaskId } from '#shared/pm/projectKey'
import type { Pane } from '#shared/types'
import { projectOption } from '~/utils/projectOption'

const data = ref<Board | null>(null)
const error = ref('')
// The filters, also from an in-app link (/board?project=CO&tag=ui,
// shared/appLinks.ts), read again when the board is already open.
const route = useRoute()
const queried = (v: unknown) => (typeof v === 'string' ? v : '')
// The project picker: Follow machine tab (the projects the home tab picked
// shows, projectOnBar), All projects, or one project. The user's pick follows
// them across devices; never picked, it is Follow once machine groups exist.
// A link's project shows without replacing it.
const linked = ref(queried(route.query.project).toUpperCase())
watch(() => queried(route.query.project), (p) => { linked.value = p.toUpperCase() })
const known = (key: string) => !data.value || data.value.projects.some(p => p.key === key)
const boardPick = computed(() => {
  const saved = linked.value || boardProject.value
  return saved && (saved === BOARD_FOLLOW || saved === BOARD_ALL || known(saved)) ? saved : machineGroups.value.length ? BOARD_FOLLOW : BOARD_ALL
})
const project = computed(() => (boardPick.value === BOARD_FOLLOW || boardPick.value === BOARD_ALL ? '' : boardPick.value)) // '' = several projects
const shownProject = (key: string) => (project.value ? key === project.value : boardPick.value !== BOARD_FOLLOW || projectOnBar(key))
const projectPick = computed({ get: () => boardPick.value, set: (v: string) => { linked.value = ''; boardProject.value = v } })
const tag = ref(queried(route.query.tag)) // '' = every tag
watch(() => queried(route.query.tag), (g) => { tag.value = g })
// The task to show, also from Decisions' "Open task" (/board?task=CO-1).
const open = ref<string | null>(typeof route.query.task === 'string' ? route.query.task : null)
// Also when the board is already open (the sidebar's Tasks to handle).
watch(() => route.query.task, (id) => { if (typeof id === 'string') open.value = id })
const decisions = ref(0) // what waits for the user's choice, on the Decisions screen

async function load() {
  try { data.value = await api<Board>('/api/pm/board'); error.value = ''; loadCoordinators(); api<unknown[]>('/api/pm/decisions').then((d) => { decisions.value = d.length }, () => {}) }
  catch (e) { error.value = (e as Error).message }
}
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { load(); timer = setInterval(load, 10_000) })
onBeforeUnmount(() => clearInterval(timer))
watch(taskSheetTick, load) // an action in a task's sheet, also read by Tasks to handle

// An agent asking a question or a permission puts its card in Your turn too.
const waitsForYou = (c: Card) => { const p = paneOf(c); return !!p && hasAgent(c) && statusKey(p) === 'blocked' }
const cards = computed(() => (data.value?.cards ?? [])
  .filter(c => shownProject(c.project) && (!tag.value || c.tags.includes(tag.value)))
  .map(c => (!c.yourTurn && waitsForYou(c) ? { ...c, yourTurn: tl('Answer the agent', 'Réponds à l’agent') } : c)))
const tagPick = noneModel(tag)
const projectItems = computed(() => [{ label: tl('Follow machine tab'), value: BOARD_FOLLOW }, { label: tl('All projects', 'Tous les projets'), value: BOARD_ALL }, ...(data.value?.projects ?? []).map(p => projectOption(p))])
const tagItems = computed(() => [{ label: tl('Tags', 'Étiquettes'), value: NONE }, ...tags.value.map(x => ({ label: x, value: x }))])
const tags = computed(() => boardTags((data.value?.cards ?? []).filter(c => shownProject(c.project))))
// The header's coordinator button: the project's; none on All projects (Alfred has no autopilot).
const coordinator = computed(() => (project.value ? coordinators.value.find(c => c.project === project.value) : undefined))
// The project's Machines view (its sheet, General tab); with several projects, the list.
const machinesLink = computed(() => (project.value ? `/settings?section=projects&project=${encodeURIComponent(project.value)}&tab=general&target=project.machines` : '/settings?section=projects'))
const columns = computed(() => (project.value ? data.value?.projects.find(p => p.key === project.value)?.columns ?? [] : null))
const lanes = computed(() => boardLanes(cards.value, columns.value))
// Before the first read: lanes of shapes, not empty lanes counting 0 (nor the
// default lanes before a project's own columns); none for a short read.
const skeleton = useDelayedFlag(computed(() => !data.value && !error.value))
const PHASE_LABEL: Record<string, string> = { 'your-turn': 'Your turn', 'todo': 'To do', 'working': 'Working', 'done': 'Done' }
const laneLabel = (id: string) => (columns.value && id !== 'your-turn' ? id : t(PHASE_LABEL[id]!))
// Where its PR and merge stand, one line: 'PR open · waiting for checks (smoke)', 'merged 14:05'.
// The card's branch line, only for a task that goes elsewhere than its project's working branch.
const baseOf = (c: Card) => data.value?.projects.find(p => p.key === c.project)?.base
const branchOf = (c: Card) => { const b = baseOf(c), l = branchLine(c, b); return b && l && l.base !== b ? l : undefined }
const statusOf = (c: Card) => { const s = cardStatus(c); return s && { ...s, text: statusText(s, at => fmtWhen(new Date(at).toISOString())) } }
const showStep = (c: Card, lane: string) => c.step && (!columns.value || lane === 'your-turn')
// '12 min in review' while it works (the step in it), '42 min' from start to done.
const timeOf = (c: Card) => cardTime(c, Date.now())

// The holder's pane, by its herdr-core address; none for holder: none.
const hasAgent = (c: Card) => c.holder !== 'none' && !c.state?.done
const paneOf = (c: Card): Pane | undefined => (c.terminal ? herdrState.value?.panes.find(p => p.coreAddress === c.terminal) : undefined)
const live = (c: Card) => {
  const p = paneOf(c)
  return p ? { key: statusKey(p), label: `${t(c.holder === 'reviewer' ? 'Reviewer' : 'Worker')}: ${statusLabel(p)}` } : { key: 'inactive', label: tl('No agent running', 'Aucun agent lancé') }
}
// The card's menu: Start for a task to do (not one waiting for others: its
// card says which), Start on… another machine the project allows, Stop (confirmed in the task's sheet), how a stopped task
// goes on, Check on GitHub for a task at its merge step or archived with a PR
// (its sheet opens with the result), or Delete for a task never started (confirmed). It opens on right
// click and long press of the card; its ••• button shows only when the menu
// has more than Open (a tap already opens the task).
const stopping = ref(false)
const checking = ref(false)
const cardMenu = useRowMenu()
const tap = (c: Card) => { if (cardMenu.swallowClick()) return; const p = askingPane(c); if (p) navigateTo(panePath(p.id)); else show(c.id) }
// A tap goes where the user acts: the conversation of the agent that asks (a
// question, a permission) when it is on screen here; else the task's sheet, on
// its To do tab when it waits for the user. The sheet stays in the menu.
const askingPane = (c: Card) => (c.yourTurn && (asker(c) || waitsForYou(c)) ? paneOf(c) : undefined)
const reporting = ref(false)
const show = (id: string, stop = false, check = false, report = false) => { stopping.value = stop; checking.value = check; reporting.value = report; open.value = id }
const act = (fn: () => Promise<unknown>) => fn().then(load, (e: Error) => { error.value = e.message })
const menuOf = (c: Card): MenuItem[] => [
  ...(askingPane(c) ? [{ label: c.holder === 'reviewer' ? tl('Open the reviewer', 'Ouvrir le relecteur') : tl('Open the agent', 'Ouvrir l’agent'), icon: 'i-lucide-terminal', run: () => navigateTo(panePath(askingPane(c)!.id)) }] : []),
  { label: askingPane(c) ? tl('Open the task') : tl('Open', 'Ouvrir'), icon: 'i-lucide-panel-right-open', run: () => show(c.id) },
  ...(canStart(c) && !waiting(c).length ? [{ label: c.sameFiles ? tl('Start anyway') : tl('Start', 'Lancer'), icon: 'i-lucide-play', run: () => act(() => startTaskApi(c.id, undefined, c.sameFiles ? true : undefined)) }] : []),
  ...(canStart(c) && !waiting(c).length && machinesOf(c) ? [{ label: tl('Start on…'), icon: 'i-lucide-server', run: () => openMenu(startOn(c), tl('Start on')) }] : []),
  ...(c.yourTurn && !c.state?.done && !c.report ? [{ label: tl('Report a problem…'), icon: 'i-lucide-flag', run: () => show(c.id, false, false, true) }] : []),
  ...(canStop(c) ? [{ label: tl('Stop…', 'Arrêter…'), icon: 'i-lucide-square', danger: true, run: () => show(c.id, true) }] : []),
  ...(canCheckGithub(c) ? [{ label: tl('Check on GitHub'), icon: 'i-lucide-refresh-cw', run: () => show(c.id, false, true) }] : []),
  ...(c.stopped ? RESUMES.map(how => ({ label: tl(...RESUME_LABEL[how]), danger: how === 'archive', run: () => act(() => resumeTaskApi(c.id, how)) })) : []),
  ...(c.removable ? [{ label: tl('Delete…', 'Supprimer…'), icon: 'i-lucide-trash-2', danger: true, run: () => act(() => removeTaskApi(c.id)) }] : []),
]
// A project that allows other machines: Start on one of them (Start alone: its own).
const machinesOf = (c: Card) => data.value?.projects.find(p => p.key === c.project)?.machines
const machineNote = (m: BoardMachine, home: boolean) => (!m.online ? tl('Offline') : home ? tl('The project\'s own machine') : m.unready ? `${tl('Not ready')}: ${m.unready}` : m.unready === '' ? tl('Ready') : tl('Checked when the task starts'))
const startOn = (c: Card): MenuItem[] => (machinesOf(c) ?? []).map((m, i) => ({
  label: m.label, desc: machineNote(m, i === 0), disabled: !m.online, run: () => act(() => startTaskApi(c.id, m.key, c.sameFiles ? true : undefined)),
}))
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
const onBoard = computed(() => cards.value.find(isOpen) ?? data.value?.cards.find(isOpen) ?? null)
// An archived task (the archived sheet, a link /board?task=ID): not among the board's cards, read on its own.
const archived = useArchivedCard(() => open.value, () => !!data.value && !onBoard.value)
const selected = computed(() => onBoard.value ?? archived.value)
// The Done column's footer: how many tasks of the shown projects are archived; it opens their list.
const doneLane = computed(() => (columns.value ? columns.value.at(-1) : 'done'))
const shownKeys = computed(() => (data.value?.projects ?? []).map(p => p.key).filter(shownProject))
const archivedCount = computed(() => shownKeys.value.reduce((n, k) => n + (data.value?.archived?.[k] ?? 0), 0))
const archiveOpen = ref(false)
const openArchived = (c: Card) => { keepArchivedCard(c); show(c.id) }
</script>

<template>
  <section id="board" data-wherdr="board" class="view board" data-testid="board">
    <header class="board-top">
      <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" size="lg" class="icon-btn back" :aria-label="t('Back')" to="/" />
      <h1 class="display">{{ tl('Board', 'Tableau') }}</h1>
      <SetupButton />
      <UButton :color="decisions ? 'warning' : 'neutral'" :variant="decisions ? 'solid' : 'outline'" size="lg" to="/decisions" data-testid="board-decisions">
        {{ tl('Decisions', 'Décisions') }}<span v-if="decisions" class="mono-label board-decisions-n">{{ decisions }}</span>
      </UButton>
      <UButton icon="i-lucide-plus" color="neutral" variant="outline" size="lg" class="board-add" :aria-label="tl('Add a task', 'Ajouter une tâche')" :disabled="!data?.projects.length" data-testid="board-add" @click="adding = true">
        <span class="board-add-label">{{ tl('Add task', 'Ajouter') }}</span>
      </UButton>
      <ProjectSelect v-model="projectPick" :items="projectItems" size="lg" class="board-select" :aria-label="tl('Project', 'Projet')" data-testid="board-project" />
      <USelect v-if="tags.length || tag" v-model="tagPick" :items="tagItems" size="lg" class="board-select" :aria-label="tl('Tag', 'Étiquette')" data-testid="board-tag" />
      <UButton icon="i-lucide-server" color="neutral" variant="ghost" size="lg" class="icon-btn" :to="machinesLink" :aria-label="tl('Machines')" :title="tl('Machines')" data-testid="board-machines" />
      <CoordinatorButton v-if="coordinator" :c="coordinator" open />
    </header>
    <div class="board-body">
    <p v-if="error" class="error board-note">{{ error }}</p>
    <p v-else-if="data && !data.cards.length" class="muted board-note">{{ tl('No task yet.', 'Aucune tâche pour l’instant.') }}</p>
    <div v-if="!data && skeleton" class="board-lanes" role="status" :aria-label="tl('Loading')" aria-busy="true" data-testid="board-skeleton">
      <section v-for="n in 3" :key="n" class="board-lane">
        <h2 class="mono-label"><i class="skel board-skel-title" :style="{ width: `${90 - n * 12}px` }" /></h2>
        <div v-for="m in 4 - n" :key="m" class="board-card"><i class="skel board-skel-line" :style="{ width: `${78 - m * 12}%` }" /><i class="skel board-skel-line small" style="width: 30%" /></div>
      </section>
    </div>
    <div v-else-if="data" class="board-lanes">
      <section v-for="l in lanes" :key="l.id" class="board-lane" :class="{ mine: l.id === 'your-turn' }" :data-lane="l.id" data-testid="board-lane">
        <h2 class="mono-label">{{ laneLabel(l.id) }} <span>{{ l.cards.length }}</span></h2>
        <div v-for="c in l.cards" :key="c.id" class="board-card-wrap" :class="{ 'has-menu': menuOf(c).length > 1 }">
        <UContextMenu :disabled="sheetMenus" :items="cardMenu.dropdown(() => menuOf(c))" :press-open-delay="700" :ui="{ content: 'hw-dropdown' }" @update:open="cardMenu.opened">
        <button type="button" class="board-card" data-testid="board-card" :data-task="c.id" v-on="cardMenu.on(() => menuOf(c), c.title)" @click="tap(c)">
          <span class="board-card-head">
            <span v-if="hasAgent(c)" class="card-state" :class="live(c).key" role="img" :aria-label="live(c).label" :title="live(c).label" data-testid="holder-state"><i /></span>
            <b>{{ c.title }}</b>
          </span>
          <small class="mono-label board-card-id"><ProjectBadge :text="c.shown" :color="c.color" copy /><template v-if="c.machine"> · <span data-testid="board-machine">{{ c.machine }}</span></template><template v-if="timeOf(c)"> · <span data-testid="board-time">{{ timeOf(c) }}</span></template><template v-else-if="showStep(c, l.id)"> · {{ c.step }}</template></small>
          <small v-if="statusOf(c)" class="board-status" :class="statusOf(c)!.tone" :title="statusOf(c)!.text" data-testid="board-status">{{ statusOf(c)!.text }}</small>
          <BranchLine v-if="branchOf(c)" :line="branchOf(c)!" compact />
          <!-- A merge stuck on its worker (even in Your turn): no spinner, the sheet's Start the worker. -->
          <span v-if="mergeStuck(c)" class="board-badge" :title="tl(mergeStuck(c)!)" data-testid="board-merge-stuck"><UIcon name="i-lucide-triangle-alert" aria-hidden="true" />{{ tl('Merge waits for its worker') }}</span>
          <span v-else-if="turnText(c)" class="board-badge" data-testid="board-badge">{{ turnText(c) }}</span>
          <!-- An accepted merge on its way: Merging until it ends, what it waits for on the status line above (none while its checks are red). -->
          <span v-else-if="mergeGoesNow(c)" class="board-badge board-merging" role="status" :aria-label="`${tl('Merging')}: ${mergeWaits(c)}`" data-testid="board-merging"><UIcon name="i-lucide-loader-circle" class="spin" aria-hidden="true" />{{ tl('Merging') }}</span>
          <small v-if="c.report" class="board-status wait" :title="c.report.text" data-testid="board-report">{{ tl('Problem reported') }} {{ fmtTime(c.report.at) }}</small>
          <small v-else-if="waiting(c).length" class="muted" data-testid="board-waits">{{ tl('Waits for', 'Attend') }} {{ waiting(c).map(id => shownTaskId(data?.projects ?? [], id)).join(', ') }}</small>
          <!-- Stalled, the machine may still fix it: a warning only; after 30 min it is Your turn. -->
          <small v-if="c.stall && !c.yourTurn" class="board-stall" :title="c.stall.reason" data-testid="board-stall"><UIcon name="i-lucide-triangle-alert" aria-hidden="true" />{{ t(c.stall.reason) }}</small>
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
        <button v-if="l.id === doneLane && archivedCount" type="button" class="board-archived muted" data-testid="board-archived" @click="archiveOpen = true">
          {{ archivedCount }} {{ tl('archived') }} · <span>{{ tl('show') }}</span>
        </button>
      </section>
    </div>
    </div>
    <ArchivedSheet v-if="archiveOpen" :projects="shownKeys" @pick="openArchived" @closed="archiveOpen = false" />
    <AddTaskSheet v-if="adding && data" v-model:open="adding" :projects="data.projects" :cards="data.cards" :project="project" @added="added" />
    <TaskSheet v-if="selected" :key="`${selected.id}:${stopping}:${checking}:${reporting}`" :card="selected" :waits-for="waiting(selected)" :pane="paneOf(selected)" :project-base="baseOf(selected)" :stopping="stopping" :checking="checking" :reporting="reporting" @closed="open = null; stopping = false; checking = false; reporting = false; closeTaskSheet()" @changed="taskChanged" />
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
  /* A picked project (its badge, then its name, cut with an ellipsis) and Autopilot crowd the
     header: it wraps to a second row instead of running off the screen. */
  .board-top:has(.project-select-value) { flex-wrap: wrap; row-gap: 4px; padding-bottom: 4px; }
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
.board-archived { align-self: flex-start; min-height: 44px; padding: 0; border: 0; background: none; font-size: 12px; text-align: left; cursor: pointer; }
.board-archived span { text-decoration: underline; text-underline-offset: 3px; }
.board-card { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 10px 12px; min-height: 44px; border: 1px solid var(--line); background: var(--surface); color: var(--text); }
.board-card:active { background: var(--surface-2); }
/* Skeleton lines at the heights of a card's title and id lines. */
.board-skel-title { height: 10px; }
.board-skel-line { height: 14px; margin: 2px 0; }
.board-skel-line.small { height: 11px; margin: 4px 0 2px; }
.board-card-head { display: flex; align-items: center; gap: 8px; }
.board-status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--muted); }
.board-status.wait { color: var(--working); }
.board-merging { display: inline-flex; align-items: center; gap: 4px; border-color: var(--working); color: var(--working); }
.board-merging .spin { animation: spin .8s linear infinite; }
.board-status.bad { color: var(--danger); }
.board-status.ok { color: var(--done); }
.board-stall { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: 12px; color: var(--blocked); }
.board-stall span { flex: none; }
@media (min-width: 900px) {
  .board-body { overflow-y: hidden; }
  .board-lanes { flex: 1; flex-direction: row; align-items: stretch; overflow-x: auto; }
  .board-lane { flex: 1 0 220px; max-width: 360px; border-bottom: 0; border-right: 1px solid var(--line); }
}
</style>
