<script setup lang="ts">
// The workspace form (docs/workspaces.md), shared by Settings › Projects ›
// Add workspace (WorkspaceAddSheet) and the New sheet's Project › Workspace:
// its name, key, tab group, the machines it runs on with the root folder on
// each (where the repositories are cloned), the first one checked its home,
// and the agent for its coordinator. Submitting it adds it (POST
// /api/pm/project, kind workspace), then starts its coordinator, whose first
// reply offers to build the map; a coordinator that does not start is said in
// `error`, the workspace stays added. The caller's footer holds the submit
// button (form="<id>"), `busy` and `error`. Fresh state at each mount.
import type { Pane } from '#shared/types'
import { isCoordinatorProgram } from '#shared/pm/coordinator'
import { proposeKey, shortHome } from '#shared/pm/newProject'
import { workspaceInput } from '#shared/pm/workspace'
import { machineGroups } from '~/composables/useMachineBar'

const props = withDefaults(defineProps<{ taken: string[], machine?: string, id?: string }>(), { machine: '', id: 'add-workspace' })
const emit = defineEmits<{ added: [key: string], done: [pane: Pane | undefined] }>()
const busy = defineModel<boolean>('busy', { default: false })
const error = defineModel<string>('error', { default: '' })
// True while a machine's folders are browsed: the caller hides the rest.
const browsingOut = defineModel<boolean>('browsing', { default: false })

const machines = computed(() => [
  { key: '', label: appConfig.value.hostLabel || t('This machine') },
  ...(appConfig.value.machines ?? []).filter(m => m.key).map(m => ({ key: m.key, label: m.label || m.key })),
])
const name = ref('')
const key = ref('')
const keyEdited = ref(false)
const group = ref('')
// The caller's machine (the New sheet's) checked first: the home.
const on = ref<string[]>([props.machine])
const roots = ref<Record<string, string>>({ [props.machine]: '~/work' })
const tried = ref(false)
error.value = ''
// The key follows the name until the user types one.
watch(name, (n) => { if (!keyEdited.value) key.value = n.trim() ? proposeKey(n, props.taken) : '' })

const NONE = '-'
const groupItems = computed(() => [{ label: tl('None'), value: NONE }, ...machineGroups.value.map(g => ({ label: g.name, value: g.id }))])
const groupPick = computed({ get: () => group.value || NONE, set: (v: string) => { group.value = v === NONE ? '' : v } })
function toggle(m: string, checked: boolean) {
  on.value = checked ? [...on.value.filter(x => x !== m), m] : on.value.filter(x => x !== m)
  if (checked && !roots.value[m]) roots.value = { ...roots.value, [m]: '~/work' }
}
// In the list's order, the home first: the first one checked.
const picked = computed(() => machines.value.filter(m => on.value.includes(m.key)))

// The coordinator's agent, as the Project form offers it.
const choices = computed(() => offerCoordinators(undefined, 'NEW'))
const agent = ref('')
watch(choices, (c) => { if (!(c as readonly string[]).includes(agent.value)) agent.value = defaultProjectChoice(c) }, { immediate: true })

// Browse: DirBrowser on that machine, from the typed folder when it exists,
// else the machine's home; the form stays mounted (hidden) meanwhile.
const browsing = ref<{ machine: string, start: string | null } | null>(null)
watch(browsing, (b) => { browsingOut.value = !!b })
const cfgOf = (k: string) => (appConfig.value.machines ?? []).find(m => m.key === k)
const homeOf = (k: string) => (k ? cfgOf(k)?.home : appConfig.value.home) || ''
const offline = (k: string) => { const c = cfgOf(k); return !!k && (!c || !machineOnline(c)) }
async function browse(m: string) {
  const typed = roots.value[m]?.trim() || ''
  const q = (p: string) => `/api/dirs?path=${encodeURIComponent(p)}${m ? `&machine=${encodeURIComponent(m)}` : ''}`
  const start = typed ? await api(q(typed)).then(() => typed, () => null) : null
  browsing.value = { machine: m, start }
}
function chooseRoot(d: string) {
  const m = browsing.value!.machine
  roots.value = { ...roots.value, [m]: shortHome(d, homeOf(m)) }
  browsing.value = null
}

const problems = computed(() => ({
  name: !name.value.trim() ? tl('Give it a name') : '',
  key: !/^[A-Za-z][A-Za-z0-9]{1,9}$/.test(key.value) ? tl('2 to 10 letters or digits, a letter first') : props.taken.includes(key.value.toUpperCase()) ? tl('A project already has this key') : '',
  machines: !picked.value.length ? tl('Pick a machine') : picked.value.some(m => !roots.value[m.key]?.trim()) ? tl('Give the root folder on each machine') : '',
}))
const shown = (k: keyof typeof problems.value) => (tried.value ? problems.value[k] : '')

async function create() {
  tried.value = true
  if (Object.values(problems.value).some(Boolean) || busy.value) return
  busy.value = true
  error.value = ''
  const k = key.value.toUpperCase()
  try {
    await api('/api/pm/project', { ...workspaceInput({ key: k, name: name.value.trim(), group: group.value, roots: picked.value.map(m => [m.key, roots.value[m.key]!.trim()]) }), plain: true })
  }
  catch (e) { error.value = (e as Error).message; busy.value = false; return }
  emit('added', k)
  try { emit('done', await launchCoordinator(k, isCoordinatorProgram(agent.value) ? { program: agent.value } : undefined)) }
  catch (e) { error.value = `${tl('Workspace added; its coordinator did not start')}: ${(e as Error).message}` }
  finally { busy.value = false }
}
</script>

<template>
  <form v-show="!browsing" :id="id" class="sheet-form" data-testid="add-workspace" novalidate @submit.prevent="create">
    <p class="muted ws-hint">{{ tl('A workspace\'s coordinator runs the repositories cloned under its root folder, for work that spans several of them.') }}</p>
    <label class="field-label" :for="`${id}-name`">{{ tl('Name') }}</label>
    <UInput :id="`${id}-name`" v-model="name" size="xl" class="w-full" maxlength="60" data-testid="add-workspace-name" />
    <p v-if="shown('name')" class="form-error">{{ shown('name') }}</p>

    <label class="field-label" :for="`${id}-key`">{{ tl('Key') }}</label>
    <UInput :id="`${id}-key`" v-model="key" size="xl" class="w-full mono" maxlength="10" data-testid="add-workspace-key" @input="keyEdited = true" />
    <p v-if="shown('key')" class="form-error">{{ shown('key') }}</p>

    <label class="field-label">{{ tl('Tab group') }} <span class="muted">{{ tl('(optional)') }}</span></label>
    <USelect v-model="groupPick" :items="groupItems" size="xl" class="w-full" :aria-label="tl('Tab group')" data-testid="add-workspace-group" />

    <label class="field-label">{{ tl('Machines and root folders') }}</label>
    <p class="muted ws-hint">{{ tl('Where the repositories are cloned on each machine, such as ~/work. The first one is its home. Nothing is cloned for you.') }}</p>
    <div class="ws-machines">
      <div v-for="m in machines" :key="m.key" class="ws-machine" data-testid="add-workspace-machine">
        <UCheckbox :model-value="on.includes(m.key)" :label="m.label" size="xl" @update:model-value="v => toggle(m.key, v === true)" />
        <div v-if="on.includes(m.key)" class="ws-root">
          <UInput v-model="roots[m.key]" size="xl" class="w-full mono" :aria-label="`${tl('Root folder')} · ${m.label}`" data-testid="add-workspace-root" />
          <UButton
            color="neutral" variant="outline" size="xl" icon="i-lucide-folder-open" :disabled="offline(m.key)"
            :aria-label="`${tl('Browse')} · ${m.label}`" :title="offline(m.key) ? tl('This machine is offline') : tl('Browse')"
            data-testid="add-workspace-browse" @click="browse(m.key)"
          />
        </div>
      </div>
    </div>
    <p v-if="shown('machines')" class="form-error">{{ shown('machines') }}</p>

    <template v-if="choices.length">
      <label class="field-label">{{ tl('Agent') }}</label>
      <AgentPicker v-model="agent" :programs="choices" />
    </template>
  </form>
  <DirBrowser v-if="browsing" :start="browsing.start" :machine="browsing.machine" @choose="chooseRoot" @cancel="browsing = null" />
</template>

<style scoped>
.ws-hint { margin: 6px 2px 10px; font-size: 13px; }
.ws-machines { display: grid; gap: 10px; }
.ws-machine { display: grid; gap: 6px; }
.ws-root { display: flex; gap: 8px; }
.ws-root > :last-child { flex: none; width: 48px; justify-content: center; }
</style>
