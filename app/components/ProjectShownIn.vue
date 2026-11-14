<script setup lang="ts">
// The project sheet's "Shown in" (General tab): which home tab shows this
// project's coordinator and tasks to handle (utils/projectTabs.ts). Automatic
// (the groups holding one of its machines), a group, or every tab; saved at
// once in the synced projectTabs setting. A deleted group reads as Automatic.
import { allowedMachines, type Project } from '#shared/pm/project'
import { BAR_ALL } from '~/utils/machineBar'
import { projectOnTab, projectTabMachines } from '~/utils/projectTabs'

const props = defineProps<{ project: Project }>()
const AUTO = 'auto'

// Automatic leaves out machines paused for the project, unless a task of it still runs there.
const busy = computed(() => projectCoordinators.value.find(c => c.project === props.project.key)?.busy)
const autoMachines = computed(() => projectTabMachines({ machines: allowedMachines(props.project), paused: props.project.paused, busy: busy.value }, undefined, []))
const autoGroups = computed(() => machineGroups.value.filter(g => projectOnTab(autoMachines.value, g.machines)).map(g => g.name))
const items = computed(() => [
  { label: autoGroups.value.length ? tl(`Automatic (${autoGroups.value.join(', ')})`) : tl('Automatic'), value: AUTO },
  ...machineGroups.value.map(g => ({ label: g.name, value: g.id })),
  { label: tl('All tabs'), value: BAR_ALL },
])
const value = computed({
  get: () => {
    const v = projectTabs.value[props.project.key]
    return v === BAR_ALL || machineGroups.value.some(g => g.id === v) ? v! : AUTO
  },
  set: (v: string) => {
    const { [props.project.key]: _, ...rest } = projectTabs.value
    projectTabs.value = v === AUTO ? rest : { ...rest, [props.project.key]: v }
  },
})
</script>

<template>
  <span class="pm-field">
    <USelect v-model="value" :items="items" size="lg" class="justify-self-start max-w-full" :aria-label="tl('Shown in')" data-testid="pm-shown-in" />
    <small v-if="!machineGroups.length" class="muted" data-testid="pm-shown-in-hint">
      {{ tl('No machine group yet, so the project shows under All and on its machines\' tabs. Groups:') }}
      <NuxtLink to="/settings?section=appearance">{{ tl('Settings › Appearance › Machine tabs') }}</NuxtLink>.
    </small>
    <small v-else class="muted">{{ tl('The home tab that shows its coordinator and its tasks to handle. Automatic: each group holding one of its active machines.') }}</small>
  </span>
</template>

<style scoped>
.pm-field { display: grid; gap: 4px; }
</style>
