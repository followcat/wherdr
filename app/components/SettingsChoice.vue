<script setup lang="ts" generic="V extends string">
// One choice among 2 to 4 in Settings: a segmented UToggleGroup in wherdr's
// style (main.css, `.hw-seg`), with the chosen option's description under it.
// A tap on the chosen option keeps it (a single toggle group would clear it).
// A list that can grow (tabs, programs) falls back to a select past 4 options;
// on/off stays a switch.
export interface SettingsChoiceItem<T extends string = string> { label: string, value: T, icon?: string, description?: string, disabled?: boolean }
const props = defineProps<{ items: SettingsChoiceItem<V>[], label: string, disabled?: boolean }>()
const model = defineModel<V | undefined>()
const buttons = computed(() => props.items.map(i => ({ label: i.label, value: i.value, icon: i.icon, disabled: i.disabled, 'data-value': i.value })))
const selectItems = computed(() => props.items.map(i => ({ label: i.label, value: i.value as string, disabled: i.disabled })))
const selected = computed(() => model.value as string | undefined)
const description = computed(() => props.items.find(i => i.value === model.value)?.description)
function pick(v: unknown) { if (typeof v === 'string' && v) model.value = v as V }
</script>

<template>
  <div class="hw-seg-wrap">
    <USelect
      v-if="items.length > 4" :model-value="selected" :items="selectItems" :disabled="disabled" :aria-label="label" size="lg" class="w-full"
      @update:model-value="pick"
    />
    <UToggleGroup
      v-else :model-value="model" :items="buttons" :disabled="disabled" :aria-label="label"
      class="hw-seg" :style="{ '--segment-count': items.length }" @update:model-value="pick"
    />
    <small v-if="description" class="hw-seg-desc">{{ description }}</small>
  </div>
</template>
