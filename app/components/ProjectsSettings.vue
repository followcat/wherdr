<script setup lang="ts">
// Settings › Projects: the project management switch, then the projects (a git
// folder on a machine herdr-core reaches). A row opens the project's sheet
// (ProjectSheet), its key and tab in the URL (`?project=WHR&tab=general`).
// Add project opens the New sheet on its Project form (NewProjectForm), as the
// sidebar's New › Project does (the `projects.setup` target: the switch while projects are off); Add workspace, WorkspaceAddSheet. A row whose coordinator
// proposes a workflow change says so (reviewed on the sheet's Workflow tab).
// Off, the server refuses every change but the switch. Until the overview is
// read: skeletons (SettingsSkeleton), not an off switch and no project; a failed
// read shows its error and Try again.
// Above the list, a tab filter as the sidebar's home tabs: Follow tab (the home
// tab open now, by default), All, or one tab (projectOnBar's rule, kept on the
// device), and past 8 projects a search (name, key, path). A project opened from
// a link (`?project=KEY`) opens even when the filter hides it.
// Two sections: Workspaces (Add workspace), each workspace's row with its member
// projects under it, folded or open (open by default, kept on the device; open
// while a search runs), then Projects (Add project, Open the board), those outside
// any workspace. A member the filter or search keeps shows under its workspace,
// the workspace's row shown with it. Rows are compact (ProjectsSettingsRow).
import type { PmOverview } from '#shared/pm/project'
import { projectTab, projectsMatching, type ProjectTab } from '~/utils/projectTabs'

const props = defineProps<{ active: boolean }>()
const route = useRoute()
const router = useRouter()
const data = ref<PmOverview | null>(null)
const error = ref('')
const loadError = ref('')
const busy = ref(false)
const workspaceOpen = ref(false)

const machineName = (key: string) => key ? (appConfig.value.machines?.find(m => m.key === key)?.label || key) : (appConfig.value.hostLabel || t('This machine'))

async function load() {
  loadError.value = ''
  try { data.value = await api<PmOverview>('/api/pm/overview') }
  catch (e) { (data.value ? error : loadError).value = (e as Error).message }
}
watch(() => props.active, (on) => { if (on && !data.value) load(); if (on) loadCoordinators() }, { immediate: true })
const proposes = (key: string) => projectCoordinators.value.some(c => c.project === key && c.proposal)
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
// The New sheet on its Project form (read by NewAgentSheet when it opens).
function addProject() {
  newProjectOpen.value = true
  newAgentOpen.value = true
}
// Alfred's `ui open --target projects.setup`: Add project's form opens too, not only its button's halo.
// Projects off: the halo is on the switch instead (adding is refused while off), and the
// form opens once it is turned on.
watch(() => props.active && route.query.target === 'projects.setup' && !!data.value?.enabled, (go) => { if (go) addProject() }, { immediate: true })

// The open project and its tab, from the URL.
const opened = computed(() => (props.active ? data.value?.projects.find(p => p.key === route.query.project) : undefined))
const tab = computed(() => projectTab(route.query.tab))
const review = computed(() => route.query.review === '1')
const show = (project?: string, tab?: ProjectTab) => {
  const { project: _p, tab: _t, review: _r, ...query } = route.query
  router.replace({ query: { ...query, ...(project ? { project, tab: tab ?? 'general' } : {}) } })
}
const TAB_FOLLOW = 'follow'
const TAB_ALL = 'all'
const TAB_KEY = 'projectsSettingsTab'
const savedTab = ref<string>((() => { try { return localStorage.getItem(TAB_KEY) || TAB_FOLLOW } catch { return TAB_FOLLOW } })())
watch(savedTab, (v) => { try { localStorage.setItem(TAB_KEY, v) } catch { /* storage unavailable */ } })
// A tab's value: its bar id after `tab:` (the local machine's id is '', which a select item cannot be).
const tabValue = (id: string) => `tab:${id}`
const barTabs = computed(() => machineBarItems.value.filter(x => x.shown && x.id !== BAR_ALL).map(x => x.id))
// A tab removed since it was picked falls back to Follow tab.
const tabPick = computed({
  get: () => (savedTab.value === TAB_ALL || barTabs.value.some(id => tabValue(id) === savedTab.value) ? savedTab.value : TAB_FOLLOW),
  set: (v: string) => { savedTab.value = v },
})
const tabItems = computed(() => [{ label: tl('Follow tab'), value: TAB_FOLLOW }, { label: tl('All'), value: TAB_ALL }, ...barTabs.value.map(id => ({ label: barItemLabel(id), value: tabValue(id) }))])
const onTab = computed(() => (data.value?.projects ?? []).filter(p => tabPick.value === TAB_ALL || (tabPick.value === TAB_FOLLOW ? projectOnBar(p.key) : projectOnBarItem(p.key, tabPick.value.slice(4)))))
const query = ref('')
const searchable = computed(() => onTab.value.length > 8)
const listed = computed(() => (searchable.value ? projectsMatching(onTab.value, query.value) : onTab.value))
const showAll = () => { savedTab.value = TAB_ALL } // the search, if any, then covers every project
const searching = computed(() => searchable.value && !!query.value.trim())
// Workspaces folded by the user, kept on the device (open by default).
const FOLD_KEY = 'projectsSettingsFolded'
const folded = ref<string[]>((() => { try { const v = JSON.parse(localStorage.getItem(FOLD_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] } })())
watch(folded, (v) => { try { localStorage.setItem(FOLD_KEY, JSON.stringify(v)) } catch { /* storage unavailable */ } })
const isOpen = (key: string) => searching.value || !folded.value.includes(key)
const fold = (key: string) => { folded.value = isOpen(key) ? [...folded.value, key] : folded.value.filter(k => k !== key) }
const workspaces = computed(() => (data.value?.projects ?? []).filter(p => p.kind === 'workspace'))
const memberOf = (p: { workspace?: string }) => (p.workspace && workspaces.value.some(w => w.key === p.workspace) ? p.workspace : '')
const outside = (p: { kind?: string, workspace?: string }) => p.kind !== 'workspace' && !memberOf(p)
// A workspace shows with the members the filter and search keep; one kept only
// for a member still shows, for context.
const groups = computed(() => workspaces.value
  .map(ws => ({ ws, members: listed.value.filter(p => memberOf(p) === ws.key) }))
  .filter(g => listed.value.includes(g.ws) || g.members.length))
const plain = computed(() => listed.value.filter(outside))
const hasPlain = computed(() => (data.value?.projects ?? []).some(outside))
const noneText = (what: 'project' | 'workspace') => (searching.value ? tl(`No ${what} matches.`) : tl(`No ${what} on this tab.`))
</script>

<template>
  <div class="settings-group pm-settings" data-testid="pm-settings">
    <label class="settings-toggle">
      <span>
        <b>{{ tl('Project management', 'Gestion de projet') }}</b>
        <small>{{ tl('Tasks follow the workflow of their project. Off, nothing is changed.') }}</small>
      </span>
      <SettingsSkeleton v-if="!data" kind="switch" />
      <USwitch v-else :model-value="data.enabled" :disabled="busy" size="xl" data-testid="pm-switch" :data-ui-target="data.enabled ? undefined : 'projects.setup'" @update:model-value="v => toggle(v)" />
    </label>

    <template v-if="!data">
      <h3>{{ tl('Workspaces') }}</h3>
      <div v-if="!loadError" class="pm-actions">
        <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-boxes" disabled data-testid="pm-add-workspace">{{ tl('Add workspace') }}</UButton>
      </div>
      <h3>{{ tl('Projects') }}</h3>
      <div v-if="!loadError" class="pm-actions">
        <UButton color="primary" variant="solid" size="xl" icon="i-lucide-plus" disabled data-testid="pm-add">{{ tl('Add project') }}</UButton>
        <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-kanban" disabled data-testid="pm-board">{{ tl('Open the board') }}</UButton>
      </div>
      <SettingsSkeleton :error="loadError" @retry="load" />
    </template>
    <template v-else-if="data.enabled">
      <div v-if="data.projects.length && (barTabs.length || searchable)" class="pm-filter">
        <SettingsChoice v-if="barTabs.length" v-model="tabPick" :items="tabItems" class="pm-tab" :label="tl('Tab')" data-testid="pm-tab" />
        <NameFilter v-if="searchable" v-model="query" class="pm-search" :label="tl('Search projects')" data-testid="pm-search" />
      </div>

      <h3>{{ tl('Workspaces') }}</h3>
      <div class="pm-actions">
        <UButton color="neutral" variant="outline" size="xl" icon="i-lucide-boxes" data-testid="pm-add-workspace" @click="workspaceOpen = true">{{ tl('Add workspace') }}</UButton>
      </div>
      <div v-if="groups.length" class="settings-card pm-card">
        <div v-for="g in groups" :key="g.ws.key" class="pm-ws" data-testid="pm-ws">
          <div class="pm-ws-head">
            <button
              type="button" class="pm-ws-toggle" :class="{ none: !g.members.length }" :disabled="searching || !g.members.length" :aria-expanded="isOpen(g.ws.key)"
              :aria-label="tl(`Members of ${g.ws.name}`)" data-testid="pm-ws-toggle" @click="fold(g.ws.key)"
            >
              <UIcon name="i-lucide-chevron-down" class="pm-ws-chevron" :class="{ shut: !isOpen(g.ws.key) }" />
            </button>
            <ProjectsSettingsRow :project="g.ws" :machine="machineName(g.ws.machine)" :review="proposes(g.ws.key)" class="pm-ws-row" data-testid="pm-workspace" @click="show(g.ws.key)" />
          </div>
          <UCollapsible v-if="g.members.length" :open="isOpen(g.ws.key)" :ui="{ content: 'pm-ws-fold' }">
            <template #content>
              <div class="pm-ws-members" data-testid="pm-ws-members">
                <ProjectsSettingsRow v-for="p in g.members" :key="p.key" :project="p" :machine="machineName(p.machine)" :review="proposes(p.key)" class="pm-member" data-testid="pm-project" @click="show(p.key)" />
              </div>
            </template>
          </UCollapsible>
        </div>
      </div>
      <p v-else-if="workspaces.length" class="muted settings-hint" data-testid="pm-ws-none">{{ noneText('workspace') }}</p>
      <p v-else class="muted settings-hint" data-testid="pm-ws-empty">{{ tl('No workspace yet.') }}</p>

      <h3>{{ tl('Projects', 'Projets') }}</h3>
      <div class="pm-actions">
        <UButton color="primary" variant="solid" size="xl" icon="i-lucide-plus" data-testid="pm-add" data-ui-target="projects.setup" @click="addProject">{{ tl('Add project', 'Ajouter le projet') }}</UButton>
        <UButton v-if="data.projects.length" to="/board" color="neutral" variant="outline" size="xl" icon="i-lucide-kanban" data-testid="pm-board">{{ tl('Open the board', 'Ouvrir le tableau') }}</UButton>
      </div>
      <div v-if="plain.length" class="settings-card pm-card">
        <ProjectsSettingsRow v-for="p in plain" :key="p.key" :project="p" :machine="machineName(p.machine)" :review="proposes(p.key)" data-testid="pm-project" @click="show(p.key)" />
      </div>
      <p v-else-if="hasPlain" class="muted settings-hint" data-testid="pm-none">{{ noneText('project') }} <UButton v-if="tabPick !== TAB_ALL" variant="link" color="primary" class="pm-show-all" data-testid="pm-show-all" @click="showAll">{{ tl('Show all tabs') }}</UButton></p>
      <p v-else class="muted settings-hint" data-testid="pm-empty">{{ workspaces.length ? tl('No project outside a workspace.') : tl('No project yet.', 'Aucun projet pour l’instant.') }}</p>
      <WorkspaceAddSheet v-model:open="workspaceOpen" :taken="data.projects.flatMap(p => [p.key, ...(p.aliases ?? [])])" @added="k => { load(); show(k) }" />
      <ProjectSheet v-if="opened" :key="opened.key" :project="opened" :tab="tab" :projects="data.projects" :review="review" @tab="k => show(opened!.key, k)" @close="show()" @changed="load" />
    </template>
    <p v-if="error" class="form-error" role="alert">{{ t(error) }}</p>
  </div>
</template>

<style scoped>
.pm-settings h3 { margin-top: 24px; }
.pm-settings .settings-card { padding: 0; }
/* Rows and workspaces split by a rule; a workspace's members by a softer one, indented. */
.pm-card > * + * { border-top: 1px solid var(--line); }
.pm-ws-head { display: flex; align-items: stretch; min-width: 0; }
.pm-ws-toggle { display: grid; flex: none; width: 44px; place-items: center; color: var(--muted); }
.pm-ws-toggle.none { visibility: hidden; }
.pm-ws-toggle:active { background: var(--surface-2); }
.pm-ws-toggle:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.pm-ws-chevron { transition: transform .15s; }
.pm-ws-chevron.shut { transform: rotate(-90deg); }
.pm-ws-head > .pm-ws-row { flex: 1; padding-left: 0; }
.pm-ws-members > * { border-top: 1px solid var(--line-soft); }
.pm-ws-members > .pm-member { padding-left: 60px; }
:deep(.pm-ws-fold) { animation: none !important; }
.pm-filter { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.pm-filter > .pm-tab { flex: 1 1 320px; min-width: 0; }
.pm-filter > .pm-search { flex: 1 1 240px; height: auto; min-height: 40px; }
.pm-show-all { padding: 0; }
.pm-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
</style>
