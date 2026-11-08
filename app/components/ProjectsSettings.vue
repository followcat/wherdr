<script setup lang="ts">
// Settings › Projects: the project management switch, then the projects (a git
// folder on a machine herdr-core reaches). A row opens the project's sheet
// (ProjectSheet), its key and tab in the URL (`?project=WHR&tab=general`).
// Add project opens the New sheet on a new project.
// Off, the server refuses every change but the switch.
import type { PmOverview } from '#shared/pm/project'
import { shownKey } from '#shared/pm/projectKey'
import { projectTab, type ProjectTab } from '~/utils/projectTabs'

const props = defineProps<{ active: boolean }>()
const route = useRoute()
const router = useRouter()
const data = ref<PmOverview | null>(null)
const error = ref('')
const busy = ref(false)

const machineName = (key: string) => key ? (appConfig.value.machines?.find(m => m.key === key)?.label || key) : (appConfig.value.hostLabel || t('This machine'))

async function load() {
  try { data.value = await api<PmOverview>('/api/pm/overview') }
  catch (e) { error.value = (e as Error).message }
}
watch(() => props.active, (on) => { if (on && !data.value) load() }, { immediate: true })
// A project added from the New sheet: the list again.
watch(newAgentOpen, (o) => { if (!o && props.active && data.value) load() })

async function toggle(on: boolean) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { data.value = await api<PmOverview>('/api/pm/enabled', { enabled: on }) }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
function addProject() {
  newProjectOpen.value = true
  newAgentOpen.value = true
}

// The open project and its tab, from the URL.
const opened = computed(() => (props.active ? data.value?.projects.find(p => p.key === route.query.project) : undefined))
const tab = computed(() => projectTab(route.query.tab))
const show = (project?: string, tab?: ProjectTab) => {
  const { project: _p, tab: _t, ...query } = route.query
  router.replace({ query: { ...query, ...(project ? { project, tab: tab ?? 'general' } : {}) } })
}
</script>

<template>
  <div class="settings-group pm-settings" data-testid="pm-settings">
    <label class="settings-toggle">
      <span>
        <b>{{ tl('Project management', 'Gestion de projet') }}</b>
        <small>{{ tl('Tasks follow the workflow of their project. Off, nothing is changed.') }}</small>
      </span>
      <USwitch :model-value="data?.enabled ?? false" :disabled="!data || busy" color="success" size="xl" data-testid="pm-switch" @update:model-value="v => toggle(v)" />
    </label>
    <UButton to="/board?guide=1" color="neutral" variant="ghost" size="lg" icon="i-lucide-list-checks" class="pm-guide-link" data-testid="pm-guide-link">{{ tl('Getting started', 'Pour commencer') }}</UButton>

    <template v-if="data?.enabled">
      <h3>{{ tl('Projects', 'Projets') }}</h3>
      <div v-if="data.projects.length" class="settings-card">
        <button v-for="p in data.projects" :key="p.key" type="button" class="pm-row" data-testid="pm-project" @click="show(p.key)">
          <span class="pm-id"><b>{{ p.name }}<span v-if="p.visibility?.value === 'public'" class="pm-public" data-testid="pm-public">{{ tl('Public', 'Public') }}</span></b><small class="mono-label">{{ shownKey(p) }} · {{ machineName(p.machine) }}</small><small class="pm-path">{{ ltr(shortPath(p.path)) }}</small></span>
          <UIcon name="i-lucide-chevron-right" class="pm-chevron" />
        </button>
      </div>
      <p v-else class="muted settings-hint" data-testid="pm-empty">{{ tl('No project yet.', 'Aucun projet pour l’instant.') }}</p>
      <div class="pm-actions">
        <UButton color="primary" variant="solid" size="xl" icon="i-lucide-plus" data-testid="pm-add" @click="addProject">{{ tl('Add project', 'Ajouter le projet') }}</UButton>
        <UButton v-if="data.projects.length" to="/board" color="neutral" variant="outline" size="xl" icon="i-lucide-kanban" data-testid="pm-board">{{ tl('Open the board', 'Ouvrir le tableau') }}</UButton>
      </div>
      <ProjectSheet v-if="opened" :key="opened.key" :project="opened" :tab="tab" :templates="data.templates" @tab="k => show(opened!.key, k)" @close="show()" @changed="load" />
    </template>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
  </div>
</template>

<style scoped>
.pm-settings h3 { margin-top: 24px; }
.pm-guide-link { margin-top: 8px; }
.pm-settings .settings-card { padding: 0; }
.pm-row { display: flex; width: 100%; align-items: center; gap: 12px; padding: 13px 16px; border-bottom: 1px solid var(--line); text-align: left; }
.pm-row:last-child { border-bottom: 0; }
.pm-row:active { background: var(--surface-2); }
.pm-id { display: grid; flex: 1; gap: 2px; min-width: 0; overflow-wrap: anywhere; }
.pm-path { color: var(--muted); font-family: var(--font-mono, 'JetBrains Mono', monospace); font-size: 12px; }
.pm-chevron { flex: none; color: var(--muted); }
.pm-public { margin-left: 8px; padding: 2px 6px; border: 1px solid var(--blocked); color: var(--blocked); font: 600 11px/1 var(--font-mono, 'JetBrains Mono', monospace); letter-spacing: .08em; text-transform: uppercase; vertical-align: 2px; }
.pm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
</style>
