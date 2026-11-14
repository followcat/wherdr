<script setup lang="ts">
// A USelect that lists projects: each project option shows its key badge in
// its color, then its name, in the list and in the closed picker. Other
// options (Follow…, All, a group) keep the plain look. Attributes go to USelect.
// The menu stays inside the screen: a long name ends with an ellipsis.
import type { ProjectOption } from '~/utils/projectOption'

defineOptions({ inheritAttrs: false })
const props = defineProps<{ items: ProjectOption[] }>()
const model = defineModel<string>()
const picked = computed(() => props.items.find(i => i.value === model.value))
</script>

<template>
  <USelect v-model="model" :items="items" :ui="{ content: 'w-max min-w-(--reka-select-trigger-width) max-w-[calc(100vw-2rem)]' }" v-bind="$attrs">
    <template v-if="picked?.badge" #default>
      <span class="project-select-value"><ProjectBadge :text="picked.badge.text" :color="picked.badge.color" /><span class="truncate">{{ picked.label }}</span></span>
    </template>
    <template #item-leading="{ item }">
      <ProjectBadge v-if="item.badge" :text="item.badge.text" :color="item.badge.color" />
    </template>
  </USelect>
</template>

<style scoped>
.project-select-value { display: flex; align-items: center; gap: 6px; min-width: 0; }
</style>
