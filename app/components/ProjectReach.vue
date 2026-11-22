<script setup lang="ts">
// The project sheet's "Other projects this coordinator may act on" (General
// tab, shared/pm/reach.ts): only the projects it may reach, each with its key
// badge, name, Read or Act and a remove button (back to Off). Add opens a
// picker of the others (a search field past 8); a pick starts at Read.
// The model: fixed project key → 'read' | 'act' (Off: absent).
import type { Project } from '#shared/pm/project'
import { shownKey } from '#shared/pm/projectKey'

const props = defineProps<{ projects: Project[] }>()
const model = defineModel<Record<string, string>>({ required: true })
const items = [{ label: tl('Read'), value: 'read' }, { label: tl('Act'), value: 'act' }]
const set = (key: string, v?: string) => { const { [key]: _, ...rest } = model.value; model.value = v ? { ...rest, [key]: v } : rest }

const reached = computed(() => props.projects.filter(x => model.value[x.key]))
const addable = computed(() => props.projects.filter(x => !model.value[x.key]))
const open = ref(false)
const query = ref('')
const searchable = computed(() => addable.value.length > 8)
const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return q ? addable.value.filter(x => `${shownKey(x)} ${x.name}`.toLowerCase().includes(q)) : addable.value
})
watch(open, o => { if (!o) query.value = '' })
function add(key: string) { set(key, 'read'); open.value = false }
</script>

<template>
  <div class="reach" data-testid="pm-reach">
    <ul v-if="reached.length" class="reach-list">
      <li v-for="x in reached" :key="x.key" class="reach-row" data-testid="pm-reach-row">
        <span class="reach-name"><ProjectBadge :text="shownKey(x)" :color="x.color" /><span class="truncate">{{ x.name }}</span></span>
        <span class="reach-actions">
          <USelect :model-value="model[x.key]" :items="items" size="lg" class="w-24 shrink-0" :aria-label="`${tl('Level on')} ${x.name}`" :data-testid="`pm-reach-${x.key}`" @update:model-value="(v: string) => set(x.key, v)" />
          <UButton color="neutral" variant="ghost" size="lg" icon="i-lucide-trash-2" class="icon-btn" :aria-label="`${tl('Remove')} ${x.name}`" :data-testid="`pm-reach-remove-${x.key}`" @click="set(x.key)" />
        </span>
      </li>
    </ul>
    <p v-else class="reach-none muted" data-testid="pm-reach-none">{{ tl('This coordinator acts on its own project only.') }}</p>
    <UPopover v-if="addable.length" v-model:open="open" :content="{ side: 'bottom', align: 'start' }">
      <UButton color="neutral" variant="outline" size="lg" icon="i-lucide-plus" class="reach-add" data-testid="pm-reach-add">{{ tl('Add') }}</UButton>
      <template #content>
        <div class="reach-pick" data-testid="pm-reach-pick">
          <UInput v-if="searchable" v-model="query" size="lg" icon="i-lucide-search" autofocus autocomplete="off" :placeholder="tl('Search a project')" :aria-label="tl('Search a project')" :ui="{ base: 'pointer-coarse:text-[16px]' }" data-testid="pm-reach-search" />
          <ul class="reach-pick-list" role="listbox" :aria-label="tl('Project to add')">
            <li v-for="x in shown" :key="x.key">
              <button type="button" role="option" aria-selected="false" class="reach-pick-item" :data-testid="`pm-reach-pick-${x.key}`" @click="add(x.key)">
                <ProjectBadge :text="shownKey(x)" :color="x.color" /><span class="truncate">{{ x.name }}</span>
              </button>
            </li>
            <li v-if="!shown.length" class="reach-pick-empty muted">{{ tl('No project matches') }}</li>
          </ul>
        </div>
      </template>
    </UPopover>
  </div>
</template>

<style scoped>
.reach { display: grid; gap: 8px; justify-items: start; }
.reach-list { display: grid; width: 100%; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.reach-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
.reach-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
.reach-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.reach-none { margin: 0; }
.reach-pick { display: grid; gap: 6px; width: min(320px, calc(100vw - 32px)); padding: 6px; }
.reach-pick-list { display: grid; max-height: min(50vh, 360px); margin: 0; padding: 0; overflow-y: auto; list-style: none; }
.reach-pick-item { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 44px; padding: 6px 8px; border: 0; background: none; color: var(--text); text-align: left; cursor: pointer; }
.reach-pick-item:hover, .reach-pick-item:focus-visible { background: var(--line-soft); outline: none; }
.reach-pick-empty { padding: 8px; }
</style>
