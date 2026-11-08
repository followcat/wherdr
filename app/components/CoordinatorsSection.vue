<script setup lang="ts">
// The COORDINATORS section under Alfred (AlfredRow, which coordinates all projects) at
// the top of the agent list: the project coordinators that run. One tap opens
// its conversation; its menu (right click, or long press on a touch screen)
// restarts it with another agent, which becomes its default. Hidden while
// project management is off.
import type { CoordinatorView } from '#shared/pm/coordinator'

const busy = ref('')
const error = ref('')
const rows = computed(() => projectCoordinators.value.filter(c => coordinatorPane(c)))

async function open(c: CoordinatorView) {
  if (busy.value || rowMenu.swallowClick()) return
  busy.value = c.project
  error.value = ''
  try { await openCoordinator(c) }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = '' }
}

// Its conversation is the one open: the same selected style as agent cards.
const selected = (c: CoordinatorView) => { const id = coordinatorPane(c)?.id; return !!id && id === curPane.value }
const sub = (c: CoordinatorView) => {
  const p = coordinatorPane(c)
  const program = kindLabel((c.ran ?? coordinatorAgent(c))?.program)
  if (p) return `${program} · ${statusLabel(p)}`
  return tl(`Start with ${program}`, `Lancer avec ${program}`)
}

// Restart with…: the offered agents that can run this project's coordinator.
const rowMenu = useRowMenu()
const restarting = ref<CoordinatorView | null>(null)
const pick = ref('')
const choices = computed(() => (restarting.value ? offerCoordinators(undefined, restarting.value.project) : []))
const menu = (c: CoordinatorView) => (): MenuItem[] => [{ label: tl('Restart with…', 'Relancer avec…'), icon: 'i-lucide-refresh-cw', run: () => choose(c) }]
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
    <button
      type="button" class="coord-row" :class="{ on: !!coordinatorPane(c), sel: selected(c) }" :aria-current="selected(c) ? 'page' : undefined"
      :disabled="!!busy" data-testid="coordinator-row" v-on="rowMenu.on(menu(c), coordinatorName(c))" @click="open(c)"
    >
      <i class="coord-dot" aria-hidden="true" />
      <span class="coord-text"><b>{{ coordinatorName(c) }}</b><small>{{ busy === c.project ? tl('Starting…', 'Lancement…') : sub(c) }}</small></span>
      <UIcon :name="coordinatorPane(c) ? 'i-lucide-chevron-right' : 'i-lucide-play'" class="coord-go" />
    </button>
    </UContextMenu>
    <p v-if="error" class="error coord-error">{{ error }}</p>
  </section>

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
.coord-text small { overflow: hidden; color: var(--muted); font: 12px/1.4 var(--mono); text-overflow: ellipsis; white-space: nowrap; }
.coord-go { flex: none; color: var(--dim); }
.coord-error { margin: 6px 0 0; }
.coord-note { margin: 0 2px 14px; color: var(--text-2); font-size: 14px; }
</style>
