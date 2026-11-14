<script setup lang="ts">
// The COORDINATORS section under Alfred (AlfredRow, which coordinates all projects) at
// the top of the agent list: the project coordinators that run, or whose
// conversation stopped (its terminal ended), those the home tab picked shows
// (useMachineBar.projectOnBar). One tap opens its conversation, or asks whether
// to resume the stopped one or start a new one. Its menu (right click, or long
// press on a touch screen) opens its board, its settings or autopilot tab,
// renames it inline, mutes it, restarts it with another agent (which becomes
// its default) or stops it. Hidden while project management is off.
import type { CoordinatorView } from '#shared/pm/coordinator'
import type { Pane } from '#shared/types'

const busy = ref('')
const error = ref('')
const rows = computed(() => projectCoordinators.value.filter(c => (coordinatorPane(c) || coordinatorStopped(c)) && projectOnBar(c.project)))

async function run(c: CoordinatorView, fn: () => Promise<unknown>) {
  busy.value = c.project
  error.value = ''
  try { await fn() }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
function open(c: CoordinatorView) {
  if (busy.value || rowMenu.swallowClick()) return
  if (coordinatorStopped(c)) { stopped.value = c; return }
  void run(c, () => openCoordinator(c))
}

// A stopped conversation: resume it (with the agent that ran it), or a new one.
const stopped = ref<CoordinatorView | null>(null)
const stoppedOpen = computed({ get: () => !!stopped.value, set: (v) => { if (!v) stopped.value = null } })
function restartStopped(how: 'resume' | 'new') {
  const c = stopped.value
  if (!c || busy.value) return
  stopped.value = null
  void run(c, async () => {
    const p = await launchCoordinator(c.project, how === 'resume' ? 'resume' : coordinatorAgent(c))
    if (p) await navigateTo(panePath(p.id))
  })
}

// Its conversation is the one open: the same selected style as agent cards.
const selected = (c: CoordinatorView) => { const id = coordinatorPane(c)?.id; return !!id && id === curPane.value }
const sub = (c: CoordinatorView) => {
  const p = coordinatorPane(c)
  const program = kindLabel((c.ran ?? coordinatorAgent(c))?.program)
  if (p) return `${program} · ${statusLabel(p)}`
  if (coordinatorStopped(c)) return `${program} · ${tl('Stopped')}`
  return tl(`Start with ${program}`, `Lancer avec ${program}`)
}

// Restart with…: the offered agents that can run this project's coordinator.
const rowMenu = useRowMenu()
const restarting = ref<CoordinatorView | null>(null)
const pick = ref('')
const choices = computed(() => (restarting.value ? offerCoordinators(undefined, restarting.value.project) : []))
const settingsPath = (c: CoordinatorView, tab: string) => `/settings?section=projects&project=${encodeURIComponent(c.project)}&tab=${tab}`
const menu = (c: CoordinatorView) => (): MenuItem[] => {
  const p = coordinatorPane(c)
  const pilot = !!c.autopilot?.on
  return [
    { label: t('Open the board'), icon: 'i-lucide-kanban', run: () => navigateTo(`/board?project=${encodeURIComponent(c.project)}`) },
    { label: t('Project settings'), icon: 'i-lucide-settings-2', run: () => navigateTo(settingsPath(c, 'general')) },
    { label: t('Autopilot'), icon: pilot ? 'i-lucide-check' : 'i-lucide-plane', desc: pilot ? t('On') : t('Off'), run: () => navigateTo(settingsPath(c, 'autopilot')) },
    { kind: 'separator' },
    { label: t('Rename…'), icon: 'i-lucide-pencil', run: () => startRename(c) },
    // The conversation header's mute: a coordinator's exception, kept across its restarts.
    ...(p ? [notificationMenuItem({ ...p, title: coordinatorName(c) }, true)] : []),
    { kind: 'separator' },
    { label: tl('Restart with…', 'Relancer avec…'), icon: 'i-lucide-refresh-cw', run: () => choose(c) },
    ...(p ? [{ label: t('Stop the coordinator'), icon: 'i-lucide-square', danger: true, run: () => stop(c, p) }] : []),
  ]
}

// Rename…: its name in place, empty = the project's.
const renaming = ref('')
const newName = ref('')
function startRename(c: CoordinatorView) {
  renaming.value = c.project
  newName.value = c.coordinatorName ?? ''
  nextTick(() => (document.querySelector('[data-testid="coordinator-rename"] input') as HTMLInputElement | null)?.select())
}
function rename(c: CoordinatorView) {
  if (renaming.value !== c.project) return
  renaming.value = ''
  const v = newName.value.trim()
  if (v === (c.coordinatorName ?? '')) return
  void run(c, async () => { await api('/api/pm/project-update', { key: c.project, coordinatorName: v === c.name ? '' : v }); await loadCoordinators() })
}

// Stop: its agent ends; the next message or wake starts it again.
async function stop(c: CoordinatorView, p: Pane) {
  if (!(await askConfirm(tl(`Stop ${coordinatorName(c)}? It starts again on the next message or wake.`), t('Stop')))) return
  void run(c, async () => {
    await api('/api/close', { pane_id: p.id })
    if (curPane.value === p.id) await navigateTo('/')
  })
}
function choose(c: CoordinatorView) {
  restarting.value = c
  const now = (c.ran ?? coordinatorAgent(c))?.program
  pick.value = now && choices.value.includes(now) ? now : choices.value[0] ?? ''
}
async function restart() {
  const c = restarting.value
  const program = choices.value.find(p => p === pick.value)
  if (!c || !program || busy.value) return
  restarting.value = null
  busy.value = c.project
  error.value = ''
  // The same program keeps its model.
  const agent = c.agent?.program === program ? c.agent : { program }
  try {
    await api('/api/pm/coordinator-agent', { project: c.project, ...agent })
    const p = await launchCoordinator(c.project, agent)
    if (p) await navigateTo(panePath(p.id))
  }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}
const sheetOpen = computed({ get: () => !!restarting.value, set: (v) => { if (!v) restarting.value = null } })

let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => { loadCoordinators(); timer = setInterval(loadCoordinators, 30_000) })
onUnmounted(() => clearInterval(timer))
</script>

<template>
  <section v-if="rows.length" class="agent-group coord-list" data-testid="coordinators">
    <h2 class="group-title"><span>{{ tl('Coordinators', 'Coordinateurs') }}</span><span class="count">{{ rows.length }}</span></h2>
    <UContextMenu v-for="c in rows" :key="c.project" :disabled="sheetMenus" :items="rowMenu.dropdown(menu(c))" :press-open-delay="700" :ui="{ content: 'hw-dropdown' }" @update:open="rowMenu.opened">
    <form v-if="renaming === c.project" class="coord-row coord-rename" data-testid="coordinator-rename" @submit.prevent="rename(c)">
      <i class="coord-dot" aria-hidden="true" />
      <UInput v-model="newName" autofocus size="lg" class="w-full" maxlength="80" :placeholder="c.name" :aria-label="t('Coordinator name')" @blur="rename(c)" @keydown.esc.prevent="renaming = ''" />
    </form>
    <button
      v-else type="button" class="coord-row" :class="{ on: !!coordinatorPane(c), sel: selected(c) }" :aria-current="selected(c) ? 'page' : undefined"
      :disabled="!!busy" data-testid="coordinator-row" :title="c.main ? undefined : tl(`Coordinator of ${c.name}`)" v-on="rowMenu.on(menu(c), coordinatorName(c))" @click="open(c)"
    >
      <i class="coord-dot" aria-hidden="true" />
      <span class="coord-text"><b v-if="c.main">{{ coordinatorName(c) }}</b><b v-else class="coord-name"><ProjectBadge :text="c.label ?? c.project" :color="c.color" /><span data-testid="coordinator-name">{{ coordinatorName(c) }}</span></b><small>{{ busy === c.project ? tl('Starting…', 'Lancement…') : sub(c) }}</small></span>
      <UIcon :name="coordinatorPane(c) ? 'i-lucide-chevron-right' : 'i-lucide-play'" class="coord-go" />
    </button>
    </UContextMenu>
    <p v-if="error" class="error coord-error">{{ error }}</p>
  </section>

  <AppSheet v-model:open="stoppedOpen" :title="stopped ? coordinatorName(stopped) : ''">
    <div class="sheet-form coord-stopped" data-testid="coordinator-stopped">
      <p class="coord-note">{{ tl('Its conversation stopped (its terminal ended, for example when its machine restarted).') }}</p>
      <UButton block size="xl" color="primary" icon="i-lucide-history" data-testid="coordinator-stopped-resume" @click="restartStopped('resume')">{{ tl('Resume the conversation') }}</UButton>
      <UButton block size="xl" color="neutral" variant="outline" icon="i-lucide-plus" data-testid="coordinator-stopped-new" @click="restartStopped('new')">{{ tl('New conversation') }}</UButton>
    </div>
  </AppSheet>

  <AppSheet v-model:open="sheetOpen" :title="restarting ? tl(`Restart ${coordinatorName(restarting)} with…`, `Relancer ${coordinatorName(restarting)} avec…`) : ''">
    <div class="sheet-form" data-testid="coordinator-sheet">
      <p class="coord-note">{{ tl('Its folder and memory stay; the current session stops. The agent you pick becomes its default.', 'Son dossier et sa mémoire restent ; la session en cours s’arrête. L’agent choisi devient son défaut.') }}</p>
      <label class="field-label">{{ tl('Agent', 'Agent') }}</label>
      <AgentPicker v-model="pick" :programs="choices" />
    </div>
    <template #footer>
      <div class="sheet-form">
        <UButton block size="xl" color="primary" class="hw-cta" icon="i-lucide-play" :disabled="!choices.some(p => p === pick)" data-testid="coordinator-restart" @click="restart">
          {{ tl('Restart', 'Relancer') }}
        </UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.coord-list { display: grid; }
.coord-row { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; min-height: 48px; padding: 8px 12px; border: 1px solid var(--line); border-top-width: 0; background: var(--surface); color: var(--text); text-align: left; cursor: pointer; }
.coord-row::before { content: ''; position: absolute; left: -1px; top: -1px; bottom: -1px; width: 2px; background: transparent; }
.coord-row.sel { background: var(--surface-2); }
.coord-row.sel::before { background: var(--mauve); }
.coord-row:first-of-type { border-top-width: 1px; }
.coord-row:hover:not(:disabled) { background: var(--surface-2); }
.coord-row:disabled { cursor: progress; }
.coord-row:focus-visible { outline: 1px solid var(--mauve); outline-offset: -1px; }
.coord-dot { flex: none; width: 8px; height: 8px; background: var(--dim); }
.coord-row.on .coord-dot { background: var(--green); }
.coord-text { display: grid; flex: 1; min-width: 0; }
.coord-text b { font: 600 14px/1.3 var(--display); }
.coord-name { display: flex; align-items: center; gap: var(--badge-gap); min-width: 0; }
.coord-name > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.coord-text small { overflow: hidden; color: var(--muted); font: 12px/1.4 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.coord-go { flex: none; color: var(--dim); }
.coord-rename { cursor: default; }
.coord-error { margin: 6px 0 0; }
.coord-stopped { display: grid; gap: 10px; }
.coord-stopped .coord-note { margin-bottom: 4px; }
.coord-note { margin: 0 2px 14px; color: var(--text-2); font-size: 14px; }
</style>
