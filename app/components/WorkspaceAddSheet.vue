<script setup lang="ts">
// Settings › Projects › Add workspace (docs/workspaces.md): its name, key, tab
// group, and the machines it runs on with the root folder on each (where the
// repositories are cloned), the first one checked its home. Create adds it
// (POST /api/pm/project, kind workspace), then starts its coordinator, whose
// first reply offers to build the map; a coordinator that does not start is
// said here, the workspace stays added.
import { proposeKey } from '#shared/pm/newProject'
import { workspaceInput } from '#shared/pm/workspace'
import { machineGroups } from '~/composables/useMachineBar'

const open = defineModel<boolean>('open', { default: false })
const props = defineProps<{ taken: string[] }>()
const emit = defineEmits<{ added: [key: string] }>()

const machines = computed(() => [
  { key: '', label: appConfig.value.hostLabel || t('This machine') },
  ...(appConfig.value.machines ?? []).filter(m => m.key).map(m => ({ key: m.key, label: m.label || m.key })),
])
const name = ref('')
const key = ref('')
const keyEdited = ref(false)
const group = ref('')
const on = ref<string[]>([''])
const roots = ref<Record<string, string>>({ '': '~/work' })
const busy = ref(false)
const error = ref('')
const tried = ref(false)

watch(open, (o) => { if (o) { name.value = ''; key.value = ''; keyEdited.value = false; group.value = ''; on.value = ['']; roots.value = { '': '~/work' }; error.value = ''; tried.value = false } })
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
  try { await launchCoordinator(k); open.value = false }
  catch (e) { error.value = `${tl('Workspace added; its coordinator did not start')}: ${(e as Error).message}` }
  finally { busy.value = false }
}
</script>

<template>
  <AppSheet v-model:open="open" :title="tl('Add workspace')" tall>
    <form id="add-workspace" class="sheet-form" data-testid="add-workspace" novalidate @submit.prevent="create">
      <p class="muted ws-hint">{{ tl('A workspace\'s coordinator runs the repositories cloned under its root folder, for work that spans several of them.') }}</p>
      <label class="field-label" for="add-workspace-name">{{ tl('Name') }}</label>
      <UInput id="add-workspace-name" v-model="name" size="xl" class="w-full" maxlength="60" data-testid="add-workspace-name" />
      <p v-if="shown('name')" class="form-error">{{ shown('name') }}</p>

      <label class="field-label" for="add-workspace-key">{{ tl('Key') }}</label>
      <UInput id="add-workspace-key" v-model="key" size="xl" class="w-full mono" maxlength="10" data-testid="add-workspace-key" @input="keyEdited = true" />
      <p v-if="shown('key')" class="form-error">{{ shown('key') }}</p>

      <label class="field-label">{{ tl('Tab group') }} <span class="muted">{{ tl('(optional)') }}</span></label>
      <USelect v-model="groupPick" :items="groupItems" size="xl" class="w-full" :aria-label="tl('Tab group')" data-testid="add-workspace-group" />

      <label class="field-label">{{ tl('Machines and root folders') }}</label>
      <p class="muted ws-hint">{{ tl('Where the repositories are cloned on each machine, such as ~/work. The first one is its home. Nothing is cloned for you.') }}</p>
      <div class="ws-machines">
        <div v-for="m in machines" :key="m.key" class="ws-machine" data-testid="add-workspace-machine">
          <UCheckbox :model-value="on.includes(m.key)" :label="m.label" size="xl" @update:model-value="v => toggle(m.key, v === true)" />
          <UInput v-if="on.includes(m.key)" v-model="roots[m.key]" size="lg" class="w-full mono" :aria-label="`${tl('Root folder')} · ${m.label}`" data-testid="add-workspace-root" />
        </div>
      </div>
      <p v-if="shown('machines')" class="form-error">{{ shown('machines') }}</p>
    </form>
    <template #footer>
      <div class="sheet-form">
        <p v-if="error" class="form-error" role="alert" data-testid="add-workspace-refused">{{ error }}</p>
        <UButton type="submit" form="add-workspace" block size="xl" color="primary" class="hw-cta" icon="i-lucide-plus" :loading="busy" data-testid="add-workspace-submit">{{ tl('Create') }}</UButton>
      </div>
    </template>
  </AppSheet>
</template>

<style scoped>
.ws-hint { margin: 6px 2px 10px; font-size: 13px; }
.ws-machines { display: grid; gap: 10px; }
.ws-machine { display: grid; gap: 6px; }
</style>
