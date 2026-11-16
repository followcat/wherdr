<script setup lang="ts">
// A USelect that lists projects: each project option shows its key badge in
// its color, then its name, in the list and in the closed picker. Other
// options (Follow…, All, a group) keep the plain look. An option's count (what
// waits under it) shows in a muted grey-bordered chip right after its name, none
// at 0. Attributes go to USelect.
// The menu stays inside the screen: a long name ends with an ellipsis.
import type { ProjectOption } from '~/utils/projectOption'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ items: ProjectOption[] }>()
const model = defineModel<string>()
const picked = computed(() => props.items.find(i => i.value === model.value))
</script>

<template>
  <USelect v-model="model" :items="items" :ui="{ content: 'w-max min-w-(--reka-select-trigger-width) max-w-[calc(100vw-2rem)]', itemLabel: 'flex items-center gap-1.5 min-w-0' }" v-bind="$attrs">
    <template v-if="picked?.badge || picked?.count" #default>
      <span class="project-select-value"><ProjectBadge v-if="picked.badge" :text="picked.badge.text" :color="picked.badge.color" /><span class="truncate">{{ picked.label }}</span><span v-if="picked.count" class="project-select-count" data-testid="option-count">{{ picked.count }}</span></span>
    </template>
    <template #item-leading="{ item }">
      <ProjectBadge v-if="item.badge" :text="item.badge.text" :color="item.badge.color" />
    </template>
    <template #item-label="{ item }">
      <span class="truncate" data-testid="option-label">{{ item.label }}</span><span v-if="item.count" class="project-select-count" data-testid="option-count">{{ item.count }}</span>
    </template>
  </USelect>
</template>

<style scoped>
.project-select-value { display: flex; align-items: center; gap: 6px; min-width: 0; }
/* As a plain key badge: a square chip with a grey border, muted. */
.project-select-count { flex: none; padding: 0 5px; border: 1px solid var(--line-strong); color: var(--muted); font: 600 11px/1.6 var(--mono); font-variant-numeric: tabular-nums; }
</style>
