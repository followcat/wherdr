<script setup lang="ts">
// The project sheet's "Other projects this coordinator may act on" (General
// tab, shared/pm/reach.ts): one row per other project, its key badge and name,
// then Off, Read or Act. The model: fixed project key → 'read' | 'act' (Off: absent).
import type { Project } from '#shared/pm/project'
import { shownKey } from '#shared/pm/projectKey'

defineProps<{ projects: Project[] }>()
const model = defineModel<Record<string, string>>({ required: true })
const items = [{ label: tl('Off'), value: NONE }, { label: tl('Read'), value: 'read' }, { label: tl('Act'), value: 'act' }]
const set = (key: string, v: string) => { const { [key]: _, ...rest } = model.value; model.value = v === NONE ? rest : { ...rest, [key]: v } }
</script>

<template>
  <ul class="reach-list" data-testid="pm-reach">
    <li v-for="x in projects" :key="x.key" class="reach-row">
      <span class="reach-name"><ProjectBadge :text="shownKey(x)" :color="x.color" /><span class="truncate">{{ x.name }}</span></span>
      <USelect :model-value="model[x.key] || NONE" :items="items" size="lg" class="w-28 shrink-0" :aria-label="`${tl('Level on')} ${x.name}`" :data-testid="`pm-reach-${x.key}`" @update:model-value="(v: string) => set(x.key, v)" />
    </li>
  </ul>
</template>

<style scoped>
.reach-list { display: grid; margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line-soft); }
.reach-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 0; padding: 6px 0; border-bottom: 1px solid var(--line-soft); }
.reach-name { display: flex; align-items: center; gap: 8px; min-width: 0; }
</style>
