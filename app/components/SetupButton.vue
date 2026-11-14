<script setup lang="ts">
// The board header's "Finish setup (2/3)" while no project went through every
// setup step (setupComplete); nothing once one did. It opens SetupWizard.
import type { PmOverview } from '#shared/pm/project'
import { SETUP_STEPS, setupComplete, setupCount, setupDone, setupProject } from '#shared/pm/setup'

const data = ref<PmOverview | null>(null)
const open = ref(false)
const load = () => Promise.all([api<PmOverview>('/api/pm/overview'), loadCoordinators()]).then(([o]) => { data.value = o }, () => {})
onMounted(load)
const shown = computed(() => !!data.value && !setupComplete(data.value, coordinators.value))
const count = computed(() => setupCount(setupDone(data.value, setupProject(data.value, coordinators.value), coordinators.value)))
</script>

<template>
  <UButton v-if="shown" color="primary" variant="solid" size="lg" class="setup-btn" data-testid="setup-button" @click="open = true">
    <UIcon name="i-lucide-list-checks" class="setup-icon" aria-hidden="true" />
    <span class="setup-long">{{ tl(`Finish setup (${count}/${SETUP_STEPS.length})`) }}</span>
    <span class="setup-short" aria-hidden="true">{{ count }}/{{ SETUP_STEPS.length }}</span>
  </UButton>
  <SetupWizard v-model:open="open" @changed="load" />
</template>

<style scoped>
/* Phone: the icon and 2/3 only (the full label for screen readers), so the header keeps its other controls. */
.setup-btn { flex: none; white-space: nowrap; }
.setup-icon { width: 20px; height: 20px; }
.setup-short { display: none; }
@media (max-width: 899px) {
  .setup-long { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .setup-short { display: inline; }
}
</style>
